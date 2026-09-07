import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createPersonalFeedApplication } from './application.ts'
import { parseOpenAICompatibleConfig, resolveStateDir } from './config.ts'
import { createOpenAICompatiblePersonalFeedModel } from './openai-compatible-model.ts'
import { createPythonXObserver, resolveObserverCliPath } from './python-x-observer.ts'
import type { PersonalFeedServiceConfig } from './service/contracts.ts'
import { startPersonalFeedServer } from './service/server.ts'

export function parseServiceEnvironment(environment: NodeJS.ProcessEnv): PersonalFeedServiceConfig {
  const host = environment.PERSONAL_FEED_HOST?.trim() || '127.0.0.1'
  if (host !== '127.0.0.1') throw new Error('Personal Feed v1 must bind to 127.0.0.1')
  const port = integer(environment.PERSONAL_FEED_PORT ?? '43180', 'PERSONAL_FEED_PORT', 1, 65_535)
  const toolTimeoutMs = integer(environment.PERSONAL_FEED_TOOL_TIMEOUT_MS ?? '300000', 'PERSONAL_FEED_TOOL_TIMEOUT_MS', 1, 300_000)
  const model = parseOpenAICompatibleConfig({
    baseURL: required(environment, 'PERSONAL_FEED_MODEL_BASE_URL'),
    model: required(environment, 'PERSONAL_FEED_MODEL'),
    apiKey: required(environment, 'PERSONAL_FEED_MODEL_API_KEY'),
    timeoutMs: integer(environment.PERSONAL_FEED_MODEL_TIMEOUT_MS ?? '30000', 'PERSONAL_FEED_MODEL_TIMEOUT_MS', 1, 300_000),
    ...(environment.PERSONAL_FEED_MODEL_RESPONSE_FORMAT === undefined ? {} : {
      responseFormat: environment.PERSONAL_FEED_MODEL_RESPONSE_FORMAT.trim(),
    }),
  })
  const mcpToken = required(environment, 'PERSONAL_FEED_MCP_TOKEN')
  if (!/^[A-Za-z0-9._~-]{16,512}$/.test(mcpToken)) throw new Error('MCP token must be 16-512 URL-safe characters')
  const stateEnvironment = environment.XDG_STATE_HOME === undefined && environment.HOME !== undefined
    ? { ...environment, XDG_STATE_HOME: join(environment.HOME, '.local', 'state') }
    : environment
  return Object.freeze({
    host,
    port,
    mcpToken,
    stateDir: environment.PERSONAL_FEED_STATE_DIR?.trim() || resolveStateDir(stateEnvironment),
    observerCliPath: environment.PERSONAL_FEED_OBSERVER_CLI?.trim() || resolveObserverCliPath(),
    toolTimeoutMs,
    model,
  })
}

/** Compose and run the standalone service until SIGINT or SIGTERM. */
export async function serveFromEnvironment(environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  const config = parseServiceEnvironment(environment)
  await mkdir(config.stateDir, { recursive: true, mode: 0o700 })
  const observer = createPythonXObserver({ observerCliPath: config.observerCliPath, stateDir: config.stateDir })
  const model = createOpenAICompatiblePersonalFeedModel(config.model,
    event => process.stderr.write(`${JSON.stringify(event)}\n`))
  const application = createPersonalFeedApplication({ stateDir: config.stateDir, model, observer,
    onFailure: event => process.stderr.write(`${JSON.stringify(event)}\n`) })
  const running = await startPersonalFeedServer({
    application,
    config,
    logger: event => process.stderr.write(`${JSON.stringify(event)}\n`),
  })
  try {
    await terminationSignal()
  } finally {
    await running.close()
    await application.close()
  }
}

function terminationSignal(): Promise<void> {
  return new Promise(resolve => {
    const finish = () => {
      process.off('SIGINT', finish)
      process.off('SIGTERM', finish)
      resolve()
    }
    process.once('SIGINT', finish)
    process.once('SIGTERM', finish)
  })
}

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim()
  const label = name === 'PERSONAL_FEED_MCP_TOKEN' ? 'MCP token'
    : name === 'PERSONAL_FEED_MODEL_API_KEY' ? 'apiKey'
      : name
  if (value === undefined || value === '') throw new Error(`${label} is required`)
  return value
}

function integer(value: string, name: string, minimum: number, maximum: number): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`)
  }
  return parsed
}
