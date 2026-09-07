import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOpenAICompatiblePersonalFeedModel } from '../src/openai-compatible-model.ts'

const config = Object.freeze({
  baseURL: 'http://127.0.0.1:9999/v1',
  model: 'fake-model',
  apiKey: 'not-a-real-secret',
  timeoutMs: 1_000,
})

afterEach(() => vi.unstubAllGlobals())

describe('OpenAI-compatible model boundary', () => {
  it.each([
    { status: 'ignored', sufficient: true },
    { status: 'ignored', sufficient: false },
    { status: 'applied', changes: { additions: [], replacements: [] }, sufficient: true },
    { status: 'applied', changes: { additions: [], replacements: [] }, sufficient: false },
  ])('decodes Feed sufficiency in the same context response: %j', async response => {
    const currentText = '  I am new to caregiving; give me a Feed.\n'
    const activeFacts = [{ lane: 'long_term_interest', statement: 'caregiving', stance: 'include' }] as const
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ choices: [{ message: {
      content: JSON.stringify(response),
    } }] })))
    vi.stubGlobal('fetch', fetch)

    await expect(createOpenAICompatiblePersonalFeedModel(config).observeContext({
      currentText, activeFacts, assessForFeed: true, signal: new AbortController().signal,
    })).resolves.toEqual(response)
    expect(fetch).toHaveBeenCalledTimes(1)
    const body = JSON.parse(fetch.mock.calls[0]![1]!.body as string)
    expect(JSON.parse(body.messages[1].content)).toEqual({ currentText, activeFacts, assessForFeed: true })
  })

  it.each([
    { status: 'ignored' },
    { status: 'applied', changes: { additions: [], replacements: [] } },
    { status: 'ignored', sufficient: 'true' },
    { status: 'ignored', sufficient: null },
    { status: 'ignored', sufficient: true, guessed: true },
    { status: 'incomplete' },
  ])('does not default missing or invalid Feed sufficiency to true: %j', async response => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: {
      content: JSON.stringify(response),
    } }] }))))
    await expect(createOpenAICompatiblePersonalFeedModel(config).observeContext({
      currentText: 'Feed', activeFacts: [], assessForFeed: true, signal: new AbortController().signal,
    })).resolves.toEqual({ status: 'incomplete' })
  })

  it.each([
    ['pass', 'pass', 'pass', 'qualified'],
    ['fail', 'not_reached', 'not_reached', 'not_qualified'],
    ['pass', 'fail', 'not_reached', 'not_qualified'],
    ['pass', 'pass', 'fail', 'not_qualified'],
    ['pass', 'not_reached', 'not_reached', 'incomplete'],
    ['pass', 'pass', 'not_reached', 'incomplete'],
    ['unknown', 'not_reached', 'not_reached', 'incomplete'],
    ['pass', 'unknown', 'not_reached', 'incomplete'],
    ['pass', 'unknown', 'pass', 'qualified'],
    ['pass', 'unknown', 'unknown', 'qualified'],
    ['pass', 'unknown', 'fail', 'not_qualified'],
    ['pass', 'pass', 'unknown', 'qualified'],
    ['fail', 'pass', 'pass', 'incomplete'],
    ['pass', 'fail', 'pass', 'incomplete'],
  ])('decodes only a finished judgment: %s / %s / %s => %s', async (longTermValue, longTermInterestMatch, informationIncrement, status) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: {
      content: JSON.stringify({ longTermValue, longTermInterestMatch, informationIncrement }),
    } }] }))))
    await expect(createOpenAICompatiblePersonalFeedModel(config).judgeCandidate({
      currentText: 'Feed', personalContext: [],
      candidate: {
        stableId: 'x-status:1', canonicalUrl: 'https://x.com/fixture/status/1',
        body: 'Controlled material', authorHandle: 'fixture', publishedAt: '2026-09-06T00:00:00.000Z',
      },
      cutoff: '2026-09-06T00:00:00.000Z', shanghaiDay: '2026-09-06', signal: new AbortController().signal,
    })).resolves.toEqual({ status })
  })

  it('decodes explicit replacements and withdrawals without converting them to additions', async () => {
    const target = { lane: 'existing_knowledge', statement: 'All editing can be automated', epistemic: 'asserted' } as const
    const changes = {
      additions: [{ lane: 'long_term_interest', statement: 'editing', stance: 'include' }],
      replacements: [{ target, replacement: [
        { lane: 'existing_knowledge', statement: 'Simple edits can be automated', epistemic: 'asserted' },
        { lane: 'existing_knowledge', statement: 'Complex edits remain unclear', epistemic: 'uncertain' },
      ] }],
    }
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: {
      content: JSON.stringify({ status: 'applied', changes }),
    } }] }))))
    const model = createOpenAICompatiblePersonalFeedModel(config)
    await expect(model.observeContext({ currentText: 'Only simple edits; complex edits are unclear.', activeFacts: [target], signal: new AbortController().signal }))
      .resolves.toEqual({ status: 'applied', changes })

    changes.replacements[0]!.replacement = []
    await expect(model.observeContext({ currentText: 'Withdraw that claim.', activeFacts: [target], signal: new AbortController().signal }))
      .resolves.toEqual({ status: 'applied', changes })
  })

  it.each([
    { additions: [], replacements: [] },
    { additions: [{ lane: 'existing_knowledge', statement: 'I am new to caregiving', epistemic: 'asserted' }], replacements: [] },
  ])('accepts a complete change set without requiring a new fact', async changes => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: {
      content: JSON.stringify({ status: 'applied', changes }),
    } }] }))))
    await expect(createOpenAICompatiblePersonalFeedModel(config).observeContext({
      currentText: 'controlled user expression', activeFacts: [], signal: new AbortController().signal,
    })).resolves.toEqual({ status: 'applied', changes })
  })

  it.each([
    { status: 'applied', facts: [] },
    { status: 'applied', changes: { additions: [], replacements: [], replaceAll: true } },
    { status: 'applied', changes: { additions: [], replacements: [{ target: {}, replacement: [] }] } },
    { status: 'applied', changes: { additions: [{ lane: 'existing_knowledge', statement: 'claim', epistemic: 'guessed' }], replacements: [] } },
    { status: 'applied', changes: { additions: [], replacements: [{ target: { lane: 'existing_knowledge', statement: 'claim', epistemic: 'asserted' }, replacement: null }] } },
  ])('rejects malformed or legacy mutation output', async response => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: {
      content: JSON.stringify(response),
    } }] }))))
    await expect(createOpenAICompatiblePersonalFeedModel(config).observeContext({
      currentText: 'controlled user expression', activeFacts: [], signal: new AbortController().signal,
    })).resolves.toEqual({ status: 'incomplete' })
  })

  it('accepts one exact JSON payload', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: {
      content: '{"status":"ignored"}',
    } }] }), { status: 200, headers: { 'content-type': 'application/json' } })))
    const model = createOpenAICompatiblePersonalFeedModel(config)

    await expect(model.observeContext({
      currentText: 'hello', activeFacts: [], signal: new AbortController().signal,
    })).resolves.toEqual({ status: 'ignored' })
  })

  it('rejects fenced JSON instead of silently normalizing it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: {
      content: '```json\n{"status":"ignored"}\n```',
    } }] }), { status: 200, headers: { 'content-type': 'application/json' } })))
    const model = createOpenAICompatiblePersonalFeedModel(config)

    await expect(model.observeContext({
      currentText: 'hello', activeFacts: [], signal: new AbortController().signal,
    })).resolves.toEqual({ status: 'incomplete' })
  })
})

