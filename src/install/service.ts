import { chmod, lstat, mkdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { InstallResult } from './dsh.ts'
import { atomicWrite, backupName, createBackup, isNotFound, readOptional, restoreBackup } from './files.ts'

const execFileAsync = promisify(execFile)
const SERVICE_ENV_MARKER = '# Managed by personal-feed service installer v1'
const SERVICE_UNIT_MARKER = '# Managed by personal-feed service installer v1'
const STATE_MARKER = '.personal-feed-service-owned-v1'
const STATE_MARKER_CONTENT = 'owned by personal-feed service installer v1\n'

export interface CommandResult { readonly stdout: string }
export type CommandRunner = (command: string, args: readonly string[]) => Promise<CommandResult>

export interface ServiceInstallOptions {
  readonly mode: 'check' | 'apply'
  readonly repoRoot: string
  readonly configHome: string
  readonly stateHome: string
  readonly mcpToken: string
  readonly model: {
    readonly baseURL: string
    readonly model: string
    readonly apiKey: string
    readonly timeoutMs: number
  }
  readonly gitCommit?: () => Promise<string>
  readonly gitStatus?: () => Promise<string>
  readonly serviceUnitTemplate?: string
  readonly run?: CommandRunner
  readonly now?: () => Date
}

/** Build an exact clean commit and install one user-level systemd service. */
export async function installUserService(options: ServiceInstallOptions): Promise<InstallResult> {
  validateSecrets(options)
  const run = options.run ?? defaultRun
  const commit = (await (options.gitCommit ?? (() => gitCommit(options.repoRoot)))()).trim()
  const status = await (options.gitStatus ?? (() => gitStatus(options.repoRoot)))()
  if (!/^[0-9a-f]{7,64}$/i.test(commit)) throw new Error('Cannot resolve an exact Git commit')
  const checkoutIsDirty = status.trim() !== ''

  const configDir = join(options.configHome, 'personal-feed')
  const envPath = join(configDir, 'service.env')
  const unitPath = join(options.configHome, 'systemd', 'user', 'personal-feed.service')
  const stateDir = join(options.stateHome, 'personal-feed')
  const [envMode] = await Promise.all([
    assertMissingOrOwnedFile(envPath, SERVICE_ENV_MARKER, 'service environment'),
    assertMissingOrOwnedFile(unitPath, SERVICE_UNIT_MARKER, 'systemd unit'),
  ])
  const envModeNeedsRepair = envMode !== undefined && envMode !== 0o600
  const stateOwnership = await inspectStateDirectory(stateDir)
  const actions = [
    `build Personal Feed from exact clean Git commit ${commit}`,
    `install private service configuration at ${envPath}`,
    `install user systemd unit at ${unitPath}`,
    `create independent state directory ${stateDir}`,
    'enable and start personal-feed.service only in apply mode',
  ]
  if (envModeNeedsRepair) actions.push(`restore ${envPath} to mode 0600`)
  if (checkoutIsDirty) actions.push('apply requires a clean Git checkout; the current checkout is dirty')
  if (options.mode === 'check') return { changed: false, actions }
  if (checkoutIsDirty) throw new Error('service install --apply requires a clean Git checkout')

  const flakeRef = `git+file://${resolve(options.repoRoot)}?rev=${commit}#personal-feed`
  const built = (await run('nix', ['build', flakeRef, '--no-link', '--print-out-paths'])).stdout.trim().split(/\s+/).at(-1)
  if (built === undefined || !built.startsWith('/nix/store/')) throw new Error('Nix did not return an immutable store path')
  const envAfter = serviceEnvironment(options, stateDir, built)
  const unitTemplate = options.serviceUnitTemplate
    ?? await readFile(join(options.repoRoot, 'systemd', 'personal-feed.service.in'), 'utf8')
  const unitAfter = serviceUnit(unitTemplate, envPath, built, stateDir)
  const [envBefore, unitBefore] = await Promise.all([readOptional(envPath), readOptional(unitPath)])
  const changed = envBefore !== envAfter || unitBefore !== unitAfter || stateOwnership === 'missing' || envModeNeedsRepair
  if (!changed) return { changed: false, actions }

  await mkdir(configDir, { recursive: true, mode: 0o700 })
  await chmod(configDir, 0o700)
  const backupRoot = join(configDir, 'backups')
  await mkdir(backupRoot, { recursive: true, mode: 0o700 })
  const backupDir = await createBackup(backupRoot, backupName('service', (options.now ?? (() => new Date()))()), [
    envPath,
    unitPath,
  ])
  await mkdir(stateDir, { recursive: true, mode: 0o700 })
  await chmod(stateDir, 0o700)
  if (stateOwnership === 'missing') {
    await atomicWrite(join(stateDir, STATE_MARKER), STATE_MARKER_CONTENT, 0o600)
  }
  await atomicWrite(envPath, envAfter, 0o600)
  await atomicWrite(unitPath, unitAfter, 0o644)
  await run('systemctl', ['--user', 'daemon-reload'])
  await run('systemctl', ['--user', 'enable', '--now', 'personal-feed.service'])
  return {
    changed: true,
    actions,
    backupDir,
    rollbackCommand: `personal-feed service rollback --apply '${backupDir.replaceAll("'", "'\\''")}'`,
  }
}

export async function rollbackUserService(options: {
  readonly configHome: string
  readonly backupDir: string
  readonly run?: CommandRunner
}): Promise<void> {
  const run = options.run ?? defaultRun
  await run('systemctl', ['--user', 'disable', '--now', 'personal-feed.service'])
  await restoreBackup(options.backupDir, [resolve(options.configHome)])
  await run('systemctl', ['--user', 'daemon-reload'])
}

function serviceEnvironment(options: ServiceInstallOptions, stateDir: string, storePath: string): string {
  return [
    SERVICE_ENV_MARKER,
    '# Do not commit this file.',
    `PERSONAL_FEED_HOST=${environmentValue('127.0.0.1')}`,
    `PERSONAL_FEED_PORT=${environmentValue('43180')}`,
    `PERSONAL_FEED_STATE_DIR=${environmentValue(stateDir)}`,
    `PERSONAL_FEED_OBSERVER_CLI=${environmentValue(`${storePath}/lib/personal-feed/python/x_personal_feed_observer_cli.py`)}`,
    `PERSONAL_FEED_MCP_TOKEN=${environmentValue(options.mcpToken)}`,
    `PERSONAL_FEED_MODEL_BASE_URL=${environmentValue(options.model.baseURL)}`,
    `PERSONAL_FEED_MODEL=${environmentValue(options.model.model)}`,
    `PERSONAL_FEED_MODEL_API_KEY=${environmentValue(options.model.apiKey)}`,
    `PERSONAL_FEED_MODEL_TIMEOUT_MS=${environmentValue(String(options.model.timeoutMs))}`,
    '',
  ].join('\n')
}

function serviceUnit(template: string, envPath: string, storePath: string, stateDir: string): string {
  const values = {
    '@CONFIG_ENV@': unitValue(envPath),
    '@STORE_PATH@': storePath,
    '@STATE_DIR@': unitValue(stateDir),
  } as const
  for (const placeholder of Object.keys(values)) {
    if (!template.includes(placeholder)) throw new Error(`systemd template is missing ${placeholder}`)
  }
  const rendered = Object.entries(values).reduce(
    (current, [placeholder, value]) => current.replaceAll(placeholder, value),
    template,
  )
  if (/@[A-Z_]+@/u.test(rendered)) throw new Error('systemd template contains an unknown placeholder')
  return `${SERVICE_UNIT_MARKER}\n${rendered}`
}

async function assertMissingOrOwnedFile(path: string, marker: string, label: string): Promise<number | undefined> {
  let metadata
  try {
    metadata = await lstat(path)
  } catch (error) {
    if (isNotFound(error)) return undefined
    throw error
  }
  if (metadata.isSymbolicLink()) throw new Error(`${label} is a symbolic link and is not owned by this installer`)
  if (!metadata.isFile()) throw new Error(`${label} is not a regular file owned by this installer`)
  if (!(await readFile(path, 'utf8')).startsWith(`${marker}\n`)) {
    throw new Error(`${label} is not owned by this installer`)
  }
  return metadata.mode & 0o777
}

async function inspectStateDirectory(path: string): Promise<'missing' | 'owned'> {
  let metadata
  try {
    metadata = await lstat(path)
  } catch (error) {
    if (isNotFound(error)) return 'missing'
    throw error
  }
  if (metadata.isSymbolicLink()) throw new Error('Personal Feed state directory is a symbolic link and is not owned by this installer')
  if (!metadata.isDirectory()) throw new Error('Personal Feed state directory is not an owned directory')
  const marker = join(path, STATE_MARKER)
  let markerMetadata
  try {
    markerMetadata = await lstat(marker)
  } catch (error) {
    if (isNotFound(error)) throw new Error('Personal Feed state directory is not owned by this installer')
    throw error
  }
  if (!markerMetadata.isFile() || markerMetadata.isSymbolicLink()
    || await readFile(marker, 'utf8') !== STATE_MARKER_CONTENT) {
    throw new Error('Personal Feed state directory is not owned by this installer')
  }
  return 'owned'
}

function validateSecrets(options: ServiceInstallOptions): void {
  if (!/^[A-Za-z0-9._~-]{16,512}$/.test(options.mcpToken)) throw new Error('MCP token must be 16-512 URL-safe characters')
  for (const [name, value] of Object.entries({
    modelBaseURL: options.model.baseURL,
    model: options.model.model,
    modelApiKey: options.model.apiKey,
  })) {
    if (value === '' || /[\r\n]/.test(value)) throw new Error(`${name} must be a non-empty single-line value`)
  }
  if (!Number.isInteger(options.model.timeoutMs) || options.model.timeoutMs < 1) throw new Error('model timeout must be positive')
  let baseURL: URL
  try { baseURL = new URL(options.model.baseURL) } catch { throw new Error('modelBaseURL must be an absolute HTTP URL') }
  if (!['http:', 'https:'].includes(baseURL.protocol) || baseURL.username !== '' || baseURL.password !== '') {
    throw new Error('modelBaseURL must be an absolute HTTP URL without embedded credentials')
  }
}

function environmentValue(value: string): string {
  if (/[\0\r\n]/.test(value)) throw new Error('systemd environment values must be single-line')
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

function unitValue(value: string): string {
  if (/[\0\r\n]/.test(value)) throw new Error('systemd unit values must be single-line')
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

async function gitCommit(repoRoot: string): Promise<string> {
  return (await defaultRun('git', ['-C', repoRoot, 'rev-parse', 'HEAD'])).stdout
}

async function gitStatus(repoRoot: string): Promise<string> {
  return (await defaultRun('git', ['-C', repoRoot, 'status', '--porcelain'])).stdout
}

async function defaultRun(command: string, args: readonly string[]): Promise<CommandResult> {
  const result = await execFileAsync(command, [...args], { encoding: 'utf8' })
  return { stdout: result.stdout }
}
