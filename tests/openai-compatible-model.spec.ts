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