const clarification = { originalText: 'That claim is wrong.', referenceText: 'original item', question: 'Which scope?', unresolvedScope: 'scope' }
const remaining = { question: 'What about the other part?', unresolvedScope: 'other part' }
const emptyChanges = { additions: [], replacements: [] }
function wireResponse(response: unknown) {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(response) } }] })))
  vi.stubGlobal('fetch', fetch)
  return fetch
}
it('passes the original expression, reference, question and current facts through both interpretation boundaries', async () => {
  const contextResponse = { status: 'applied', changes: emptyChanges, remaining }
  const fetch = wireResponse(contextResponse)
  const model = createOpenAICompatiblePersonalFeedModel(config)
  const input = { currentText: 'reply', activeFacts: [], clarification, signal: new AbortController().signal }
  await expect(model.observeContext(input)).resolves.toEqual(contextResponse)
  expect(JSON.parse(JSON.parse(fetch.mock.calls[0]![1]!.body as string).messages[1].content)).toEqual({ currentText: 'reply', activeFacts: [], clarification })
  const feedbackResponse = { status: 'needs_input', changes: emptyChanges, remaining }
  const feedbackFetch = wireResponse(feedbackResponse)
  await expect(model.interpretFeedback({ ...input, referenceText: 'original item' })).resolves.toEqual(feedbackResponse)
  expect(JSON.parse(JSON.parse(feedbackFetch.mock.calls[0]![1]!.body as string).messages[1].content)).toEqual({ currentText: 'reply', activeFacts: [], referenceText: 'original item', clarification })
})
it.each([undefined, {}, '', { question: 'q' }, { question: 'q', unresolvedScope: '' }])('rejects missing/invalid continuation resolution: %j', async remaining => {
  const model = createOpenAICompatiblePersonalFeedModel(config)
  const input = { currentText: 'reply', activeFacts: [], clarification, signal: new AbortController().signal }
  wireResponse({ status: 'ignored', ...(remaining === undefined ? {} : { remaining }) })
  await expect(model.observeContext(input)).resolves.toEqual({ status: 'incomplete' })
  wireResponse({ status: 'pass', ...(remaining === undefined ? {} : { remaining }) })
  await expect(model.interpretFeedback(input)).resolves.toEqual({ status: 'incomplete' })
})
it('requires a stated dislike reason, and accepts explicit completion without adding facts', async () => {
  const model = createOpenAICompatiblePersonalFeedModel(config)
  const input = { currentText: 'dislike', activeFacts: [], signal: new AbortController().signal }
  wireResponse({ status: 'completed', sentiment: 'dislike', targetText: 'item', remaining: null })
  await expect(model.interpretFeedback(input)).resolves.toEqual({ status: 'incomplete' })
  const resolved = { status: 'completed', sentiment: 'dislike', targetText: 'item', reason: 'sensational style', remaining: null }
  wireResponse(resolved)
  await expect(model.interpretFeedback(input)).resolves.toEqual(resolved)
})

