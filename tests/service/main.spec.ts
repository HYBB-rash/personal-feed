import { describe, expect, it } from 'vitest'
import { parseServiceEnvironment } from '../../src/main.ts'

describe('service environment', () => {
  it('uses the fixed loopback defaults and keeps the two credentials separate', () => {
    const parsed = parseServiceEnvironment({
      HOME: '/tmp/personal-feed-home',
      PERSONAL_FEED_MCP_TOKEN: 'mcp-token-1234567890',
      PERSONAL_FEED_MODEL_BASE_URL: 'http://127.0.0.1:18080/v1',
      PERSONAL_FEED_MODEL: 'fixture-model',
      PERSONAL_FEED_MODEL_API_KEY: 'model-key-1234567890',
      PERSONAL_FEED_OBSERVER_CLI: '/nix/store/observer.py',
    })
    expect(parsed.host).toBe('127.0.0.1')
    expect(parsed.port).toBe(43180)
    expect(parsed.toolTimeoutMs).toBe(300_000)
    expect(parsed.mcpToken).toBe('mcp-token-1234567890')
    expect(parsed.model.apiKey).toBe('model-key-1234567890')
    expect(parsed.stateDir).toBe('/tmp/personal-feed-home/.local/state/personal-feed')
  })

  it('refuses a non-loopback binding and missing independent credentials', () => {
    const base = {
      PERSONAL_FEED_MCP_TOKEN: 'mcp-token-1234567890',
      PERSONAL_FEED_MODEL_BASE_URL: 'http://127.0.0.1:18080/v1',
      PERSONAL_FEED_MODEL: 'fixture-model',
      PERSONAL_FEED_MODEL_API_KEY: 'model-key-1234567890',
    }
    expect(() => parseServiceEnvironment({ ...base, PERSONAL_FEED_HOST: '0.0.0.0' })).toThrow(/127\.0\.0\.1/)
    expect(() => parseServiceEnvironment({ ...base, PERSONAL_FEED_MCP_TOKEN: '' })).toThrow(/MCP token/i)
    expect(() => parseServiceEnvironment({ ...base, PERSONAL_FEED_MODEL_API_KEY: '' })).toThrow(/apiKey/i)
  })
})
