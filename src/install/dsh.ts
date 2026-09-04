import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, readlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import {
  atomicInstallDirectory,
  atomicWrite,
  backupName,
  createBackup,
  isNotFound,
  pathExists,
  readOptional,
  restoreBackup,
} from './files.ts'
import { PERSONAL_FEED_TOOL_NAMES } from '../service/mcp.ts'

const PATCH_BEGIN = '# BEGIN personal-feed installer managed block v1'
const PATCH_END = '# END personal-feed installer managed block v1'
const ENV_BEGIN = '# BEGIN personal-feed installer managed environment v1'
const ENV_END = '# END personal-feed installer managed environment v1'
const SKILL_MARKER = '.personal-feed-installer-owned'
const LEGACY_SKILL_TARGET = '/opt/dsh/plugins-src/skills/personal-feed'

export interface InstallResult {
  readonly changed: boolean
  readonly actions: readonly string[]
  readonly backupDir?: string
  readonly rollbackCommand?: string
}

export interface DshInstallOptions {
  readonly mode: 'check' | 'apply'
  readonly dshHome: string
  readonly serviceUrl: string
  readonly mcpToken: string
  readonly skillSourceDir: string
  readonly probe?: (serviceUrl: string, token: string) => Promise<{ readonly tools: readonly string[] }>
  readonly now?: () => Date
}

/** Install the machine-local Skill and generic MCP row without restarting DSH. */
export async function installDshIntegration(options: DshInstallOptions): Promise<InstallResult> {
  validateToken(options.mcpToken)
  const serviceUrl = validateLoopbackOrigin(options.serviceUrl)
  await (options.probe ?? probePersonalFeed)(serviceUrl, options.mcpToken).then(assertExactTools)

  const patchPath = join(options.dshHome, 'cordis.patch.yml')
  const envPath = join(options.dshHome, '.env')
  const skillTarget = join(options.dshHome, 'skills', 'personal-feed')
  const [, envMode] = await Promise.all([
    assertRegularOrMissing(patchPath, 'DSH patch'),
    assertRegularOrMissing(envPath, 'DSH environment'),
  ])
  const envModeNeedsRepair = envMode !== undefined && envMode !== 0o600
  const patchBefore = await readOptional(patchPath)
  const envBefore = await readOptional(envPath)
  const patchAfter = replaceManagedBlock(
    patchBefore,
    PATCH_BEGIN,
    PATCH_END,
    managedPatchBlock(),
    /(?:\bid:\s*personal-feed-mcp\b|\bserverName:\s*personal_feed\b)/,
  )
  const envAfter = replaceManagedBlock(envBefore, ENV_BEGIN, ENV_END, managedEnvBlock(serviceUrl, options.mcpToken), /\bPERSONAL_FEED_MCP_(?:URL|TOKEN)\s*=/)
  const skillState = await inspectSkill(skillTarget, options.skillSourceDir)
  if (skillState === 'conflict') throw new Error('Refusing to overwrite a user-owned Personal Feed Skill')
  const changed = patchBefore !== patchAfter || envBefore !== envAfter || skillState !== 'current' || envModeNeedsRepair
  const actions = [
    `verify /readyz and MCP tools/list at ${serviceUrl}`,
    `install Skill at ${skillTarget}`,
    `write owned generic MCP row to ${patchPath}`,
    `write URL and MCP token to ${envPath} with mode 0600`,
    'do not restart or switch DSH; follow the reported next step separately',
  ]
  if (envModeNeedsRepair) actions.push(`restore ${envPath} to mode 0600`)
  if (options.mode === 'check' || !changed) return { changed: false, actions }

  const backupRoot = join(options.dshHome, '.personal-feed-install-backups')
  await mkdir(backupRoot, { recursive: true, mode: 0o700 })
  const backupDir = await createBackup(backupRoot, backupName('dsh', (options.now ?? (() => new Date()))()), [
    patchPath,
    envPath,
    skillTarget,
  ])
  await atomicWrite(patchPath, patchAfter, 0o600)
  await atomicWrite(envPath, envAfter, 0o600)
  if (skillState !== 'current') {
    await atomicInstallDirectory(options.skillSourceDir, skillTarget, SKILL_MARKER)
  }
  return {
    changed: true,
    actions,
    backupDir,
    rollbackCommand: `personal-feed dsh rollback --apply ${shellDisplay(backupDir)}`,
  }
}

export async function rollbackDshIntegration(options: { readonly dshHome: string; readonly backupDir: string }): Promise<void> {
  await restoreBackup(options.backupDir, [resolve(options.dshHome)])
}

