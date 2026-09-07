import { createHash, timingSafeEqual, randomUUID } from 'node:crypto'
import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { AsyncLocalStorage } from 'node:async_hooks'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { PersonalFeedApplicationPort, PersonalFeedServiceConfig, SafeLogger } from './contracts.ts'
import { connectMcpServer, createPersonalFeedMcpServer } from './mcp.ts'

export interface RunningPersonalFeedServer {
  readonly origin: string
  close(): Promise<void>
}

type McpConnection = {
  readonly transport: StreamableHTTPServerTransport
  readonly close: () => Promise<void>
  readonly handle: (request: IncomingMessage, response: ServerResponse) => Promise<void>
}

/** Start the loopback-only Streamable HTTP Personal Feed service. */
export async function startPersonalFeedServer(options: {
  readonly application: PersonalFeedApplicationPort
  readonly config: PersonalFeedServiceConfig
  readonly logger?: SafeLogger
}): Promise<RunningPersonalFeedServer> {
  assertSafeBinding(options.config)
  const active = new Set<Promise<unknown>>()
  const activeResponses = new Set<Promise<void>>()
  const controllers = new Set<AbortController>()
  const connections = new Map<string, McpConnection>()
  const responseScope = new AsyncLocalStorage<ServerResponse>()
  let closing = false

  const track = <T>(task: Promise<T>, abort: AbortController): Promise<T> => {
    controllers.add(abort)
    active.add(task)
    void task.finally(() => {
      active.delete(task)
      controllers.delete(abort)
    }).catch(() => undefined)
    return task
  }

  const server = createServer((request, response) => {
    trackResponse(response, activeResponses)
    if (closing) {
      json(response, 503, { error: 'shutting_down' })
      return
    }
    void route(request, response, options, track, connections, responseScope).catch(() => {
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
      let graceTimer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([
        Promise.allSettled([...active, ...activeResponses]),
        new Promise(resolve => { graceTimer = setTimeout(resolve, graceMs) }),
      ])
      clearTimeout(graceTimer)
      await Promise.allSettled([...connections.values()].map(connection => connection.close()))
      connections.clear()
      server.closeAllConnections()
      await stopped
    },
  }
}

async function route(
  request: IncomingMessage,
  response: ServerResponse,
  options: Parameters<typeof startPersonalFeedServer>[0],
  track: <T>(task: Promise<T>, abort: AbortController) => Promise<T>,
  connections: Map<string, McpConnection>,
  responseScope: AsyncLocalStorage<ServerResponse>,
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
  if (url.pathname !== '/mcp') {
    json(response, 404, { error: 'not_found' })
    return
  }
  if (!authorized(request.headers.authorization, options.config.mcpToken)) {
    response.setHeader('www-authenticate', 'Bearer')
    json(response, 401, { error: 'unauthorized' })
    return
  }

  if (request.method !== 'POST' && request.method !== 'DELETE') {
    response.setHeader('allow', 'POST, DELETE')
    json(response, 405, { error: 'method_not_allowed' })
    return
  }
  const protocolId = request.headers['mcp-session-id']
  if (protocolId !== undefined) {
    const connection = typeof protocolId === 'string' ? connections.get(protocolId) : undefined
    if (connection === undefined) { json(response, 404, { error: 'unknown_connection' }); return }
    await connection.handle(request, response)
    return
  }
  if (request.method === 'DELETE') { json(response, 400, { error: 'missing_connection' }); return }
  const connectionControllers = new Set<AbortController>()
  const pendingResponses = new Map<string | number, { readonly response: ServerResponse; readonly release: () => void }>()
  let transport!: StreamableHTTPServerTransport
  let handle!: McpConnection['handle']
  const terminateRequest = (requestId: string | number): void => {
    const pending = pendingResponses.get(requestId)?.response
    if (pending === undefined) return
    pending.destroy()
    transport.closeSSEStream(requestId)
  }
  const mcp = createPersonalFeedMcpServer({
    application: options.application,
    toolTimeoutMs: options.config.toolTimeoutMs,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    track: (task, abort) => {
      connectionControllers.add(abort)
      void task.finally(() => connectionControllers.delete(abort)).catch(() => undefined)
      return track(task, abort)
    },
    terminateRequest,
    releaseRequest: requestId => {
      const pending = pendingResponses.get(requestId)
      if (pending === undefined) return
      pendingResponses.delete(requestId)
      pending.response.off('finish', pending.release)
      pending.response.off('close', pending.release)
    },
  })
  const close = async () => {
    for (const abort of connectionControllers) abort.abort(new Error('connection closed'))
    for (const requestId of pendingResponses.keys()) terminateRequest(requestId)
    if (transport.sessionId !== undefined) connections.delete(transport.sessionId)
    await mcp.close()
  }
  transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    keepAliveMs: 0,
    onsessioninitialized: id => { connections.set(id, { transport, close, handle }) },
    onsessionclosed: async () => { await close() },
  })
  await connectMcpServer(mcp, transport as Transport)
  const dispatch = transport.onmessage
  if (dispatch === undefined) throw new Error('MCP transport has no message handler')
  transport.onmessage = (message, extra) => {
    const currentResponse = responseScope.getStore()
    if (currentResponse !== undefined && isUnrepresentableCancellationToolCall(message)) {
      currentResponse.flushHeaders = () => undefined
      const previous = pendingResponses.get(message.id)
      if (previous !== undefined) {
        previous.response.off('finish', previous.release)
        previous.response.off('close', previous.release)
      }
      const release = () => {
        if (pendingResponses.get(message.id)?.response === currentResponse) pendingResponses.delete(message.id)
      }
      pendingResponses.set(message.id, { response: currentResponse, release })
      currentResponse.once('finish', release)
      currentResponse.once('close', release)
    }
    dispatch(message, extra)
  }
  handle = (incoming: IncomingMessage, outgoing: ServerResponse) =>
    responseScope.run(outgoing, () => transport.handleRequest(incoming, outgoing))
  try { await handle(request, response) }
  finally { if (transport.sessionId === undefined) await close() }
}

function trackResponse(response: ServerResponse, active: Set<Promise<void>>): void {
  let resolve!: () => void
  const task = new Promise<void>(done => { resolve = done })
  let settled = false
  const finish = () => {
    if (settled) return
    settled = true
    response.off('finish', finish)
    response.off('close', finish)
    active.delete(task)
    resolve()
  }
  active.add(task)
  response.once('finish', finish)
  response.once('close', finish)
  if (response.writableFinished || response.destroyed) finish()
}

function isUnrepresentableCancellationToolCall(message: unknown): message is {
  readonly id: string | number
  readonly method: 'tools/call'
  readonly params: { readonly name: 'record_feedback' | 'list_saved' }
} {
  if (message === null || typeof message !== 'object' || !('id' in message) || !('method' in message) || !('params' in message)) return false
  const value = message as { id?: unknown; method?: unknown; params?: unknown }
  if ((typeof value.id !== 'string' && typeof value.id !== 'number') || value.method !== 'tools/call'
    || value.params === null || typeof value.params !== 'object' || !('name' in value.params)) return false
  const name = (value.params as { name?: unknown }).name
  return name === 'record_feedback' || name === 'list_saved'
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
