import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPersonalFeedApplication } from '../../src/application.ts'
import { afterEach, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { startPersonalFeedServer } from '../../src/service/server.ts'
import type { PersonalFeedApplicationPort } from '../../src/service/contracts.ts'
import type { InteractionOptions } from '../../src/interaction.ts'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function fixture(mode?: string, capable = true, timeout = 1000, override?: PersonalFeedApplicationPort) {
  const received: unknown[] = []
  const request = vi.fn(async (_input: unknown, context: InteractionOptions & { signal: AbortSignal }) => {
    received.push(context.mode)
    const answer = context.mode === 'interactive' ? await context.ask?.('请补充兴趣范围。', context.signal) : undefined
    received.push(answer)
    if (answer?.action === 'accept') return { status: 'business_empty' as const }
    const reason = answer?.action === 'decline' ? 'interaction_declined' : answer?.action === 'cancel' ? 'interaction_cancelled' : answer?.action === 'timeout' ? 'interaction_timeout' : 'interaction_unavailable'
    return { status: 'incomplete', stage: 'personal_context', ...(context.mode === 'interactive' ? { reason } : {}) } as never
  })
  const application = { request, observeContext: vi.fn(), processFeedback: vi.fn(), recordFeedback: vi.fn(), listSaved: vi.fn() } as unknown as PersonalFeedApplicationPort
  const running = await startPersonalFeedServer({ application: override ?? application, config: { host: '127.0.0.1', port: 0, mcpToken: 'fixture-token-long-enough', stateDir: '/unused', observerCliPath: '/unused', toolTimeoutMs: timeout, model: { baseURL: '', model: '', apiKey: '', timeoutMs: 1000 } } })
  cleanup.push(() => running.close())
  const client = new Client({ name: 'forms', version: '1' }, { capabilities: capable ? { elicitation: { form: {} } } : {} })
  const transport = new StreamableHTTPClientTransport(new URL(`${running.origin}/mcp`), { requestInit: { headers: { authorization: 'Bearer fixture-token-long-enough', ...(mode === undefined ? {} : { 'Personal-Feed-Mode': mode }) } } })
  cleanup.push(() => client.close())
  await client.connect(transport)
  return { client, transport, received, running, request }
}
it('defaults to background and exposes no model-supplied mode or continuation token', async () => {
  const { client, received } = await fixture()
  const listed = await client.listTools()
  expect(JSON.stringify(listed)).not.toContain('continuationToken')
  expect(JSON.stringify(listed)).not.toContain('"mode"')
  const result = await client.callTool({ name: 'request', arguments: { currentText: 'template' } })
  expect(result.isError).not.toBe(true)
  expect(received[0]).toBe('background')
})
it('elicits on the originating POST after initialization and preserves raw whitespace', async () => {
  const { client, received } = await fixture('interactive')
  client.setRequestHandler(ElicitRequestSchema, async request => {
    expect(request.params).toMatchObject({ requestedSchema: { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } } } })
    return { action: 'accept', content: { answer: '\n 原始回答。\t' } }
  })
  const result = await client.callTool({ name: 'request', arguments: { currentText: 'feed' } })
  expect(result.isError).not.toBe(true)
  expect(result.structuredContent).toEqual({ status: 'business_empty' })
  expect(received).toEqual(['interactive', { action: 'accept', text: '\n 原始回答。\t' }])
  expect((await client.listTools()).tools).toHaveLength(5)
})
it.each(['decline', 'cancel'] as const)('returns normal incomplete for form %s', async action => {
  const { client } = await fixture('interactive')
  client.setRequestHandler(ElicitRequestSchema, async () => ({ action }))
  const result = await client.callTool({ name: 'request', arguments: { currentText: 'feed' } })
  expect(result.isError).not.toBe(true)
  expect(result.structuredContent).toEqual({ status: 'incomplete', stage: 'personal_context', reason: action === 'decline' ? 'interaction_declined' : 'interaction_cancelled' })
  expect(JSON.stringify(result.content)).not.toContain('用户拒绝')
})
it('returns normal unsupported and timeout results', async () => {
  const unsupported = await fixture('interactive', false)
  expect((await unsupported.client.callTool({ name: 'request', arguments: { currentText: 'feed' } })).structuredContent).toMatchObject({ reason: 'interaction_unavailable' })
  const timed = await fixture('interactive', true, 100)
  timed.client.setRequestHandler(ElicitRequestSchema, async () => new Promise(() => {}))
  expect((await timed.client.callTool({ name: 'request', arguments: { currentText: 'feed' } })).structuredContent).toMatchObject({ reason: 'interaction_timeout' })
})
it('correlates simultaneous questions with reversed answers', async () => {
  const { client, received } = await fixture('interactive')
  const answers: Array<(value: { action: 'accept'; content: { answer: string } }) => void> = []
  client.setRequestHandler(ElicitRequestSchema, async () => new Promise(resolve => answers.push(resolve)))
  const first = client.callTool({ name: 'request', arguments: { currentText: 'first' } })
  await vi.waitFor(() => expect(answers).toHaveLength(1))
  const second = client.callTool({ name: 'request', arguments: { currentText: 'second' } })
  await vi.waitFor(() => expect(answers).toHaveLength(2))
  answers[1]!({ action: 'accept', content: { answer: 'second answer' } })
  await second
  answers[0]!({ action: 'accept', content: { answer: 'first answer' } })
  await first
  expect(received).toEqual(['interactive', 'interactive', { action: 'accept', text: 'second answer' }, { action: 'accept', text: 'first answer' }])
})
it('keeps an elicitation alive when a saved-item call times out in the same session', async () => {
  let saveStarted = false
  const application = {
    request: vi.fn(async (_input: unknown, context: InteractionOptions & { signal: AbortSignal }) => {
      const answer = await context.ask?.('请补充兴趣范围。', context.signal)
      return answer?.action === 'accept'
        ? { status: 'business_empty' as const }
        : { status: 'incomplete', stage: 'personal_context', reason: 'interaction_unavailable' } as const
    }),
    observeContext: vi.fn(),
    processFeedback: vi.fn(),
    recordFeedback: vi.fn(async (_input: unknown, context: { signal: AbortSignal }) => {
      saveStarted = true
      await new Promise<never>((_resolve, reject) => context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true }))
    }),
    listSaved: vi.fn(),
  } as unknown as PersonalFeedApplicationPort
  const { client } = await fixture('interactive', true, 300, application)
  let answerForm!: (value: { action: 'accept'; content: { answer: string } }) => void
  client.setRequestHandler(ElicitRequestSchema, async () => new Promise(resolve => { answerForm = resolve }))

  const save = client.callTool({ name: 'record_feedback', arguments: { operation: 'save', url: 'https://x.com/a/status/1' } })
    .then(result => ({ kind: 'result' as const, result }), error => ({ kind: 'error' as const, error }))
  await vi.waitFor(() => expect(saveStarted).toBe(true))
  await new Promise(resolve => setTimeout(resolve, 100))
  const request = client.callTool({ name: 'request', arguments: { currentText: 'Feed' } })
  await vi.waitFor(() => expect(answerForm).toBeTypeOf('function'))

  await expect(save).resolves.toMatchObject({ kind: 'error' })
  answerForm({ action: 'accept', content: { answer: 'AI video' } })
  await expect(request).resolves.toMatchObject({ structuredContent: { status: 'business_empty' } })
  await expect(client.listTools()).resolves.toMatchObject({ tools: expect.any(Array) })
})
it('authenticates deletion, rejects GET and releases an explicitly terminated connection', async () => {
  const { client, transport, running } = await fixture()
  expect(transport.sessionId).toEqual(expect.any(String))
  const endpoint = `${running.origin}/mcp`
  expect((await fetch(endpoint, { method: 'DELETE', headers: { 'mcp-session-id': transport.sessionId! } })).status).toBe(401)
  expect((await fetch(endpoint, { headers: { authorization: 'Bearer fixture-token-long-enough', 'mcp-session-id': transport.sessionId! } })).status).toBe(405)
  const id = transport.sessionId!
  await transport.terminateSession()
  expect((await fetch(endpoint, { method: 'POST', headers: { authorization: 'Bearer fixture-token-long-enough', 'mcp-session-id': id, 'content-type': 'application/json' }, body: '{}' })).status).toBe(404)
  await client.close()
})
it('rejects invalid mode per tool invocation and never lets input choose the mode', async () => {
  const { client, request } = await fixture('invented')
  expect((await client.callTool({ name: 'request', arguments: { currentText: 'feed' } })).isError).toBe(true)
  expect(request).not.toHaveBeenCalled()
  const valid = await fixture()
  expect((await valid.client.callTool({ name: 'request', arguments: { currentText: 'feed', mode: 'interactive' } })).isError).toBe(true)
})
it('cancels a pending form on service stop without waiting for the whole deadline', async () => {
  const { client, received, running } = await fixture('interactive', true, 10000)
  let shown = false
  client.setRequestHandler(ElicitRequestSchema, async () => { shown = true; return new Promise(() => {}) })
  const call = client.callTool({ name: 'request', arguments: { currentText: 'feed' } }).catch(() => undefined)
  await vi.waitFor(() => expect(shown).toBe(true))
  await running.close()
  await client.close()
  await call
  expect(received).toContainEqual({ action: 'cancel' })
})
it('a lost client leaves only a deadline-bounded pending call and does not terminate the protocol connection', async () => {
  const { client, received, transport, running } = await fixture('interactive', true, 150)
  let shown = false
  client.setRequestHandler(ElicitRequestSchema, async () => { shown = true; return new Promise(() => {}) })
  const call = client.callTool({ name: 'request', arguments: { currentText: 'feed' } }).catch(() => undefined)
  await vi.waitFor(() => expect(shown).toBe(true))
  const id = transport.sessionId!
  await client.close()
  await call
  await vi.waitFor(() => expect(received).toContainEqual({ action: 'timeout' }))
  const response = await fetch(`${running.origin}/mcp`, { method: 'DELETE', headers: { authorization: 'Bearer fixture-token-long-enough', 'mcp-session-id': id } })
  expect(response.status).toBe(200)
})
it('an explicit DELETE aborts only the corresponding connection pending form', async () => {
  const { client, received, transport } = await fixture('interactive')
  let shown = false
  client.setRequestHandler(ElicitRequestSchema, async () => { shown = true; return new Promise(() => {}) })
  const call = client.callTool({ name: 'request', arguments: { currentText: 'feed' } }).catch(() => undefined)
  await vi.waitFor(() => expect(shown).toBe(true))
  await transport.terminateSession()
  await client.close()
  await call
  await vi.waitFor(() => expect(received).toContainEqual({ action: 'cancel' }))
})
it('routes request id zero and ignores a duplicate form answer', async () => {
  const { transport, running, received } = await fixture('interactive')
  const endpoint = `${running.origin}/mcp`
  const headers = { authorization: 'Bearer fixture-token-long-enough', 'Personal-Feed-Mode': 'interactive', 'mcp-session-id': transport.sessionId!, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
  const response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'tools/call', params: { name: 'request', arguments: { currentText: 'zero' } } }) })
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let pending = ''
  async function event(): Promise<Record<string, unknown>> {
    for (;;) {
      const boundary = pending.indexOf('\n\n')
      if (boundary >= 0) {
        const block = pending.slice(0, boundary)
        pending = pending.slice(boundary + 2)
        const data = block.split('\n').find(line => line.startsWith('data: '))
        if (data !== undefined) return JSON.parse(data.slice(6))
        continue
      }
      const next = await reader.read()
      if (next.done) throw new Error('stream ended before response')
      pending += decoder.decode(next.value)
    }
  }
  const question = await event()
  expect(question.method).toBe('elicitation/create')
  const answer = { jsonrpc: '2.0', id: question.id, result: { action: 'accept', content: { answer: 'only once' } } }
  for (let repeat = 0; repeat < 2; repeat += 1) expect((await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(answer) })).status).toBe(202)
  expect(await event()).toMatchObject({ id: 0, result: { structuredContent: { status: 'business_empty' } } })
  expect(received).toEqual(['interactive', { action: 'accept', text: 'only once' }])
  await reader.cancel()
})
it('propagates protocol call cancellation to the pending form', async () => {
  const { client, received } = await fixture('interactive')
  let shown = false
  client.setRequestHandler(ElicitRequestSchema, async () => { shown = true; return new Promise(() => {}) })
  const abort = new AbortController()
  const call = client.callTool({ name: 'request', arguments: { currentText: 'feed' } }, undefined, { signal: abort.signal }).catch(() => undefined)
  await vi.waitFor(() => expect(shown).toBe(true))
  abort.abort()
  await call
  await vi.waitFor(() => expect(received).toContainEqual({ action: 'cancel' }))
})

it.each([{ answer: '   ' }, {}, { answer: 'x'.repeat(100_001) }])('rejects malformed accepted form content through the real application', async content => {
  const stateDir = await mkdtemp(join(tmpdir(), 'pf-invalid-form-'))
  cleanup.push(() => rm(stateDir, { recursive: true, force: true }))
  const application = createPersonalFeedApplication({ stateDir,
    observer: { observe: vi.fn(), close: async () => {} },
    model: { assessContext: vi.fn(), judgeCandidate: vi.fn(), interpretFeedback: vi.fn(),
      observeContext: async () => ({ status: 'ignored', sufficient: false, remaining: { question: '兴趣？', unresolvedScope: 'interest' } }),
    },
  })
  cleanup.push(() => application.close())
  const { client } = await fixture('interactive', true, 1000, application)
  client.setRequestHandler(ElicitRequestSchema, async () => ({ action: 'accept', content }))
  const result = await client.callTool({ name: 'observe_context', arguments: { currentText: 'profile update' } })
  expect(result.isError).toBe(true)
  expect(result.structuredContent).toBeUndefined()
})
