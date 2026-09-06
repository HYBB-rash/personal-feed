import { expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createPersonalFeedApplication } from '../../src/application.ts'
import { createOpenAICompatiblePersonalFeedModel } from '../../src/openai-compatible-model.ts'
import { createPersonalFeedMcpServer } from '../../src/service/mcp.ts'

it('runs real MCP, application, decoder and storage through a partial clarification with safe logs', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'pf-d05-mcp-'))
  const fact = { lane: 'long_term_interest', statement: 'editing', stance: 'include' }
  const responses = [
    { status: 'applied', changes: { additions: [fact], replacements: [] }, remaining: { question: 'Which old claim?', unresolvedScope: 'old claim' } },
    { status: 'ignored', remaining: null },
    { status: 'needs_input', remaining: { question: 'Why dislike it?', unresolvedScope: 'reason' } },
    { status: 'completed', sentiment: 'dislike', targetText: 'https://x.com/fixture/status/1', reason: 'sensational style', remaining: null },
  ]
  const fetch = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(responses.shift()) } }] })))
  vi.stubGlobal('fetch', fetch)
  const observer = { observe: vi.fn(), close: async () => {} }
  const app = createPersonalFeedApplication({ stateDir, observer, shutdownTimeoutMs: 5, model: createOpenAICompatiblePersonalFeedModel({ baseURL: 'http://127.0.0.1:9999/v1', model: 'fake', apiKey: 'fixture-model-secret', timeoutMs: 1000 }) })
  const logs: unknown[] = []
  const server = createPersonalFeedMcpServer({ application: app, logger: event => logs.push(event), track: async task => task, toolTimeoutMs: 1000 })
  const client = new Client({ name: 'd05-test', version: '1' })
  try {
    const [left, right] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(left), client.connect(right)])
    expect((await client.listTools()).tools.map(tool => tool.name).sort()).toEqual(['list_saved', 'observe_context', 'process_feedback', 'record_feedback', 'request'])
    const first = await client.callTool({ name: 'observe_context', arguments: { currentText: 'I like editing but the old claim is unclear.' } })
    expect(first.isError).not.toBe(true)
    const pair = first.structuredContent as { question: string; continuationToken: string }
    expect(pair).toMatchObject({ status: 'applied', appliedCount: 1, question: 'Which old claim?', continuationToken: expect.any(String) })
    expect(JSON.parse(await readFile(join(stateDir, 'personal-context.json'), 'utf8')).facts).toEqual([fact])
    const reply = await client.callTool({ name: 'observe_context', arguments: { currentText: 'Leave that claim alone.', continuationToken: pair.continuationToken } })
    expect(reply.structuredContent).toEqual({ status: 'ignored' })
    const feedback = await client.callTool({ name: 'process_feedback', arguments: { currentText: 'I dislike it.', referenceText: 'https://x.com/fixture/status/1' } })
    const feedbackPair = feedback.structuredContent as { continuationToken: string }
    expect(feedback.structuredContent).toMatchObject({ status: 'needs_input', question: 'Why dislike it?' })
    const final = await client.callTool({ name: 'process_feedback', arguments: { currentText: 'Sensational style.', continuationToken: feedbackPair.continuationToken } })
    expect(final.structuredContent).toEqual({ status: 'completed' })
    const stale = await client.callTool({ name: 'process_feedback', arguments: { currentText: 'Repeat.', continuationToken: feedbackPair.continuationToken } })
    expect(stale.isError).not.toBe(true); expect(stale.structuredContent).toEqual({ status: 'incomplete', stage: 'feedback_interpretation' })
    expect(fetch).toHaveBeenCalledTimes(4); expect(observer.observe).not.toHaveBeenCalled()
    for (const secret of ['I like editing', pair.continuationToken, pair.question, 'https://x.com/fixture/status/1', feedbackPair.continuationToken, 'fixture-model-secret']) expect(JSON.stringify(logs)).not.toContain(secret)
  } finally {
    await client.close(); await server.close(); await app.close(); vi.unstubAllGlobals(); await rm(stateDir, { recursive: true, force: true })
  }
})
