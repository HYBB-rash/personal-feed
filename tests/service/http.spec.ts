import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { createServer, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { startPersonalFeedServer, type RunningPersonalFeedServer } from '../../src/service/server.ts'
import { PersonalFeedStorageError } from '../../src/errors.ts'

const TOKEN = 'mcp-secret-for-test'
const MODEL_KEY = 'model-secret-for-test'

describe('Personal Feed HTTP service', () => {
  let running: RunningPersonalFeedServer | undefined

  afterEach(async () => {
    await running?.close()
    running = undefined
    vi.restoreAllMocks()
  })

  it('keeps liveness separate from local-only readiness checks', async () => {
    const fixture = await makeReadyFixture()
    running = await startPersonalFeedServer({
      application: fakeApplication(),
      config: serviceConfig(fixture),
    })

    const health = await fetch(`${running.origin}/healthz`)
    expect(health.status).toBe(200)
    expect(await health.json()).toEqual({ status: 'ok' })

    const ready = await fetch(`${running.origin}/readyz`)
    expect(ready.status).toBe(200)
    expect(await ready.json()).toEqual({ status: 'ready' })

    await writeFile(fixture.observerCliPath, '')
    running = await restart(running, {
      application: fakeApplication(),
      config: { ...serviceConfig(fixture), model: { ...serviceConfig(fixture).model, apiKey: '' } },
    })
    const notReady = await fetch(`${running.origin}/readyz`)
    expect(notReady.status).toBe(503)
    expect(await notReady.json()).toEqual({ status: 'not_ready', checks: ['model_api_key'] })
  })

  it('requires a Bearer token and exposes exactly five MCP tools', async () => {
    const fixture = await makeReadyFixture()
    running = await startPersonalFeedServer({
      application: fakeApplication(),
      config: serviceConfig(fixture),
    })

    const unauthorized = await fetch(`${running.origin}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(unauthorized.status).toBe(401)

    const client = new Client({ name: 'service-test', version: '1.0.0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(`${running.origin}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
    }))
    const listed = await client.listTools()
    expect(listed.tools.map(tool => tool.name).sort()).toEqual([
      'list_saved',
      'observe_context',
      'process_feedback',
      'record_feedback',
      'request',
    ])
    await client.close()
  })

  it('returns both readable text and structuredContent for normal business results', async () => {
    const fixture = await makeReadyFixture()
    const application = fakeApplication()
    running = await startPersonalFeedServer({ application, config: { ...serviceConfig(fixture), shutdownGraceMs: 5 } })
    const client = await connectClient(running.origin)

    const result = await client.callTool({ name: 'request', arguments: { currentText: '请给我 feed' } })
    expect(result.isError).not.toBe(true)
    expect(result.structuredContent).toEqual({ status: 'business_empty' })
    expect(result.content).toEqual([{ type: 'text', text: expect.stringContaining('暂时没有') }])
    expect(application.request).toHaveBeenCalledWith(
      { currentText: '请给我 feed' },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    await client.close()
  })

  it('treats invalid input and typed storage failures as MCP errors, not business empty', async () => {
    const fixture = await makeReadyFixture()
    const application = fakeApplication()
    application.recordFeedback.mockRejectedValueOnce(new PersonalFeedStorageError('storage failed'))
    running = await startPersonalFeedServer({ application, config: { ...serviceConfig(fixture), shutdownGraceMs: 5 } })
    const client = await connectClient(running.origin)

    const invalid = await client.callTool({ name: 'record_feedback', arguments: { operation: 'like', url: 'https://x.com/a/status/1' } })
    expect(invalid.isError).toBe(true)
    const failed = await client.callTool({ name: 'record_feedback', arguments: { operation: 'save', url: 'https://x.com/a/status/1' } })
    expect(failed.isError).toBe(true)
    expect(failed.structuredContent).toBeUndefined()
    await client.close()
  })

  it('releases an invalid saved-tool response before the session closes', async () => {
    const fixture = await makeReadyFixture()
    running = await startPersonalFeedServer({ application: fakeApplication(), config: serviceConfig(fixture) })
    const destroy = vi.spyOn(ServerResponse.prototype, 'destroy')
    const client = new Client({ name: 'invalid-cleanup', version: '1.0.0' })
    const transport = new StreamableHTTPClientTransport(new URL(`${running.origin}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
    })
    await client.connect(transport)

    expect((await client.callTool({
      name: 'record_feedback', arguments: { operation: 'like', url: 'https://x.com/a/status/1' },
    })).isError).toBe(true)
    const beforeClose = destroy.mock.calls.length
    await transport.terminateSession()
    expect(destroy).toHaveBeenCalledTimes(beforeClose)
    await client.close()
  })

  it('contains an implementation result outside the frozen closed-result contract', async () => {
    const fixture = await makeReadyFixture()
    const application = fakeApplication()
    application.request.mockImplementationOnce(async () => ({ status: 'incomplete', stage: 'invented' } as never))
    running = await startPersonalFeedServer({ application, config: serviceConfig(fixture) })
    const client = await connectClient(running.origin)

    const result = await client.callTool({ name: 'request', arguments: { currentText: '请给我 feed' } })
    expect(result.isError).not.toBe(true)
    expect(result.structuredContent).toEqual({ status: 'incomplete', stage: 'shutdown' })
    await client.close()
  })

  it('contains a removed continuation result as a normal feedback incomplete', async () => {
    const fixture = await makeReadyFixture()
    const application = fakeApplication()
    application.processFeedback.mockImplementationOnce(async () => ({
      status: 'needs_input',
      question: '请补充目标。',
      continuationToken: 'A'.repeat(16),
    } as never))
    running = await startPersonalFeedServer({ application, config: serviceConfig(fixture) })
    const client = await connectClient(running.origin)

    const result = await client.callTool({ name: 'process_feedback', arguments: { currentText: '不喜欢' } })
    expect(result.isError).not.toBe(true)
    expect(result.structuredContent).toEqual({ status: 'incomplete', stage: 'feedback_interpretation' })
    await client.close()
  })

  it('bounds slow tools, propagates cancellation, and redacts sensitive inputs from logs', async () => {
    const fixture = await makeReadyFixture()
    let observedSignal: AbortSignal | undefined
    const application = fakeApplication()
    application.processFeedback.mockImplementation(async (_input, context) => {
      observedSignal = context.signal
      await new Promise((_resolve, reject) => context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true }))
      return { status: 'pass' }
    })
    const events: unknown[] = []
    running = await startPersonalFeedServer({
      application,
      config: { ...serviceConfig(fixture), toolTimeoutMs: 20 },
      logger: event => events.push(event),
    })
    const client = await connectClient(running.origin)
    const secretText = 'secret user text https://x.com/private/status/9'
    const secretContinuation = 'A'.repeat(43)
    const result = await client.callTool({
      name: 'process_feedback',
      arguments: { currentText: secretText },
    })
    expect(result.isError).not.toBe(true)
    expect(result.structuredContent).toEqual({
      status: 'incomplete', stage: 'feedback_interpretation', reason: 'interaction_timeout',
    })
    expect(observedSignal?.aborted).toBe(true)
    const serialized = JSON.stringify(events)
    expect(serialized).not.toContain(secretText)
    expect(serialized).not.toContain(secretContinuation)
    expect(serialized).not.toContain(TOKEN)
    expect(serialized).not.toContain(MODEL_KEY)
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ operation: 'process_feedback', result: 'error', durationMs: expect.any(Number) }),
    ]))
    await client.close()
  })

  it.each([
    ['record_feedback', 'recordFeedback', { operation: 'save', url: 'https://x.com/a/status/1' }],
    ['list_saved', 'listSaved', {}],
  ] as const)('terminates a timed-out %s HTTP request without inventing a business result', async (name, method, input) => {
    const fixture = await makeReadyFixture()
    const application = fakeApplication()
    let observedSignal: AbortSignal | undefined
    application[method].mockImplementation(async (_input: never, context: { signal: AbortSignal }) => {
      observedSignal = context.signal
      return new Promise<never>(() => {})
    })
    running = await startPersonalFeedServer({
      application,
      config: { ...serviceConfig(fixture), toolTimeoutMs: 20, shutdownGraceMs: 5 },
    })
    const client = await connectClient(running.origin)

    const outcome = await Promise.race([
      client.callTool({ name, arguments: input }, undefined, { timeout: 1_000 })
        .then(result => ({ kind: 'result' as const, result }), error => ({ kind: 'error' as const, error })),
      new Promise<{ kind: 'pending' }>(resolve => setTimeout(() => resolve({ kind: 'pending' }), 300)),
    ])
    expect(outcome).toMatchObject({ kind: 'error' })
    expect(observedSignal?.aborted).toBe(true)
    await client.close()
  })

  it.each([
    ['record_feedback', 'recordFeedback', { operation: 'save', url: 'https://x.com/a/status/1' }, 'throw'],
    ['list_saved', 'listSaved', {}, 'invalid_output'],
  ] as const)('terminates %s transport for an unclassified %s boundary fault', async (name, method, input, fault) => {
    const fixture = await makeReadyFixture()
    const application = fakeApplication()
    application[method].mockImplementation(async () => {
      if (fault === 'throw') throw new Error('controlled internal fault')
      return { status: 'incomplete' } as never
    })
    running = await startPersonalFeedServer({ application, config: serviceConfig(fixture) })
    const client = await connectClient(running.origin)

    const outcome = await Promise.race([
      client.callTool({ name, arguments: input }, undefined, { timeout: 1_000 })
        .then(result => ({ kind: 'result' as const, result }), error => ({ kind: 'error' as const, error })),
      new Promise<{ kind: 'pending' }>(resolve => setTimeout(() => resolve({ kind: 'pending' }), 300)),
    ])
    expect(outcome).toMatchObject({ kind: 'error' })
    await client.close()
  })

  it.each([
    ['record_feedback', 'recordFeedback', { operation: 'save', url: 'https://x.com/a/status/1' }],
    ['list_saved', 'listSaved', {}],
  ] as const)('uses protocol cancellation for a pending %s call', async (name, method, input) => {
    const fixture = await makeReadyFixture()
    const application = fakeApplication()
    let observedSignal: AbortSignal | undefined
    application[method].mockImplementation(async (_input: never, context: { signal: AbortSignal }) => {
      observedSignal = context.signal
      return new Promise<never>(() => {})
    })
    running = await startPersonalFeedServer({ application, config: { ...serviceConfig(fixture), shutdownGraceMs: 5 } })
    const client = await connectClient(running.origin)
    const abort = new AbortController()
    const call = client.callTool({ name, arguments: input }, undefined, { signal: abort.signal })
    await vi.waitFor(() => expect(observedSignal).toBeDefined())

    abort.abort()
    await expect(call).rejects.toBeDefined()
    await vi.waitFor(() => expect(observedSignal?.aborted).toBe(true))
    await client.close()
  })

  it.each([
    ['record_feedback', 'recordFeedback', { operation: 'save', url: 'https://x.com/a/status/1' }],
    ['list_saved', 'listSaved', {}],
  ] as const)('ends a pending %s transport when the service closes', async (name, method, input) => {
    const fixture = await makeReadyFixture()
    const application = fakeApplication()
    let started = false
    application[method].mockImplementation(async () => {
      started = true
      return new Promise<never>(() => {})
    })
    running = await startPersonalFeedServer({
      application,
      config: { ...serviceConfig(fixture), shutdownGraceMs: 5 },
    })
    const client = await connectClient(running.origin)
    const call = client.callTool({ name, arguments: input }, undefined, { timeout: 1_000 })
    await vi.waitFor(() => expect(started).toBe(true))

    await running.close()
    await expect(Promise.race([
      call.then(result => ({ kind: 'result' as const, result }), error => ({ kind: 'error' as const, error })),
      new Promise<{ kind: 'pending' }>(resolve => setTimeout(() => resolve({ kind: 'pending' }), 300)),
    ])).resolves.toMatchObject({ kind: 'error' })
    await client.close()
  })

  it.each([
    ['request', 'request', { currentText: 'Feed' }, { status: 'incomplete', stage: 'shutdown', reason: 'interaction_cancelled' }],
    ['observe_context', 'observeContext', { currentText: 'profile' }, { status: 'incomplete', stage: 'context_observation', reason: 'interaction_cancelled' }],
    ['process_feedback', 'processFeedback', { currentText: 'like it' }, { status: 'incomplete', stage: 'feedback_interpretation', reason: 'interaction_cancelled' }],
  ] as const)('delivers the shutdown result for a pending %s call before close returns', async (name, method, input, expected) => {
    const fixture = await makeReadyFixture()
    const application = fakeApplication()
    let started = false
    application[method].mockImplementation(async (_input: never, context: { signal: AbortSignal }) => {
      started = true
      await new Promise(resolve => context.signal.addEventListener('abort', resolve, { once: true }))
      return expected as never
    })
    running = await startPersonalFeedServer({
      application,
      config: { ...serviceConfig(fixture), shutdownGraceMs: 100 },
    })
    const client = await connectClient(running.origin)
    const call = client.callTool({ name, arguments: input })
      .then(result => ({ kind: 'result' as const, result }), error => ({ kind: 'error' as const, error }))
    await vi.waitFor(() => expect(started).toBe(true))

    await running.close()
    const outcome = await Promise.race([
      call,
      new Promise<{ kind: 'pending' }>(resolve => setTimeout(() => resolve({ kind: 'pending' }), 300)),
    ])
    expect(outcome).toMatchObject({ kind: 'result', result: { structuredContent: expected } })
    await client.close()
  })
})

async function connectClient(origin: string): Promise<Client> {
  const client = new Client({ name: 'service-test', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
  }))
  return client
}

async function makeReadyFixture(): Promise<{ stateDir: string; observerCliPath: string }> {
  const root = await mkdtemp(join(tmpdir(), 'personal-feed-service-'))
  const stateDir = join(root, 'state')
  await mkdir(stateDir)
  const observerCliPath = join(root, 'observer.py')
  await writeFile(observerCliPath, '# observer fixture\n')
  return { stateDir, observerCliPath }
}

function serviceConfig(fixture: { stateDir: string; observerCliPath: string }) {
  return {
    host: '127.0.0.1',
    port: 0,
    mcpToken: TOKEN,
    stateDir: fixture.stateDir,
    observerCliPath: fixture.observerCliPath,
    toolTimeoutMs: 1_000,
    model: {
      baseURL: 'http://127.0.0.1:9/v1',
      model: 'fixture-model',
      apiKey: MODEL_KEY,
      timeoutMs: 1_000,
    },
  }
}

function fakeApplication() {
  return {
    request: vi.fn(async () => ({ status: 'business_empty' as const })),
    observeContext: vi.fn(async () => ({ status: 'ignored' as const })),
    processFeedback: vi.fn(async () => ({ status: 'pass' as const })),
    recordFeedback: vi.fn(async () => ({ status: 'saved' as const, url: 'https://x.com/a/status/1' })),
    listSaved: vi.fn(async () => ({ status: 'completed' as const, items: [] })),
  }
}

async function restart(
  current: RunningPersonalFeedServer,
  options: Parameters<typeof startPersonalFeedServer>[0],
): Promise<RunningPersonalFeedServer> {
  await current.close()
  return startPersonalFeedServer(options)
}
