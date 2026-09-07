import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { expect, it } from 'vitest'

it('writes safe model diagnostics from the real serve entry while preserving the MCP result', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pf-model-log-'))
  const secret = 'fixture-private-text-and-key'
  const model = createServer((_request, response) => {
    response.writeHead(422, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { message: secret } }))
  })
  model.listen(0, '127.0.0.1')
  await once(model, 'listening')
  const modelPort = (model.address() as { port: number }).port
  const reservation = createServer()
  reservation.listen(0, '127.0.0.1')
  await once(reservation, 'listening')
  const port = (reservation.address() as { port: number }).port
  await new Promise<void>(resolve => reservation.close(() => resolve()))
  const observer = join(root, 'observer.py')
  await writeFile(observer, `import json, sys
r = json.loads(sys.argv[1]); t = r["cutoff"]
item = {"sourceUrl":"https://x.com/fixture/status/1","authorHandle":"fixture","publishedAt":t,"occurrenceOrdinal":0,"capturedAt":t,"body":{"kind":"sufficient","text":"controlled body"}}
faces = [{"surface":"for_you","surfaceOrdinal":0,"kind":"complete","startedAt":t,"completedAt":t,"occurrences":[item]}] + [{"surface":s,"surfaceOrdinal":i,"kind":"natural_zero","startedAt":t,"completedAt":t,"occurrences":[]} for i,s in enumerate(["following","explore"], 1)]
print(json.dumps({"schemaVersion":1,"requestId":r["requestId"],"cutoff":t,"shanghaiDay":r["shanghaiDay"],"kind":"complete","startedAt":t,"completedAt":t,"surfaces":faces}))
`)
  const token = 'fixture-mcp-token-1234567890'
  const child = spawn(process.execPath, [resolve('src/cli.ts'), 'serve'], {
    env: {
      HOME: root,
      PATH: process.env.PATH,
      LANG: 'C.UTF-8',
      PERSONAL_FEED_STATE_DIR: join(root, 'state'),
      PERSONAL_FEED_PORT: String(port),
      PERSONAL_FEED_MCP_TOKEN: token,
      PERSONAL_FEED_MODEL_BASE_URL: `http://127.0.0.1:${modelPort}`,
      PERSONAL_FEED_MODEL: 'fixture',
      PERSONAL_FEED_MODEL_API_KEY: secret,
      PERSONAL_FEED_OBSERVER_CLI: observer,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr!.on('data', chunk => { stderr += String(chunk) })
  const exited = once(child, 'exit')
  try {
    const origin = `http://127.0.0.1:${port}`
    const deadline = Date.now() + 3000
    let ready = false
    while (Date.now() < deadline && !ready) {
      ready = await fetch(`${origin}/readyz`).then(response => response.ok, () => false)
      if (!ready) await new Promise(resolve => setTimeout(resolve, 20))
    }
    expect(ready).toBe(true)
    const client = new Client({ name: 'diagnostics', version: '1' })
    await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}`, 'Personal-Feed-Mode': 'interactive' } },
    }))
    try {
      const result = await client.callTool({ name: 'request', arguments: { currentText: secret } })
      expect(result.isError).not.toBe(true)
      expect(result.structuredContent).toEqual({ status: 'incomplete', stage: 'judgement_execution' })
    } finally { await client.close() }
    const events = stderr.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line))
    expect(events).toContainEqual({ event: 'model_failure', operation: 'judge_candidate', reason: 'http_status', httpStatus: 422 })
    expect(stderr).not.toContain(secret)
    expect(stderr).not.toContain(token)
    expect(stderr).not.toContain(origin)
  } finally {
    child.kill('SIGTERM')
    const force = setTimeout(() => child.kill('SIGKILL'), 2000)
    await exited
    clearTimeout(force)
    await new Promise<void>(resolve => model.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
})
