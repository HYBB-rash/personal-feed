import { describe, expect, it } from 'vitest'
import { parseOpenAICompatibleConfig, resolveStateDir } from '../src/config.ts'

describe('standalone configuration', () => {
  it('uses the XDG state root without any host-runtime path', () => {
    expect(resolveStateDir({ XDG_STATE_HOME: '/tmp/example-state' })).toBe('/tmp/example-state/personal-feed')
    expect(resolveStateDir({ HOME: '/tmp/example-home' })).toBe('/tmp/example-home/.local/state/personal-feed')
  })

  it('requires the base OpenAI-compatible adapter fields and rejects unknown options', () => {
    expect(parseOpenAICompatibleConfig({
      baseURL: 'http://127.0.0.1:11434/v1/',
      model: 'local-model',
      apiKey: 'local-key',
      timeoutMs: 30_000,
    })).toEqual({
      baseURL: 'http://127.0.0.1:11434/v1',
      model: 'local-model',
      apiKey: 'local-key',
      timeoutMs: 30_000,
    })
    expect(() => parseOpenAICompatibleConfig({
      baseURL: 'http://127.0.0.1:11434/v1', model: 'local-model', apiKey: 'local-key', timeoutMs: 30_000, provider: 'extra',
    })).toThrow(/model config/u)
  })
})
