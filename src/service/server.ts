import { createHash, timingSafeEqual } from 'node:crypto'
import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { PersonalFeedApplicationPort, PersonalFeedServiceConfig, SafeLogger } from './contracts.ts'
import { connectMcpServer, createPersonalFeedMcpServer } from './mcp.ts'

export interface RunningPersonalFeedServer {
  readonly origin: string
  close(): Promise<void>
}

/** Start the loopback-only, stateless Streamable HTTP Personal Feed service. */
export async function startPersonalFeedServer(options: {
  readonly application: PersonalFeedApplicationPort
  readonly config: PersonalFeedServiceConfig
  readonly logger?: SafeLogger
  /** Deliberately unused; readiness must stay local-only. Exposed for a regression test. */
  readonly networkProbe?: () => Promise<unknown>
}): Promise<RunningPersonalFeedServer> {
  assertSafeBinding(options.config)
  const active = new Set<Promise<unknown>>()
  const controllers = new Set<AbortController>()
  let closing = false

  const track = <T>(_operation: string, task: Promise<T>, abort: AbortController): Promise<T> => {
    controllers.add(abort)
    active.add(task)
    void task.finally(() => {
      active.delete(task)
      controllers.delete(abort)
    }).catch(() => undefined)
    return task
  }

  const server = createServer((request, response) => {
    if (closing) {
      json(response, 503, { error: 'shutting_down' })
      return
    }
    void route(request, response, options, track).catch(() => {
      if (!response.headersSent) json(response, 500, { error: 'internal_error' })
      else response.end()
    })
  })
  await listen(server, options.config.host, options.config.port)
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Personal Feed service has no TCP address')

  return {
    origin: `http://${options.config.host}:${address.port}`,
    close: async () => {
      if (closing) return
      closing = true
      const stopped = closeServer(server)
      for (const controller of controllers) controller.abort(new Error('service shutting down'))
      const graceMs = options.config.shutdownGraceMs ?? 5_000
      await Promise.race([
        Promise.allSettled([...active]),
        new Promise(resolve => setTimeout(resolve, graceMs)),
      ])
      server.closeAllConnections()
      await stopped
    },
  }
}

async function route(
  request: IncomingMessage,
  response: ServerResponse,
  options: Parameters<typeof startPersonalFeedServer>[0],
  track: <T>(operation: string, task: Promise<T>, abort: AbortController) => Promise<T>,
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  if (request.method === 'GET' && url.pathname === '/healthz') {
    json(response, 200, { status: 'ok' })
    return
  }
  if (request.method === 'GET' && url.pathname === '/readyz') {
    const checks = await readinessFailures(options.config)
    json(response, checks.length === 0 ? 200 : 503, checks.length === 0
      ? { status: 'ready' }
      : { status: 'not_ready', checks })
    return
  }
  if (request.method !== 'POST' || url.pathname !== '/mcp') {
    json(response, 404, { error: 'not_found' })
    return
  }
  if (!authorized(request.headers.authorization, options.config.mcpToken)) {
    response.setHeader('www-authenticate', 'Bearer')
    json(response, 401, { error: 'unauthorized' })
    return
  }

  const mcp = createPersonalFeedMcpServer({
    application: options.application,
    toolTimeoutMs: options.config.toolTimeoutMs,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    track,
  })
  const transport = new StreamableHTTPServerTransport({})
  response.on('close', () => {
    void transport.close()
    void mcp.close()
  })
  await connectMcpServer(mcp, transport as Transport)
  await transport.handleRequest(request, response)
}

async function readinessFailures(config: PersonalFeedServiceConfig): Promise<string[]> {
  const failures: string[] = []
  if (config.model.baseURL === '') failures.push('model_base_url')
  if (config.model.model === '') failures.push('model_name')
  if (config.model.apiKey === '') failures.push('model_api_key')
  try {
    await access(config.stateDir, constants.R_OK | constants.W_OK)
  } catch {
    failures.push('state_directory')
  }
  try {
    await access(config.observerCliPath, constants.R_OK)
  } catch {
    failures.push('python_assets')
  }
  return failures
}

function assertSafeBinding(config: PersonalFeedServiceConfig): void {
  if (config.host !== '127.0.0.1') throw new Error('Personal Feed v1 only supports 127.0.0.1')
  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65_535) throw new Error('invalid service port')
  if (config.mcpToken.length < 16) throw new Error('MCP Bearer token must contain at least 16 characters')
  if (!Number.isInteger(config.toolTimeoutMs) || config.toolTimeoutMs < 1) throw new Error('tool timeout must be positive')
}

function authorized(header: string | undefined, token: string): boolean {
  if (header === undefined || !header.startsWith('Bearer ')) return false
  const actual = createHash('sha256').update(header.slice(7)).digest()
  const expected = createHash('sha256').update(token).digest()
  return timingSafeEqual(actual, expected)
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(JSON.stringify(body))
}

function listen(server: Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.off('error', reject)
      resolve()
    })
  })
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close(error => error === undefined ? resolve() : reject(error))
  })
}
