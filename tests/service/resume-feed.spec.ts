import { expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createPersonalFeedApplication } from '../../src/application.ts'
import { createOpenAICompatiblePersonalFeedModel } from '../../src/openai-compatible-model.ts'
import { createPersonalFeedMcpServer } from '../../src/service/mcp.ts'

it('continues a waiting Feed through real MCP, application, decoder and temporary storage', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'pf-d06-mcp-'))
  const interest = { lane: 'long_term_interest', statement: 'family care', stance: 'include' }
  const knowledge = { lane: 'existing_knowledge', statement: 'novice in family care', epistemic: 'asserted' }
  const gap = { question: 'What do you know about family care?', unresolvedScope: 'family-care knowledge' }
  const originalText = 'Give me a practical family-care Feed.'
  const responses = [
    { status: 'applied', changes: { additions: [interest], replacements: [] }, sufficient: false, remaining: gap },
    { status: 'ignored', sufficient: false, remaining: gap },
    { status: 'applied', changes: { additions: [knowledge], replacements: [] }, sufficient: true, remaining: null },
    { longTermValue: 'pass', longTermInterestMatch: 'pass', informationIncrement: 'pass' },
  ]
  const payloads: Record<string, unknown>[] = []
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    payloads.push(JSON.parse(JSON.parse(init.body).messages[1].content))
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(responses.shift()) } }] }))
  }))
  const url = 'https://x.com/fixture/status/100'
  const observer = { observe: vi.fn(async () => ({ status: 'complete' as const, candidates: [{ stableId: 'x-status:100', canonicalUrl: url, body: 'Home care guide', authorHandle: 'fixture', publishedAt: '2026-09-06T00:00:00.000Z' }] })), close: async () => {} }
  const app = createPersonalFeedApplication({ stateDir, observer, shutdownTimeoutMs: 5, model: createOpenAICompatiblePersonalFeedModel({ baseURL: 'http://127.0.0.1:9999/v1', model: 'fake', apiKey: 'fixture-secret', timeoutMs: 1000 }) })
  const logs: unknown[] = []
  const server = createPersonalFeedMcpServer({ application: app, logger: event => logs.push(event), track: async task => task, toolTimeoutMs: 1000 })
  const client = new Client({ name: 'd06-test', version: '1' })
  try {
    const [left, right] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(left), client.connect(right)])
    expect((await client.listTools()).tools.map(tool => tool.name).sort()).toEqual(['list_saved', 'observe_context', 'process_feedback', 'record_feedback', 'request'])
    const first = await client.callTool({ name: 'request', arguments: { currentText: originalText } })
    expect(first.isError).not.toBe(true)
    const pair = first.structuredContent as { continuationToken: string }
    expect(pair).toMatchObject({ status: 'incomplete', stage: 'personal_context', question: gap.question, continuationToken: expect.any(String) })
    const unclear = await client.callTool({ name: 'observe_context', arguments: { currentText: 'I am not sure.', continuationToken: pair.continuationToken } })
    expect(unclear.isError).not.toBe(true)
    const second = unclear.structuredContent as { continuationToken: string }
    expect(second).toMatchObject({ status: 'ignored', question: gap.question })
    expect(second).not.toHaveProperty('feed')
    expect(observer.observe).not.toHaveBeenCalled()
    const reply = await client.callTool({ name: 'observe_context', arguments: { currentText: 'I am a novice in family care.', continuationToken: second.continuationToken } })
    expect(reply.isError).not.toBe(true)
    expect(reply.structuredContent).toEqual({ status: 'applied', appliedCount: 1, feed: { status: 'one_link', url } })
    expect(payloads[3]).toMatchObject({ requestText: originalText, personalContext: [interest, knowledge] })
    expect(JSON.parse(await readFile(join(stateDir, 'personal-context.json'), 'utf8')).facts).toEqual([interest, knowledge])
    const stale = await client.callTool({ name: 'observe_context', arguments: { currentText: 'Repeat.', continuationToken: second.continuationToken } })
    expect(stale.isError).not.toBe(true)
    expect(stale.structuredContent).toEqual({ status: 'incomplete', stage: 'context_observation' })
    expect(observer.observe).toHaveBeenCalledTimes(1)
    for (const secret of [originalText, pair.continuationToken, second.continuationToken, gap.question, url, 'fixture-secret']) expect(JSON.stringify(logs)).not.toContain(secret)
  } finally {
    await client.close(); await server.close(); await app.close(); vi.unstubAllGlobals(); await rm(stateDir, { recursive: true, force: true })
  }
})