it('accepts an explicitly resolved reference for the next question in either interpreter', async () => {
  const model = createOpenAICompatiblePersonalFeedModel(config)
  const input = { currentText: 'post A', activeFacts: [], clarification: { originalText: 'dislike it', question: 'Which item?', unresolvedScope: 'target and reason' }, signal: new AbortController().signal }
  for (const [method, status] of [['observeContext', 'ignored'], ['interpretFeedback', 'needs_input']] as const) {
    const response = { status, resolvedReferenceText: 'post A', remaining }
    wireResponse(response)
    await expect(model[method](input)).resolves.toEqual(response)
    wireResponse({ ...response, resolvedReferenceText: '' })
    await expect(model[method](input)).resolves.toEqual({ status: 'incomplete' })
  }
})

describe('read-only background assessment', () => {
  it.each([true, false])('decodes semantic sufficiency=%s without interpretation fields', async sufficient => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ status: 'completed', sufficient }) } }] })))
    vi.stubGlobal('fetch', fetch)
    const activeFacts = [{ lane: 'existing_knowledge', statement: 'novice', epistemic: 'asserted' }] as const
    expect(await createOpenAICompatiblePersonalFeedModel(config).assessContext({ requestText: 'Template', activeFacts, signal: new AbortController().signal })).toEqual({ status: 'completed', sufficient })
    const wire = JSON.parse(fetch.mock.calls[0]![1]!.body as string)
    expect(JSON.parse(wire.messages[1].content)).toEqual({ requestText: 'Template', activeFacts })
    expect(wire.messages[0].content).toContain('never evidence about the user')
  })
  it.each([
    { status: 'completed' }, { status: 'completed', sufficient: 'true' },
    { status: 'completed', sufficient: true, changes: { additions: [], replacements: [] } },
    { status: 'completed', sufficient: true, remaining: null }, { status: 'ignored', sufficient: true }, { status: 'incomplete' },
  ])('rejects malformed or mutating assessment output: %j', async result => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }))))
    expect(await createOpenAICompatiblePersonalFeedModel(config).assessContext({ requestText: 'Feed', activeFacts: [], signal: new AbortController().signal })).toEqual({ status: 'incomplete' })
  })
})
