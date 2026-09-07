import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOpenAICompatiblePersonalFeedModel } from '../src/openai-compatible-model.ts'

const secret = 'private-user-model-response-token'
const config = { baseURL: 'http://127.0.0.1:1/private-url', model: 'fixture', apiKey: secret, timeoutMs: 1000 }
const input = { currentText: secret, activeFacts: [], assessForFeed: true as const, signal: new AbortController().signal }
const wire = (content: string) => new Response(JSON.stringify({ choices: [{ message: { content } }] }))
const context = (value: unknown) => wire(JSON.stringify(value))

afterEach(() => vi.unstubAllGlobals())

describe('private model failure diagnostics', () => {
  it.each([
    { value: { [secret]: secret }, result: { status: 'incomplete' }, reason: 'judgment_schema' },
    { value: { longTermValue: 'pass', longTermInterestMatch: 'not_reached', informationIncrement: 'not_reached' }, result: { status: 'incomplete' }, reason: 'judgment_schema' },
    { value: { longTermValue: 'unknown', longTermInterestMatch: 'not_reached', informationIncrement: 'not_reached' }, result: { status: 'incomplete' }, reason: 'judgment_unknown', detail: 'long_term_value' },
    { value: { longTermValue: 'pass', longTermInterestMatch: 'unknown', informationIncrement: 'unknown' }, result: { status: 'qualified' } },
    { value: { longTermValue: 'pass', longTermInterestMatch: 'pass', informationIncrement: 'unknown' }, result: { status: 'qualified' } },
  ])('distinguishes required judgment failures from allowed unknowns', async scenario => {
    vi.stubGlobal('fetch', vi.fn(async () => context(scenario.value)))
    const events: unknown[] = []
    const model = createOpenAICompatiblePersonalFeedModel(config, event => events.push(event))
    await expect(model.judgeCandidate({ requestText: secret, personalContext: [], cutoff: '2026-09-06T00:00:00.000Z',
      shanghaiDay: '2026-09-06', signal: new AbortController().signal,
      candidate: { stableId: 'x-status:1', canonicalUrl: 'https://x.com/fixture/status/1', body: secret,
        authorHandle: 'fixture', publishedAt: '2026-09-05T23:59:00.000Z' } })).resolves.toEqual(scenario.result)
    expect(events).toEqual('reason' in scenario ? [{ event: 'model_failure', operation: 'judge_candidate', reason: scenario.reason,
      ...('detail' in scenario ? { detail: scenario.detail } : {}) }] : [])
    expect(JSON.stringify(events)).not.toContain(secret)
    expect(JSON.stringify(events)).not.toContain('https://')
  })

  it.each([
    { reason: 'transport', respond: async () => { throw new Error(`${secret} ${config.baseURL}`) } },
    { reason: 'http_status', httpStatus: 429, respond: async () => new Response(secret, { status: 429 }) },
    { reason: 'response_json', respond: async () => new Response(secret) },
    { reason: 'response_shape', respond: async () => new Response(JSON.stringify({ choices: [], message: secret })) },
    { reason: 'content_json', respond: async () => wire('```json\n' + secret + '\n```') },
    { reason: 'sufficiency_invalid', respond: async () => context({ status: 'ignored', sufficient: secret }) },
    { reason: 'clarification_invalid', detail: 'remaining_shape', respond: async () => context({ status: 'ignored', sufficient: false, remaining: { question: secret } }) },
    { reason: 'context_schema', detail: 'changes_shape', respond: async () => context({ status: 'applied', sufficient: false, changes: { additions: secret } }) },
    { reason: 'model_incomplete', respond: async () => context({ status: 'incomplete' }) },
  ])('distinguishes $reason without exposing input, response or credentials', async scenario => {
    vi.stubGlobal('fetch', vi.fn(scenario.respond))
    const events: unknown[] = []
    const model = createOpenAICompatiblePersonalFeedModel(config, event => events.push(event))
    await expect(model.observeContext(input)).resolves.toEqual({ status: 'incomplete' })
    expect(events).toEqual([{
      event: 'model_failure', operation: 'observe_context', reason: scenario.reason,
      ...('httpStatus' in scenario ? { httpStatus: scenario.httpStatus } : {}),
      ...('detail' in scenario ? { detail: scenario.detail } : {}),
    }])
    expect(JSON.stringify(events)).not.toContain(secret)
    expect(JSON.stringify(events)).not.toContain(config.baseURL)
  })

  it.each([
    { detail: 'top_level', value: { status: 'ignored', sufficient: true, [secret]: secret } },
    { detail: 'additions', value: { status: 'applied', sufficient: true, changes: { additions: [secret], replacements: [] } } },
    { detail: 'replacement_shape', value: { status: 'applied', sufficient: true, changes: { additions: [], replacements: [secret] } } },
    { detail: 'replacement_target', value: { status: 'applied', sufficient: true, changes: { additions: [], replacements: [{ target: secret, replacement: [] }] } } },
    { detail: 'replacement_facts', value: { status: 'applied', sufficient: true, changes: { additions: [], replacements: [{ target: { lane: 'existing_knowledge', statement: secret, epistemic: 'asserted' }, replacement: secret }] } } },
  ])('locates $detail using only a fixed diagnostic code', async ({ detail, value }) => {
    vi.stubGlobal('fetch', vi.fn(async () => context(value)))
    const events: unknown[] = []
    await createOpenAICompatiblePersonalFeedModel(config, event => events.push(event)).observeContext(input)
    expect(events).toEqual([{ event: 'model_failure', operation: 'observe_context', reason: 'context_schema', detail }])
    expect(JSON.stringify(events)).not.toContain(secret)
  })

  it.each(['cancelled', 'timeout'] as const)('distinguishes %s from a network failure', async reason => {
    const caller = new AbortController()
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const signal = init!.signal as AbortSignal
      if (reason === 'cancelled') caller.abort(new Error(secret))
      await new Promise((_resolve, reject) => {
        if (signal.aborted) reject(signal.reason)
        else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
      throw new Error('unreachable')
    }))
    const events: unknown[] = []
    const model = createOpenAICompatiblePersonalFeedModel({ ...config, timeoutMs: 10 }, event => events.push(event))
    await expect(model.observeContext({ ...input, signal: caller.signal })).resolves.toEqual({ status: 'incomplete' })
    expect(events).toEqual([{ event: 'model_failure', operation: 'observe_context', reason }])
  })

  it.each([
    { detail: 'remaining_missing', extra: {} },
    { detail: 'remaining_shape', extra: { remaining: {} } },
    { detail: 'remaining_question', extra: { remaining: { question: null, unresolvedScope: secret } } },
    { detail: 'remaining_scope', extra: { remaining: { question: secret, unresolvedScope: null } } },
    { detail: 'resolved_reference', extra: { remaining: null, resolvedReferenceText: null } },
  ])('locates invalid continuation $detail without saving the response', async ({ detail, extra }) => {
    vi.stubGlobal('fetch', vi.fn(async () => context({ status: 'ignored', sufficient: false, ...extra })))
    const events: unknown[] = []
    await createOpenAICompatiblePersonalFeedModel(config, event => events.push(event)).observeContext({ ...input,
      clarification: { originalText: secret, question: secret, unresolvedScope: secret },
    })
    expect(events).toEqual([{ event: 'model_failure', operation: 'observe_context', reason: 'clarification_invalid', detail }])
    expect(JSON.stringify(events)).not.toContain(secret)
  })

  it('does not report a valid missing-information question as a failure', async () => {
    const response = { status: 'ignored', sufficient: false, remaining: { question: secret, unresolvedScope: secret } }
    vi.stubGlobal('fetch', vi.fn(async () => context(response)))
    const diagnostic = vi.fn()
    await expect(createOpenAICompatiblePersonalFeedModel(config, diagnostic).observeContext(input)).resolves.toEqual(response)
    expect(diagnostic).not.toHaveBeenCalled()
  })

  it('preserves the business result if the diagnostic sink throws', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(secret, { status: 503 })))
    await expect(createOpenAICompatiblePersonalFeedModel(config, () => { throw new Error(secret) }).observeContext(input))
      .resolves.toEqual({ status: 'incomplete' })
  })
})
