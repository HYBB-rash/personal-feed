import { expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js'
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
  const client = new Client({ name: 'd05-test', version: '1' }, { capabilities: { elicitation: { form: {} } } })
  try {
    const [left, right] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(left), client.connect(right)])
    const onmessage = left.onmessage!
    left.onmessage = (message, extra) => onmessage(message, { ...extra, requestInfo: { headers: { 'personal-feed-mode': 'interactive' } } })
    expect((await client.listTools()).tools.map(tool => tool.name).sort()).toEqual(['list_saved', 'observe_context', 'process_feedback', 'record_feedback', 'request'])
    const answers = ['Leave that claim alone.', 'Sensational style.']
    client.setRequestHandler(ElicitRequestSchema, async () => ({ action: 'accept', content: { answer: answers.shift()! } }))
    const first = await client.callTool({ name: 'observe_context', arguments: { currentText: 'I like editing but the old claim is unclear.' } })
    expect(first.isError).not.toBe(true)
    expect(first.structuredContent).toEqual({ status: 'applied', appliedCount: 1 })
    expect(JSON.parse(await readFile(join(stateDir, 'personal-context.json'), 'utf8')).facts).toEqual([fact])
    const feedback = await client.callTool({ name: 'process_feedback', arguments: { currentText: 'I dislike it.', referenceText: 'https://x.com/fixture/status/1' } })
    expect(feedback.structuredContent).toEqual({ status: 'completed' })
    expect(fetch).toHaveBeenCalledTimes(4); expect(observer.observe).not.toHaveBeenCalled()
    for (const secret of ['I like editing', 'Which old claim?', 'https://x.com/fixture/status/1', 'fixture-model-secret']) expect(JSON.stringify(logs)).not.toContain(secret)
  } finally {
    await client.close(); await server.close(); await app.close(); vi.unstubAllGlobals(); await rm(stateDir, { recursive: true, force: true })
  }
})
