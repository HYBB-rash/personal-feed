import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseOpenAICompatibleConfig } from '../src/config.ts'
import { parseServiceEnvironment } from '../src/main.ts'
import { createOpenAICompatiblePersonalFeedModel } from '../src/openai-compatible-model.ts'

const config = { baseURL: 'http://127.0.0.1:9999/v1', model: 'fixture', apiKey: 'fixture-secret', timeoutMs: 1000,
  responseFormat: 'strict_tool' as const }
const fact = { lane: 'existing_knowledge', statement: 'I know editing basics.', epistemic: 'asserted' } as const
const context = { currentText: 'I know editing basics.', activeFacts: [], assessForFeed: true,
  clarification: { originalText: 'Feed', question: 'What do you know?', unresolvedScope: 'editing knowledge' },
  signal: new AbortController().signal } as const
const applied = { status: 'applied', changes: { additions: [fact], replacements: [] }, sufficient: true, remaining: null }
const call = (result: unknown) => ({ type: 'function', function: { name: 'emit_personal_feed_result', arguments: JSON.stringify({ result }) } })
const wire = (message: unknown) => new Response(JSON.stringify({ choices: [{ message }] }))
afterEach(() => vi.unstubAllGlobals())

describe('explicit strict model output', () => {
  it('accepts the optional config and passes the environment choice through', () => {
    expect(parseOpenAICompatibleConfig(config)).toEqual(config)
    expect(parseServiceEnvironment({ PERSONAL_FEED_MODEL_BASE_URL: config.baseURL, PERSONAL_FEED_MODEL: config.model,
      PERSONAL_FEED_MODEL_API_KEY: config.apiKey, PERSONAL_FEED_MCP_TOKEN: 'fixture-mcp-token',
      PERSONAL_FEED_MODEL_RESPONSE_FORMAT: 'strict_tool' }).model.responseFormat).toBe('strict_tool')
    expect(() => parseOpenAICompatibleConfig({ ...config, responseFormat: 'guessed' })).toThrow()
  })

  it('constrains a continuation and decodes its explicit changes without a second model call', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => wire({ content: null, tool_calls: [call(applied)] }))
    vi.stubGlobal('fetch', fetch)
    await expect(createOpenAICompatiblePersonalFeedModel(config).observeContext(context)).resolves.toEqual(applied)
    expect(fetch).toHaveBeenCalledTimes(1)
    const body = JSON.parse(fetch.mock.calls[0]![1]!.body as string)
    expect(body.tools).toHaveLength(1)
    expect(body.tools[0].function.strict).toBe(true)
    expect(body.tool_choice).toBe('auto')
    expect(body.thinking).toBeUndefined()
    const variants = body.tools[0].function.parameters.properties.result.anyOf
    const success = variants.filter((v: any) => v.properties.status.enum[0] !== 'incomplete')
    expect(success.length).toBeGreaterThan(0)
    for (const variant of success) expect(variant.required).toEqual(expect.arrayContaining(['remaining', 'sufficient']))
    const visit = (value: any): void => {
      if (value === null || typeof value !== 'object') return
      if (value.type === 'object') {
        expect(value.additionalProperties).toBe(false)
        expect([...value.required].sort()).toEqual(Object.keys(value.properties).sort())
      }
      Object.values(value).forEach(visit)
    }
    visit(body.tools[0].function.parameters)
  })

  it.each([
    { content: JSON.stringify(applied) },
    { content: null, tool_calls: [] },
    { content: null, tool_calls: [call(applied), call(applied)] },
    { content: null, tool_calls: [{ type: 'function', function: { name: 'unexpected', arguments: '{}' } }] },
    { content: null, tool_calls: [{ type: 'function', function: { name: 'emit_personal_feed_result', arguments: '{' } }] },
  ])('does not fall back to unconstrained content or execute unexpected calls: %j', async message => {
    const fetch = vi.fn(async () => wire(message))
    vi.stubGlobal('fetch', fetch)
    await expect(createOpenAICompatiblePersonalFeedModel(config).observeContext(context)).resolves.toEqual({ status: 'incomplete' })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('still rejects malformed semantic fields from a provider claiming strict output', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => wire({ content: null, tool_calls: [call({ ...applied,
      changes: { additions: [{ ...fact, epistemic: 'guessed' }], replacements: [] } })] })))
    await expect(createOpenAICompatiblePersonalFeedModel(config).observeContext(context)).resolves.toEqual({ status: 'incomplete' })
  })

  it('uses the same constrained boundary for feedback and candidate judgment', async () => {
    const feedback = { status: 'completed', sentiment: 'dislike', targetText: 'The referenced item', reason: 'Too vague', remaining: null }
    vi.stubGlobal('fetch', vi.fn(async () => wire({ content: null, tool_calls: [call(feedback)] })))
    const model = createOpenAICompatiblePersonalFeedModel(config)
    await expect(model.interpretFeedback({ ...context, referenceText: 'The referenced item' })).resolves.toEqual(feedback)
    vi.stubGlobal('fetch', vi.fn(async () => wire({ content: null, tool_calls: [call({ longTermValue: 'pass', longTermInterestMatch: 'pass', informationIncrement: 'pass' })] })))
    await expect(model.judgeCandidate({ requestText: 'Feed', personalContext: [], cutoff: '2026-09-06T00:00:00.000Z',
      shanghaiDay: '2026-09-06', signal: new AbortController().signal, candidate: { stableId: 'x-status:1',
        canonicalUrl: 'https://x.com/fixture/status/1', body: 'Fixture source', authorHandle: 'fixture', publishedAt: '2026-09-05T23:59:00.000Z' } })).resolves.toEqual({ status: 'qualified' })
  })
})

it('constrains read-only assessment to two closed results with no fact or question output', async () => {
  const result = { status: 'completed', sufficient: false }
  const fetch = vi.fn<typeof globalThis.fetch>(async () => wire({ content: null, tool_calls: [call(result)] }))
  vi.stubGlobal('fetch', fetch)
  expect(await createOpenAICompatiblePersonalFeedModel(config).assessContext({ requestText: 'Scheduled Feed', activeFacts: [fact], signal: new AbortController().signal })).toEqual(result)
  const body = JSON.parse(fetch.mock.calls[0]![1]!.body as string)
  const variants = body.tools[0].function.parameters.properties.result.anyOf
  expect(variants).toHaveLength(2)
  expect(variants.map((v: any) => v.required)).toEqual([['status'], ['status', 'sufficient']])
  for (const variant of variants) expect(variant.additionalProperties).toBe(false)
})
