import { afterEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createPersonalFeedMcpServer } from '../../src/service/mcp.ts'
import type { PersonalFeedApplicationPort, SafeLogEvent } from '../../src/service/contracts.ts'

const continuationToken = 'A'.repeat(43)
const question = '还有哪个适用范围需要澄清？'
const url = 'https://x.com/example/status/123'
const questionPair = { question, continuationToken }

describe('MCP closed-result boundary with a controlled application', () => {
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

  it.each([
    ['request', 'personal_context'],
    ['request', 'context_observation'],
    ['observeContext', 'context_observation'],
    ['processFeedback', 'feedback_interpretation'],
  ] as const)('preserves controlled interaction reasons for %s / %s', async (operation, stage) => {
    const { client, application } = await fixture()
    for (const reason of ['interaction_unavailable', 'interaction_declined', 'interaction_cancelled', 'interaction_timeout']) {
      application[operation].mockResolvedValueOnce({ status: 'incomplete', stage, reason } as never)
      const name = operation === 'observeContext' ? 'observe_context' : operation === 'processFeedback' ? 'process_feedback' : 'request'
      const result = await client.callTool({ name, arguments: { currentText: '输入' } })
      expect(result.isError).not.toBe(true)
      expect(result.structuredContent).toEqual({ status: 'incomplete', stage, reason })
      expect(readable(result)).not.toContain('用户拒绝')
    }
  })
  it.each([
    ['observation_failed', '获取来源失败'],
    ['partial_observation', '仅完成部分来源观察'],
    ['material_insufficient', '来源正文不足'],
  ] as const)('preserves source reason %s', async (reason, text) => {
    const { client, application } = await fixture()
    application.request.mockResolvedValueOnce({ status: 'incomplete', stage: 'source_window', reason })
    const result = await client.callTool({ name: 'request', arguments: { currentText: '输入' } })
    expect(result.isError).not.toBe(true)
    expect(readable(result)).toContain(text)
  })

  it('preserves every local limitation beside a usable link', async () => {
    const { client, application } = await fixture()
    application.request.mockResolvedValueOnce({
      status: 'one_link',
      url,
      limitations: ['partial_observation', 'material_insufficient', 'judgement_incomplete'],
    } as never)

    const result = await client.callTool({ name: 'request', arguments: { currentText: '输入' } })
    expect(result.isError).not.toBe(true)
    expect(result.structuredContent).toEqual({
      status: 'one_link',
      url,
      limitations: ['partial_observation', 'material_insufficient', 'judgement_incomplete'],
    })
    expect(readable(result)).toContain('部分来源')
    expect(readable(result)).toContain('部分正文不足')
    expect(readable(result)).toContain('部分内容判断未完成')
    expect(readable(result)).not.toContain('partial_observation')
  })
  it('retains the needs_input category without cross-call tokens', async () => {
    const { client, application } = await fixture()
    application.processFeedback.mockResolvedValueOnce({ status: 'needs_input', question })
    const result = await client.callTool({ name: 'process_feedback', arguments: { currentText: '输入' } })
    expect(result.isError).not.toBe(true)
    expect(result.structuredContent).toEqual({ status: 'needs_input', question })
  })
  it.each([
    ['request', 'context_observation' , '对本次信息的理解未完成'],
    ['request', 'personal_context', '个人信息准备未完成'],
    ['request', 'source_window', '来源观察未完成'],
    ['request', 'judgement_execution', '对内容是否符合条件的判断未完成'],
    ['request', 'conflict', '信息状态发生冲突，本次处理未完成'],
    ['request', 'shutdown', '本次请求已中止，处理未完成'],
    ['process_feedback', 'feedback_interpretation', '对本次反馈的理解未完成'],
    ['process_feedback', 'feedback_commit', '对本次反馈的保存未完成'],
  ] as const)('explains incomplete %s / %s in Chinese without exposing the internal stage', async (name, stage, message) => {
    const { client, application } = await fixture()
    const outcome = { status: 'incomplete', stage } as const
    if (name === 'request') application.request.mockResolvedValueOnce(outcome as never)
    else application.processFeedback.mockResolvedValueOnce(outcome as never)
    const result = await client.callTool({ name, arguments: { currentText: '本次请求或反馈。' } })
    expect(result.isError).not.toBe(true)
    expect(result.structuredContent).toEqual(outcome)
    expect(readable(result)).toContain(message)
    expect(readable(result)).not.toContain(stage)
    expect(readable(result)).not.toContain('暂时没有')
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
    ['request', 'request', { currentText: '请求。' }, 'shutdown'],
    ['observe_context', 'observeContext', { currentText: '补充。' }, 'context_observation'],
    ['process_feedback', 'processFeedback', { currentText: '反馈。' }, 'feedback_interpretation'],
  ] as const)('returns a normal incomplete when %s reaches its local tool deadline', async (name, operation, input, stage) => {
    const application = {
      request: vi.fn<PersonalFeedApplicationPort['request']>(async () => new Promise<never>(() => {})),
      observeContext: vi.fn<PersonalFeedApplicationPort['observeContext']>(async () => new Promise<never>(() => {})),
      processFeedback: vi.fn<PersonalFeedApplicationPort['processFeedback']>(async () => new Promise<never>(() => {})),
      recordFeedback: vi.fn<PersonalFeedApplicationPort['recordFeedback']>(async () => ({ status: 'saved' })),
      listSaved: vi.fn<PersonalFeedApplicationPort['listSaved']>(async () => ({ status: 'completed', items: [] })),
    }
    const server = createPersonalFeedMcpServer({ application, toolTimeoutMs: 10, track: async task => task })
    const client = new Client({ name: 'deadline-test', version: '1' })
    cleanup.push(() => server.close(), () => client.close())
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    const result = await client.callTool({ name, arguments: input }, undefined, { timeout: 500 })
    expect(result.isError).not.toBe(true)
    expect(result.structuredContent).toEqual({ status: 'incomplete', stage, reason: 'interaction_timeout' })
    expect(readable(result)).toContain('超时')
  })

  it.each([
    ['request', 'request', { currentText: '请求。' }, 'shutdown'],
    ['observe_context', 'observeContext', { currentText: '补充。' }, 'context_observation'],
    ['process_feedback', 'processFeedback', { currentText: '反馈。' }, 'feedback_interpretation'],
  ] as const)('maps an unclassified %s implementation fault to its normal incomplete stage', async (name, operation, input, stage) => {
    const { client, application } = await fixture()
    application[operation].mockRejectedValueOnce(new Error('controlled implementation fault'))
    const result = await client.callTool({ name, arguments: input })
    expect(result.isError).not.toBe(true)
    expect(result.structuredContent).toEqual({ status: 'incomplete', stage })
    expect(readable(result)).toContain('未完成')
  })

  it.each([
    ['record_feedback', { operation: 'save', url }, { status: 'saved' }],
    ['list_saved', {}, { status: 'completed', items: [] }],
  ] as const)('keeps a successful %s result when the diagnostic sink throws', async (name, input, expected) => {
    const throwing = createPersonalFeedMcpServer({
      application: {
        request: async () => ({ status: 'business_empty' }),
        observeContext: async () => ({ status: 'ignored' }),
        processFeedback: async () => ({ status: 'pass' }),
        recordFeedback: async () => ({ status: 'saved' }),
        listSaved: async () => ({ status: 'completed', items: [] }),
      },
      toolTimeoutMs: 1_000,
      track: async task => task,
      logger: () => { throw new Error('controlled diagnostic failure') },
    })
    const throwingClient = new Client({ name: 'throwing-log-test', version: '1' })
    cleanup.push(() => throwing.close(), () => throwingClient.close())
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([throwing.connect(serverTransport), throwingClient.connect(clientTransport)])

    const result = await throwingClient.callTool({ name, arguments: input })
    expect(result.isError).not.toBe(true)
    expect(result.structuredContent).toEqual(expected)
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
    ['request', 'reason on business empty', { status: 'business_empty', reason: 'observation_failed' }],
    ['request', 'reason on another stage', { status: 'incomplete', stage: 'personal_context', reason: 'observation_failed' }],
    ['request', 'unknown source reason', { status: 'incomplete', stage: 'source_window', reason: 'invented' }],
    ['observeContext', 'reason on outer update', { status: 'incomplete', stage: 'context_observation', reason: 'observation_failed' }],
    ['observeContext', 'reason on non-source feed', { status: 'ignored', feed: { status: 'incomplete', stage: 'judgement_execution', reason: 'observation_failed' } }],
    ['processFeedback', 'reason on outer feedback', { status: 'incomplete', stage: 'feedback_commit', reason: 'observation_failed' }],
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
    ['processFeedback', 'question without token', { status: 'completed', question }],
    ['processFeedback', 'token without question', { status: 'completed', continuationToken }],
    ['recordFeedback', 'question on save', { status: 'saved', ...questionPair }],
    ['listSaved', 'Feed on saved list', { status: 'completed', items: [], feed: { status: 'business_empty' } }],
  ] as const)('contains malformed output from %s: %s', async (operation, _reason, output) => {
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
    if (operation === 'request' || operation === 'observeContext' || operation === 'processFeedback') {
      expect(result.isError).not.toBe(true)
      expect(result.structuredContent).toEqual({
        status: 'incomplete',
        stage: operation === 'request' ? 'shutdown' : operation === 'observeContext' ? 'context_observation' : 'feedback_interpretation',
      })
    } else {
      expect(result.isError).toBe(true)
      expect(result.structuredContent).toBeUndefined()
    }
    expect(readable(result)).not.toContain(continuationToken)
    expect(readable(result)).not.toContain('暂时没有')
  })
})

function readable(result: { content: unknown }): string {
  return (result.content as Array<{ text: string }>).map(block => block.text).join('\n')
}
