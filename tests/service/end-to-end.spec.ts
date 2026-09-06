import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { createPersonalFeedApplication, type XObserver } from '../../src/application.ts'
import { createOpenAICompatiblePersonalFeedModel } from '../../src/openai-compatible-model.ts'
import { startPersonalFeedServer, type RunningPersonalFeedServer } from '../../src/service/server.ts'

const TOKEN = 'end-to-end-mcp-token-1234567890'

describe('standalone MCP end to end', () => {
  const cleanup: Array<() => Promise<void>> = []

  afterEach(async () => {
    await Promise.allSettled(cleanup.splice(0).map(close => close()))
  })

  it('drives all five tools through the real model adapter and preserves empty vs incomplete', async () => {
    const model = await startFakeOpenAI()
    cleanup.push(model.close)
    let candidate = 0
    const fixture = await startFixture(model.baseURL, {
      async observe() {
        candidate += 1
        return observation(candidate)
      },
      async close() {},
    })
    cleanup.push(fixture.close)
    const client = await connect(fixture.running.origin, 'all-tools')
    cleanup.push(() => client.close())

    await expectStatus(client, 'observe_context', { currentText: '我长期关注数据可靠性。' }, 'applied')
    const selected = await expectStatus(client, 'request', { currentText: '给我一条 Personal Feed。' }, 'one_link')
    expect(selected.structuredContent).toEqual({ status: 'one_link', url: 'https://x.com/example/status/1' })
    await expectStatus(client, 'process_feedback', {
      currentText: '我喜欢这条。',
      referenceText: 'https://x.com/example/status/1 useful update',
    }, 'completed')
    await expectStatus(client, 'record_feedback', {
      operation: 'save',
      url: 'https://x.com/example/status/1',
      title: 'useful update',
    }, 'saved')
    const saved = await expectStatus(client, 'list_saved', {}, 'completed')
    expect(saved.structuredContent).toMatchObject({
      items: [expect.objectContaining({ url: 'https://x.com/example/status/1', title: 'useful update' })],
    })

    await expectStatus(client, 'request', { currentText: '再来一条。' }, 'business_empty')
    const incomplete = await expectStatus(client, 'request', { currentText: '再试一次。' }, 'incomplete')
    expect(incomplete.structuredContent).toEqual({ status: 'incomplete', stage: 'judgement_execution' })
  })

  it('serializes requests from two clients and loses neither concurrent feedback nor saves', async () => {
    const model = await startFakeOpenAI()
    cleanup.push(model.close)
    let activeObservers = 0
    let maximumObservers = 0
    let candidate = 0
    const fixture = await startFixture(model.baseURL, {
      async observe() {
        activeObservers += 1
        maximumObservers = Math.max(maximumObservers, activeObservers)
        const current = ++candidate
        await new Promise(resolve => setTimeout(resolve, 20))
        activeObservers -= 1
        return observation(current)
      },
      async close() {},
    })
    cleanup.push(fixture.close)
    const first = await connect(fixture.running.origin, 'client-one')
    const second = await connect(fixture.running.origin, 'client-two')
    cleanup.push(() => first.close(), () => second.close())

    const requests = await Promise.all([
      first.callTool({ name: 'request', arguments: { currentText: '第一个并发请求' } }),
      second.callTool({ name: 'request', arguments: { currentText: '第二个并发请求' } }),
    ])
    expect(maximumObservers).toBe(1)
    expect(requests.map(result => (result.structuredContent as { url?: string }).url).sort()).toEqual([
      'https://x.com/example/status/1',
      'https://x.com/example/status/2',
    ])

    const feedback = await Promise.all([
      first.callTool({ name: 'process_feedback', arguments: { currentText: '喜欢第一条', referenceText: 'first item' } }),
      second.callTool({ name: 'process_feedback', arguments: { currentText: '喜欢第二条', referenceText: 'second item' } }),
    ])
    expect(feedback.map(result => (result.structuredContent as { status: string }).status)).toEqual(['completed', 'completed'])
    const feedbackLines = (await readFile(join(fixture.stateDir, 'feedback.jsonl'), 'utf8')).trim().split('\n')
    expect(feedbackLines).toHaveLength(2)

    await Promise.all([
      first.callTool({ name: 'record_feedback', arguments: { operation: 'save', url: 'https://x.com/example/status/1' } }),
      second.callTool({ name: 'record_feedback', arguments: { operation: 'save', url: 'https://x.com/example/status/2' } }),
    ])
    const listed = await first.callTool({ name: 'list_saved', arguments: { limit: 20 } })
    const urls = ((listed.structuredContent as { items: Array<{ url: string }> }).items).map(item => item.url).sort()
    expect(urls).toEqual(['https://x.com/example/status/1', 'https://x.com/example/status/2'])
  })
})