export async function probePersonalFeed(serviceUrl: string, token: string): Promise<{ tools: string[] }> {
  const ready = await fetch(`${serviceUrl.replace(/\/+$/, '')}/readyz`, { signal: AbortSignal.timeout(5_000) })
  if (!ready.ok) throw new Error(`Personal Feed readiness failed with HTTP ${ready.status}`)
  let readiness: unknown
  try {
    readiness = await ready.json()
  } catch {
    throw new Error('Personal Feed is not ready: invalid readiness response')
  }
  if (!isReadyResponse(readiness)) throw new Error('Personal Feed is not ready')
  const client = new Client({ name: 'personal-feed-installer', version: '0.1.0' })
  try {
    const transport = new StreamableHTTPClientTransport(new URL(`${serviceUrl.replace(/\/+$/, '')}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    })
    // SDK 1.x declares optional sessionId differently under exactOptionalPropertyTypes.
    await client.connect(transport as Transport)
    return { tools: (await client.listTools()).tools.map(tool => tool.name) }
  } finally {
    await client.close()
  }
}

function assertExactTools(result: { readonly tools: readonly string[] }): void {
  const actual = [...result.tools].sort()
  const expected = [...PERSONAL_FEED_TOOL_NAMES].sort()
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Personal Feed MCP must expose exactly five known tools; received ${actual.join(', ')}`)
  }
}

function managedPatchBlock(): string {
  return `${PATCH_BEGIN}\n- insert:\n    - id: personal-feed-mcp\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: personal_feed\n        transport: streamable-http\n        url: !!js process.env.PERSONAL_FEED_MCP_URL\n        headers:\n          Authorization: !!js \"'Bearer ' + process.env.PERSONAL_FEED_MCP_TOKEN\"\n        toolCallTimeoutMs: 120000\n        failOnStartupError: false\n${PATCH_END}`
}

function managedEnvBlock(serviceUrl: string, token: string): string {
  return `${ENV_BEGIN}\nPERSONAL_FEED_MCP_URL="${serviceUrl}/mcp"\nPERSONAL_FEED_MCP_TOKEN="${token}"\n${ENV_END}`
}

function replaceManagedBlock(source: string, begin: string, end: string, block: string, conflict: RegExp): string {
  const start = source.indexOf(begin)
  const finish = source.indexOf(end)
  if ((start === -1) !== (finish === -1) || (finish !== -1 && finish < start)) throw new Error('Malformed Personal Feed installer-owned block')
  if (start === -1) {
    if (conflict.test(source)) throw new Error('Personal Feed configuration exists but is not owned by this installer')
    const prefix = source === '' ? '' : source.endsWith('\n') ? source : `${source}\n`
    return `${prefix}${block}\n`
  }
  const afterEnd = finish + end.length
  const outside = `${source.slice(0, start)}${source.slice(afterEnd)}`
  if (conflict.test(outside)) throw new Error('Personal Feed configuration exists outside the installer-owned block')
  return `${source.slice(0, start)}${block}${source.slice(afterEnd)}`
}

async function inspectSkill(target: string, source: string): Promise<'missing' | 'legacy' | 'current' | 'conflict'> {
  try {
    const metadata = await lstat(target)
    if (metadata.isSymbolicLink()) return await readlink(target) === LEGACY_SKILL_TARGET ? 'legacy' : 'conflict'
    if (!metadata.isDirectory() || !(await pathExists(join(target, SKILL_MARKER)))) return 'conflict'
    const [installed, expected] = await Promise.all([
      skillTreeDigest(target, new Set([SKILL_MARKER])),
      skillTreeDigest(source, new Set()),
    ])
    return installed === expected ? 'current' : 'legacy'
  } catch (error) {
    if (isNotFound(error)) return 'missing'
    throw error
  }
}

async function assertRegularOrMissing(path: string, label: string): Promise<number | undefined> {
  try {
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink()) throw new Error(`${label} is a symbolic link and cannot be updated safely`)
    if (!metadata.isFile()) throw new Error(`${label} is not a regular file and cannot be updated safely`)
    return metadata.mode & 0o777
  } catch (error) {
    if (isNotFound(error)) return undefined
    throw error
  }
}

async function skillTreeDigest(root: string, ignoredRootEntries: ReadonlySet<string>): Promise<string> {
  const digest = createHash('sha256')
  const visit = async (directory: string, prefix: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      if (prefix === '' && ignoredRootEntries.has(entry.name)) continue
      const relativePath = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        digest.update(`directory\0${relativePath}\0`)
        await visit(path, relativePath)
      } else if (entry.isFile()) {
        digest.update(`file\0${relativePath}\0`)
        digest.update(await readFile(path))
        digest.update('\0')
      } else if (entry.isSymbolicLink()) {
        digest.update(`symlink\0${relativePath}\0${await readlink(path)}\0`)
      } else {
        throw new Error(`unsupported Skill entry: ${relativePath}`)
      }
    }
  }
  await visit(root, '')
  return digest.digest('hex')
}

function validateToken(token: string): void {
  if (!/^[A-Za-z0-9._~-]{16,512}$/.test(token)) throw new Error('MCP token must be 16-512 URL-safe characters')
}

function validateLoopbackOrigin(input: string): string {
  if (/[\r\n]/.test(input)) throw new Error('Personal Feed service URL must be a loopback HTTP origin')
  let parsed: URL
  try {
    parsed = new URL(input)
  } catch {
    throw new Error('Personal Feed service URL must be a loopback HTTP origin')
  }
  if (
    parsed.protocol !== 'http:'
    || parsed.hostname !== '127.0.0.1'
    || parsed.username !== ''
    || parsed.password !== ''
    || parsed.pathname !== '/'
    || parsed.search !== ''
    || parsed.hash !== ''
    || parsed.origin !== input.replace(/\/$/, '')
  ) {
    throw new Error('Personal Feed service URL must be a loopback HTTP origin')
  }
  return parsed.origin
}

function isReadyResponse(input: unknown): input is { readonly status: 'ready' } {
  return typeof input === 'object' && input !== null && (input as { status?: unknown }).status === 'ready'
}

function shellDisplay(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}
