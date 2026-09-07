import { expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createPersonalFeedApplication } from '../../src/application.ts'
import { createOpenAICompatiblePersonalFeedModel } from '../../src/openai-compatible-model.ts'
import { createPersonalFeedMcpServer } from '../../src/service/mcp.ts'

it('discovers from empty context through real MCP without elicitation', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'pf-v0-mcp-'))
  const payloads: Record<string, unknown>[] = []
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    payloads.push(JSON.parse(JSON.parse(init.body).messages[1].content))
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      longTermValue: 'pass', longTermInterestMatch: 'pass', informationIncrement: 'pass',
    }) } }] }))
  }))
  const url = 'https://x.com/fixture/status/100'
  const observer = { observe: vi.fn(async () => ({ status: 'complete' as const, candidates: [{
    stableId: 'x-status:100', canonicalUrl: url, body: 'Home care guide', authorHandle: 'fixture', publishedAt: '2026-09-06T00:00:00.000Z',
  }] })), close: async () => {} }
  const app = createPersonalFeedApplication({ stateDir, observer, shutdownTimeoutMs: 5,
    model: createOpenAICompatiblePersonalFeedModel({ baseURL: 'http://127.0.0.1:9999/v1', model: 'fake', apiKey: 'fixture-secret', timeoutMs: 1000 }) })
  const server = createPersonalFeedMcpServer({ application: app, track: async task => task, toolTimeoutMs: 1000 })
  const client = new Client({ name: 'v0-test', version: '1' })
  try {
    const [left, right] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(left), client.connect(right)])
    const result = await client.callTool({ name: 'request', arguments: { currentText: 'Give me a practical family-care Feed.' } })
    expect(result.isError).not.toBe(true)
    expect(result.structuredContent).toEqual({ status: 'one_link', url })
    expect(payloads).toEqual([expect.objectContaining({ requestText: 'Give me a practical family-care Feed.', personalContext: [] })])
    expect(observer.observe).toHaveBeenCalledTimes(1)
  } finally {
    await client.close(); await server.close(); await app.close(); vi.unstubAllGlobals(); await rm(stateDir, { recursive: true, force: true })
  }
})

it('preserves the whole-call timeout while source work is pending', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'pf-timeout-mcp-'))
  const observer = {
    observe: vi.fn(async ({ signal }: { signal: AbortSignal }) => {
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
      return { status: 'incomplete' as const, stage: 'source_window' as const, reason: 'observation_failed' as const }
    }),
    close: async () => {},
  }
  const app = createPersonalFeedApplication({
    stateDir, observer,
    model: { assessContext: vi.fn(), observeContext: vi.fn(), judgeCandidate: vi.fn(), interpretFeedback: vi.fn() },
  })
  const server = createPersonalFeedMcpServer({ application: app, track: async task => task, toolTimeoutMs: 30 })
  const client = new Client({ name: 'real-timeout', version: '1' })
  try {
    const [left, right] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(left), client.connect(right)])
    const result = await client.callTool({ name: 'request', arguments: { currentText: 'feed' } })
    expect(result.isError).not.toBe(true)
    expect(result.structuredContent).toEqual({ status: 'incomplete', stage: 'shutdown', reason: 'interaction_timeout' })
    expect(observer.observe).toHaveBeenCalledTimes(1)
  } finally { await client.close(); await server.close(); await app.close(); await rm(stateDir, { recursive: true, force: true }) }
})
