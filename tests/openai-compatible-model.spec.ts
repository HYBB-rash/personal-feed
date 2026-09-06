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
