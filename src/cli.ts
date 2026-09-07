#!/usr/bin/env node
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { installUserService, rollbackUserService, type ServiceInstallOptions, type InstallResult } from './install/service.ts'

export interface CliDependencies {
  readonly environment: NodeJS.ProcessEnv
  readonly cwd: () => string
  readonly installService: (options: ServiceInstallOptions) => Promise<InstallResult>
  readonly rollbackService: typeof rollbackUserService
  readonly serve: () => Promise<void>
  readonly write: (line: string) => void
}

/** Parse and execute one explicit Personal Feed operator command. */
export async function runPersonalFeedCli(
  args: readonly string[],
  dependencies: CliDependencies = defaultDependencies(),
): Promise<number> {
  const [scope, action, ...flags] = args
  if (scope === 'serve' && action === undefined) {
    await dependencies.serve()
    return 0
  }
  if (scope === 'service' && action === 'install') {
    const mode = installMode(flags)
    const result = await dependencies.installService(serviceOptions(dependencies, mode))
    report(result, dependencies.write)
    return 0
  }
  if (scope === 'service' && action === 'rollback') {
    if (flags.length !== 2 || flags[0] !== '--apply' || flags[1] === undefined) {
      throw new Error('rollback requires --apply followed by the exact backup directory')
    }
    const homes = resolveHomes(dependencies.environment)
    await dependencies.rollbackService({ configHome: homes.configHome, backupDir: flags[1] })
    dependencies.write('Rollback completed.')
    return 0
  }
  throw new Error('usage: personal-feed serve | service install --check|--apply | service rollback --apply BACKUP_DIR')
}

function installMode(flags: readonly string[]): 'check' | 'apply' {
  const check = flags.includes('--check')
  const apply = flags.includes('--apply')
  if (flags.length !== 1 || check === apply) throw new Error('install requires exactly one of --check or --apply')
  return apply ? 'apply' : 'check'
}

function serviceOptions(dependencies: CliDependencies, mode: 'check' | 'apply'): ServiceInstallOptions {
  const env = dependencies.environment
  const homes = resolveHomes(env)
  const responseFormat = env.PERSONAL_FEED_MODEL_RESPONSE_FORMAT?.trim()
  if (responseFormat !== undefined && responseFormat !== 'json_content' && responseFormat !== 'strict_tool') {
    throw new Error('PERSONAL_FEED_MODEL_RESPONSE_FORMAT must be json_content or strict_tool')
  }
  return {
    mode,
    repoRoot: dependencies.cwd(),
    configHome: homes.configHome,
    stateHome: homes.stateHome,
    mcpToken: required(env, 'PERSONAL_FEED_MCP_TOKEN'),
    model: {
      baseURL: required(env, 'PERSONAL_FEED_MODEL_BASE_URL'),
      model: required(env, 'PERSONAL_FEED_MODEL'),
      apiKey: required(env, 'PERSONAL_FEED_MODEL_API_KEY'),
      timeoutMs: positiveInteger(env.PERSONAL_FEED_MODEL_TIMEOUT_MS ?? '30000', 'PERSONAL_FEED_MODEL_TIMEOUT_MS'),
      ...(responseFormat === undefined ? {} : { responseFormat }),
    },
  }
}

function resolveHomes(env: NodeJS.ProcessEnv): { configHome: string; stateHome: string } {
  const home = env.HOME ?? homedir()
  return {
    configHome: env.XDG_CONFIG_HOME ?? join(home, '.config'),
    stateHome: env.XDG_STATE_HOME ?? join(home, '.local', 'state'),
  }
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim()
  if (value === undefined || value === '') throw new Error(`${name} is required`)
  return value
}

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`)
  return parsed
}

function report(result: InstallResult, write: (line: string) => void): void {
  write(result.changed ? 'Changes applied.' : 'No changes applied.')
  for (const action of result.actions) write(`- ${action}`)
  if (result.backupDir !== undefined) write(`Backup: ${result.backupDir}`)
  if (result.rollbackCommand !== undefined) write(`Rollback: ${result.rollbackCommand}`)
}

function defaultDependencies(): CliDependencies {
  return {
    environment: process.env,
    cwd: process.cwd,
    installService: installUserService,
    rollbackService: rollbackUserService,
    serve: async () => {
      const { serveFromEnvironment } = await import('./main.ts')
      await serveFromEnvironment()
    },
    write: line => process.stdout.write(`${line}\n`),
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  runPersonalFeedCli(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'unknown error'
    process.stderr.write(`personal-feed: ${message}\n`)
    process.exitCode = 1
  })
}