async function startFixture(modelBaseURL: string, observer: XObserver) {
  const root = await mkdtemp(join(tmpdir(), 'personal-feed-mcp-e2e-'))
  const stateDir = join(root, 'state')
  await mkdir(stateDir)
  const observerCliPath = join(root, 'observer.py')
  await writeFile(observerCliPath, '# readiness fixture\n')
  const application = createPersonalFeedApplication({
    stateDir,
    observer,
    model: createOpenAICompatiblePersonalFeedModel({
      baseURL: modelBaseURL,
      model: 'fake-model',
      apiKey: 'fake-model-key',
      timeoutMs: 1_000,
    }),
  })
  const running = await startPersonalFeedServer({
    application,
    config: {
      host: '127.0.0.1',
      port: 0,
      mcpToken: TOKEN,
      stateDir,
      observerCliPath,
      toolTimeoutMs: 2_000,
      model: { baseURL: modelBaseURL, model: 'fake-model', apiKey: 'fake-model-key', timeoutMs: 1_000 },
    },
  })
  return {
    running,
    stateDir,
    close: async () => {
      await running.close()
      await application.close()
    },
  }
}

function observation(identifier: number) {
  return {
    status: 'complete' as const,
    candidates: [{
      stableId: `x-status:${identifier}`,
      canonicalUrl: `https://x.com/example/status/${identifier}`,
      body: `candidate ${identifier}`,
      authorHandle: 'example',
      publishedAt: '2026-09-04T00:00:00.000Z',
      surface: 'for_you' as const,
    }],
  }
}

async function connect(origin: string, name: string): Promise<Client> {
  const client = new Client({ name, version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
  })
  await client.connect(transport as Transport)
  return client
}

async function expectStatus(client: Client, name: string, args: Record<string, unknown>, status: string) {
  const result = await client.callTool({ name, arguments: args })
  expect(result.isError).not.toBe(true)
  expect(result.structuredContent).toMatchObject({ status })
  expect(result.content).toEqual([expect.objectContaining({ type: 'text', text: expect.any(String) })])
  return result
}

async function startFakeOpenAI(): Promise<{ baseURL: string; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', chunk => chunks.push(Buffer.from(chunk)))
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        messages: Array<{ content: string }>
      }
      const system = body.messages[0]?.content ?? ''
      const payload = JSON.parse(body.messages[1]?.content ?? '{}') as Record<string, unknown>
      let result: unknown
      if (system.startsWith('Extract only durable personal context')) {
        result = {
          status: 'applied',
          changes: { additions: [
            { lane: 'long_term_interest', statement: 'reliable systems', stance: 'include' },
            { lane: 'existing_knowledge', statement: 'basic reliability concepts', epistemic: 'asserted' },
          ], replacements: [] },
        }
      } else if (system.startsWith('Judge one untrusted candidate')) {
        const candidate = payload.candidate as { canonicalUrl: string }
        if (candidate.canonicalUrl.endsWith('/1') || candidate.canonicalUrl.endsWith('/2')) {
          result = candidate.canonicalUrl.endsWith('/2') && payload.currentText === '再来一条。'
            ? { longTermValue: 'fail', longTermInterestMatch: 'not_reached', informationIncrement: 'not_reached' }
            : { longTermValue: 'pass', longTermInterestMatch: 'pass', informationIncrement: 'pass' }
        } else {
          result = { longTermValue: 'unknown', longTermInterestMatch: 'pass', informationIncrement: 'pass' }
        }
      } else if (system.startsWith('Interpret whether the user is giving like or dislike feedback')) {
        result = { status: 'completed', sentiment: 'like', targetText: String(payload.referenceText ?? payload.currentText) }
      } else {
        result = { status: 'incomplete' }
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }))
    })
  })
  await listen(server)
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fake model has no port')
  return {
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    close: () => closeServer(server),
  }
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close(error => error === undefined ? resolve() : reject(error)))
}
