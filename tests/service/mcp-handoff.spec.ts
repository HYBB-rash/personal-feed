import { afterEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createPersonalFeedMcpServer } from '../../src/service/mcp.ts'
import type { PersonalFeedApplicationPort, SafeLogEvent } from '../../src/service/contracts.ts'

const continuationToken = 'A'.repeat(43)
const question = '还有哪个适用范围需要澄清？'
const url = 'https://x.com/example/status/123'
const questionPair = { question, continuationToken }

describe('D01 MCP handoff boundary with a controlled application', () => {
  const cleanup: Array<() => Promise<void>> = []
  afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) await close()
  })

  async function fixture() {
    const application = {
      request: vi.fn<PersonalFeedApplicationPort['request']>(async () => ({ status: 'business_empty' })),
      observeContext: vi.fn<PersonalFeedApplicationPort['observeContext']>(async () => ({ status: 'ignored' })),
      processFeedback: vi.fn<PersonalFeedApplicationPort['processFeedback']>(async () => ({ status: 'pass' })),
      recordFeedback: vi.fn<PersonalFeedApplicationPort['recordFeedback']>(async () => ({ status: 'saved' })),
      listSaved: vi.fn<PersonalFeedApplicationPort['listSaved']>(async () => ({ status: 'completed', items: [] })),
    }
    const events: SafeLogEvent[] = []
    const server = createPersonalFeedMcpServer({
      application, toolTimeoutMs: 1_000,
      track: async task => task,
      logger: event => events.push(event),
    })
    const client = new Client({ name: 'handoff-test', version: '1' })
    cleanup.push(() => server.close(), () => client.close())
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
    return { client, application, events }
  }

  it('carries a Feed question and the exact subsequent reply through the context tool without a new request', async () => {
    const { client, application, events } = await fixture()
    application.request.mockResolvedValueOnce({ status: 'incomplete', stage: 'personal_context', ...questionPair })
    application.observeContext.mockResolvedValueOnce({ status: 'ignored', ...questionPair })

    const first = await client.callTool({ name: 'request', arguments: { currentText: '给我一次 Feed。' } })
    expect(first.isError).not.toBe(true)
    expect(first.structuredContent).toEqual({ status: 'incomplete', stage: 'personal_context', ...questionPair })
    expect(readable(first)).toContain('等待')
    expect(readable(first)).toContain(question)
    expect(readable(first)).not.toContain(continuationToken)

    const currentText = '\n  这一点我还没有想清楚。\t'
    const reply = await client.callTool({ name: 'observe_context', arguments: { currentText, continuationToken } })
    expect(reply.isError).not.toBe(true)
    expect(reply.structuredContent).toEqual({ status: 'ignored', ...questionPair })
    expect(readable(reply)).toContain(question)
    expect(application.observeContext).toHaveBeenCalledWith(
      { currentText, continuationToken }, expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    expect(application.request).toHaveBeenCalledTimes(1)
    expect(application.processFeedback).not.toHaveBeenCalled()
    expect(JSON.stringify(events)).not.toContain(currentText)
    expect(JSON.stringify(events)).not.toContain(question)
    expect(JSON.stringify(events)).not.toContain(continuationToken)
  })

  it.each([
    { status: 'one_link', url },
    { status: 'business_empty' },
    { status: 'incomplete', stage: 'source_window' },
  ] as const)('keeps the request result and remaining question visible for $status', async outcome => {
    const { client, application } = await fixture()
    application.request.mockResolvedValueOnce({ ...outcome, ...questionPair })
    const result = await client.callTool({ name: 'request', arguments: { currentText: '给我 Feed。' } })
    expect(result.isError).not.toBe(true)
    expect(result.structuredContent).toEqual({ ...outcome, ...questionPair })
    expect(readable(result)).toContain(question)
    expect(readable(result)).toContain(outcome.status === 'one_link' ? url
      : outcome.status === 'business_empty' ? '暂时没有' : 'source_window')
    expect(readable(result)).not.toContain(continuationToken)
  })

  it.each([
    { status: 'applied', appliedCount: 1 },
    { status: 'ignored' },
    { status: 'already_observed' },
    { status: 'incomplete', stage: 'context_observation' },
  ] as const)('preserves a context result with both a question and an actual Feed result for $status', async outcome => {
    const { client, application, events } = await fixture()
    const feed = { status: 'one_link', url } as const
    application.observeContext.mockResolvedValueOnce({ ...outcome, ...questionPair, feed })
    const result = await client.callTool({ name: 'observe_context', arguments: { currentText: '补充资料。' } })
    expect(result.isError).not.toBe(true)
    expect(result.structuredContent).toEqual({ ...outcome, ...questionPair, feed })
    expect(readable(result)).toContain(question)
    expect(readable(result)).toContain(url)
    expect(readable(result)).not.toContain(continuationToken)
    expect(application.request).not.toHaveBeenCalled()
    expect(JSON.stringify(events)).not.toContain(url)
    expect(JSON.stringify(events)).not.toContain(continuationToken)
  })

  it.each([
    { status: 'business_empty' },
    { status: 'incomplete', stage: 'source_window' },
    { status: 'incomplete', stage: 'judgement_execution' },
  ] as const)('does not hide a resumed $status result behind a successful update', async feed => {
    const { client, application } = await fixture()
    application.observeContext.mockResolvedValueOnce({ status: 'applied', appliedCount: 1, feed })
    const result = await client.callTool({ name: 'observe_context', arguments: { currentText: '补充资料。' } })
    expect(result.isError).not.toBe(true)
    expect(result.structuredContent).toEqual({ status: 'applied', appliedCount: 1, feed })
    expect(readable(result)).toContain('applied')
    expect(readable(result)).toContain(feed.status === 'business_empty' ? '暂时没有' : feed.stage)
    expect(application.request).not.toHaveBeenCalled()
  })

  it.each([
    { status: 'pass' },
    { status: 'completed' },
    { status: 'discarded' },
    { status: 'needs_input' },
    { status: 'incomplete', stage: 'feedback_interpretation' },
  ] as const)('preserves feedback $status, the remaining question, and the actual Feed result', async outcome => {
    const { client, application } = await fixture()
    const feed = { status: 'business_empty' } as const
    application.processFeedback.mockResolvedValueOnce({ ...outcome, ...questionPair, feed })
    const input = { currentText: '\n 不喜欢这种表达。 ', referenceText: '当前明确引用', continuationToken }
    const result = await client.callTool({ name: 'process_feedback', arguments: input })
    expect(result.isError).not.toBe(true)
    expect(result.structuredContent).toEqual({ ...outcome, ...questionPair, feed })
    expect(readable(result)).toContain(question)
    expect(readable(result)).toContain('暂时没有')
    expect(readable(result).split(question)).toHaveLength(2)
    expect(readable(result)).not.toContain(continuationToken)
    expect(application.processFeedback).toHaveBeenCalledWith(input, expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect(application.request).not.toHaveBeenCalled()
    expect(application.observeContext).not.toHaveBeenCalled()
  })

  it('keeps a standalone update standalone and an ordinary incomplete distinct from waiting', async () => {
    const { client, application } = await fixture()
    application.observeContext.mockResolvedValueOnce({ status: 'applied', appliedCount: 1 })
    const update = await client.callTool({ name: 'observe_context', arguments: { currentText: '明确更新。' } })
    expect(update.isError).not.toBe(true)
    expect(update.structuredContent).toEqual({ status: 'applied', appliedCount: 1 })
    expect(application.request).not.toHaveBeenCalled()

    application.request.mockResolvedValueOnce({ status: 'incomplete', stage: 'personal_context' })
    const incomplete = await client.callTool({ name: 'request', arguments: { currentText: '给我 Feed。' } })
    expect(incomplete.isError).not.toBe(true)
    expect(readable(incomplete)).toContain('未完成')
    expect(readable(incomplete)).not.toContain('等待')
  })

  it.each([
    ['request', { currentText: '回答。', continuationToken }],
    ['observe_context', { currentText: '回答。', continuationToken: 'short' }],
    ['observe_context', { currentText: '回答。', continuationToken: '!'.repeat(43) }],
    ['observe_context', { currentText: '回答。', continuationToken, chatId: 'not-allowed' }],
  ] as const)('rejects input outside the handoff contract for %s', async (name, input) => {
    const { client, application } = await fixture()
    const result = await client.callTool({ name, arguments: input })
    expect(result.isError).toBe(true)
    expect(application.request).not.toHaveBeenCalled()
    expect(application.observeContext).not.toHaveBeenCalled()
  })

  it.each([
    ['request', 'question without token', { status: 'business_empty', question }],
    ['request', 'token without question', { status: 'business_empty', continuationToken }],
    ['request', 'nested Feed on request', { status: 'business_empty', feed: { status: 'business_empty' } }],
    ['observeContext', 'short token', { status: 'ignored', question, continuationToken: 'short' }],
    ['observeContext', 'question without token', { status: 'ignored', question }],
    ['observeContext', 'token without question', { status: 'ignored', continuationToken }],
    ['observeContext', 'empty question', { status: 'ignored', question: '', continuationToken }],
    ['observeContext', 'unknown field', { status: 'ignored', ...questionPair, extra: true }],
    ['observeContext', 'nested question', { status: 'ignored', feed: { status: 'business_empty', ...questionPair } }],
    ['observeContext', 'recursive Feed', { status: 'ignored', feed: { status: 'business_empty', feed: { status: 'business_empty' } } }],
    ['observeContext', 'unknown Feed stage', { status: 'ignored', feed: { status: 'incomplete', stage: 'invented' } }],
    ['observeContext', 'new Feed status', { status: 'ignored', feed: { status: 'resumed' } }],
    ['processFeedback', 'missing needs_input pair', { status: 'needs_input' }],
    ['processFeedback', 'missing needs_input token', { status: 'needs_input', question }],
    ['processFeedback', 'question without token', { status: 'completed', question }],
    ['processFeedback', 'token without question', { status: 'completed', continuationToken }],
    ['recordFeedback', 'question on save', { status: 'saved', ...questionPair }],
    ['listSaved', 'Feed on saved list', { status: 'completed', items: [], feed: { status: 'business_empty' } }],
  ] as const)('rejects malformed output from %s: %s', async (operation, _reason, output) => {
    const { client, application } = await fixture()
    application[operation].mockResolvedValueOnce(output as never)
    const calls = {
      request: { name: 'request', arguments: { currentText: '请求。' } },
      observeContext: { name: 'observe_context', arguments: { currentText: '补充。' } },
      processFeedback: { name: 'process_feedback', arguments: { currentText: '反馈。' } },
      recordFeedback: { name: 'record_feedback', arguments: { operation: 'save', url } },
      listSaved: { name: 'list_saved', arguments: {} },
    }
    const result = await client.callTool(calls[operation])
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toBeUndefined()
    expect(readable(result)).not.toContain(continuationToken)
    expect(readable(result)).not.toContain('暂时没有')
  })
})

function readable(result: { content: unknown }): string {
  return (result.content as Array<{ text: string }>).map(block => block.text).join('\n')
}
