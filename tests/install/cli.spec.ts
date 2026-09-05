import { describe, expect, it, vi } from 'vitest'
import { runPersonalFeedCli } from '../../src/cli.ts'

describe('personal-feed CLI routing', () => {
  it('requires an explicit check or apply mode for installation', async () => {
    await expect(runPersonalFeedCli(['service', 'install'], fixture())).rejects.toThrow(/--check.*--apply/)
    await expect(runPersonalFeedCli(['service', 'install', '--check', '--apply'], fixture())).rejects.toThrow(/exactly one/)
  })

  it('routes service checks without widening them to apply', async () => {
    const dependencies = fixture()
    await expect(runPersonalFeedCli(['service', 'install', '--check'], dependencies)).resolves.toBe(0)
    expect(dependencies.installService).toHaveBeenCalledWith(expect.objectContaining({ mode: 'check' }))
  })

  it('never prints MCP or model credentials in installation output', async () => {
    const lines: string[] = []
    const dependencies = fixture({ write: line => lines.push(line) })
    await runPersonalFeedCli(['service', 'install', '--check'], dependencies)
    expect(lines.join('\n')).not.toContain('mcp-secret-1234567890')
    expect(lines.join('\n')).not.toContain('model-secret-1234567890')
  })
})

function fixture(overrides: Partial<Parameters<typeof runPersonalFeedCli>[1]> = {}) {
  return {
    environment: {
      HOME: '/tmp/personal-feed-cli-home',
      PERSONAL_FEED_MCP_TOKEN: 'mcp-secret-1234567890',
      PERSONAL_FEED_MODEL_BASE_URL: 'http://127.0.0.1:18080/v1',
      PERSONAL_FEED_MODEL: 'fixture-model',
      PERSONAL_FEED_MODEL_API_KEY: 'model-secret-1234567890',
    },
    cwd: () => '/tmp/personal-feed-source',
    installService: vi.fn(async () => ({ changed: false, actions: ['service plan'] })),
    rollbackService: vi.fn(async () => undefined),
    serve: vi.fn(async () => undefined),
    write: vi.fn(),
    ...overrides,
  }
}
