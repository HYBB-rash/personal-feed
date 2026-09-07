import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { appendFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AddressInfo } from 'node:net'

export const BOUNDARY_CASES = [
  'partial_body_shortage',
  'single_judgement_failure',
  'whole_source_failure',
  'all_body_insufficient',
  'whole_judgement_failure',
  'empty_context_direct_discovery',
] as const
export type BoundaryCase = typeof BOUNDARY_CASES[number]
type Mode = BoundaryCase | 'recovered'
export const FIXTURE_REQUEST = '给我一次个人 Feed。'
// Controlled test data, never attributed to the user's actual interests or knowledge.
export const FIXTURE_FACTS = [
  { lane: 'long_term_interest', statement: 'Controlled fixture interest: agent systems', stance: 'include' },
  { lane: 'existing_knowledge', statement: 'Controlled fixture knowledge: basic agent loop', epistemic: 'asserted' },
] as const
export const RECOVERY_URL = 'https://x.com/fixture/status/202'

/** Isolated source and model controls only. Does not start or reconfigure a real service. */
export async function prepareBoundaryFixture(scenario: BoundaryCase) {
  const root = await mkdtemp(join(tmpdir(), 'personal-feed-v2-boundary-'))
  const stateDir = join(root, 'state')
  const modePath = join(root, 'mode.json')
  const observationEventsPath = join(root, 'observation-events.jsonl')
  const observerCliPath = join(root, 'observer.py')
  const modelEventsPath = join(root, 'model-events.jsonl')
  await mkdir(stateDir, { mode: 0o700 })
  const initialFacts = scenario === 'empty_context_direct_discovery' ? [] : FIXTURE_FACTS
  await writeFile(join(stateDir, 'personal-context.json'), JSON.stringify({ schemaVersion: 1, generation: 1, facts: initialFacts }), { mode: 0o600 })
  let mode: Mode = scenario
  const modelEvents: Array<{ operation: 'context' | 'judge'; mode: Mode; outcome: string }> = []
  const recordModelEvent = async (event: typeof modelEvents[number]) => {
    modelEvents.push(event)
    await appendFile(modelEventsPath, `${JSON.stringify(event)}\n`, { mode: 0o600 })
  }
  await writeFile(modePath, JSON.stringify(mode), { mode: 0o600 })
  await writeFile(observerCliPath, observerScript(modePath, observationEventsPath), { mode: 0o600 })
  const modelServer = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404).end(); return
    }
    try {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const wire = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { messages: Array<{ content: string }> }
      const payload = JSON.parse(wire.messages[1]!.content) as { activeFacts?: unknown[]; assessForFeed?: boolean; candidate?: { canonicalUrl?: string } }
      const operation = wire.messages[0]!.content.startsWith('Judge one') ? 'judge' : 'context'
      const judgementFailure = operation === 'judge' && (mode === 'whole_judgement_failure'
        || mode === 'single_judgement_failure' && payload.candidate?.canonicalUrl?.endsWith('/101') === true)
      if (judgementFailure) {
        await recordModelEvent({ operation, mode, outcome: 'http_503' })
        response.writeHead(503, { 'content-type': 'application/json' }).end('{}'); return
      }
      let content: unknown
      if (operation === 'judge') {
        content = { longTermValue: 'pass', longTermInterestMatch: 'pass', informationIncrement: 'pass' }
        await recordModelEvent({ operation, mode, outcome: 'qualified' })
      } else {
        const assessment = payload.assessForFeed ? { sufficient: true } : {}
        const prepared = JSON.stringify(payload.activeFacts) === JSON.stringify(FIXTURE_FACTS)
        content = prepared ? wire.messages[0]!.content.startsWith('Assess only the saved') ? { status: 'completed', sufficient: true } : { status: 'ignored', ...assessment } : { status: 'incomplete' }
        await recordModelEvent({ operation, mode, outcome: prepared ? 'success' : 'fixture_context_missing' })
      }
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }))
    } catch {
      response.writeHead(400, { 'content-type': 'application/json' }).end('{}')
    }
  })
  await new Promise<void>(resolve => modelServer.listen(0, '127.0.0.1', resolve))
  const modelPort = (modelServer.address() as AddressInfo).port
  const environment = {
    PERSONAL_FEED_HOST: '127.0.0.1',
    PERSONAL_FEED_STATE_DIR: stateDir,
    PERSONAL_FEED_OBSERVER_CLI: observerCliPath,
    PERSONAL_FEED_MCP_TOKEN: 'boundary-fixture-mcp-token',
    PERSONAL_FEED_MODEL_BASE_URL: `http://127.0.0.1:${modelPort}/v1`,
    PERSONAL_FEED_MODEL: 'boundary-fixture-model',
    PERSONAL_FEED_MODEL_API_KEY: 'boundary-fixture-model-key',
    PERSONAL_FEED_MODEL_TIMEOUT_MS: '2000',
    PERSONAL_FEED_TOOL_TIMEOUT_MS: '5000',
  }
  const environmentPath = join(root, 'environment.json')
  await writeFile(environmentPath, JSON.stringify(environment, null, 2), { mode: 0o600 })
  return {
    root, stateDir, environment, environmentPath, observationEventsPath, modelEventsPath, modelEvents,
    async recover() {
      mode = 'recovered'
      await writeFile(modePath, JSON.stringify(mode))
    },
    async observations(): Promise<Array<{ mode: Mode; kind: string; occurrences: number }>> {
      const raw = await readFile(observationEventsPath, 'utf8').catch(() => '')
      return raw.trim() === '' ? [] : raw.trim().split('\n').map(line => JSON.parse(line))
    },
    async close() {
      modelServer.closeAllConnections()
      await new Promise<void>((resolve, reject) => modelServer.close(error => error ? reject(error) : resolve()))
      await rm(root, { recursive: true, force: true })
    },
  }
}

/** Test-owned process via the production serve entry, never the user systemd instance. */
export async function startBoundaryService(fixture: Awaited<ReturnType<typeof prepareBoundaryFixture>>) {
  const reservation = createServer()
  await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve))
  const port = (reservation.address() as AddressInfo).port
  await new Promise<void>(resolve => reservation.close(() => resolve()))
  const logs: string[] = []
  const child = spawn(process.execPath, ['--experimental-strip-types', resolve('src/cli.ts'), 'serve'], {
    env: { PATH: process.env.PATH, HOME: fixture.root, LANG: 'C.UTF-8', ...fixture.environment, PERSONAL_FEED_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', chunk => logs.push(String(chunk)))
  child.stderr.on('data', chunk => logs.push(String(chunk)))
  const origin = `http://127.0.0.1:${port}`
  try {
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error('fixture service exited before health check')
      if (await fetch(`${origin}/healthz`).then(response => response.ok).catch(() => false)) {
        return { origin, logs, close: () => stopChild(child) }
      }
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    throw new Error('fixture service did not become healthy')
  } catch (error) {
    await stopChild(child)
    throw error
  }
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, 'exit')
  child.kill('SIGTERM')
  const fallback = setTimeout(() => child.kill('SIGKILL'), 7_000)
  try {
    const [code, signal] = await exited
    if (code !== 0 || signal !== null) throw new Error('fixture service did not stop normally')
  } finally { clearTimeout(fallback) }
}

function observerScript(modePath: string, eventsPath: string): string {
  return `import datetime, json, sys
request = json.loads(sys.argv[1])
with open(${JSON.stringify(modePath)}, encoding="utf8") as stream:
    mode = json.load(stream)
stamp = request["cutoff"]
published = (datetime.datetime.fromisoformat(stamp.replace("Z", "+00:00")) - datetime.timedelta(seconds=1)).isoformat(timespec="milliseconds").replace("+00:00", "Z")
def occurrence(identifier, body, ordinal):
    return {"occurrenceOrdinal": ordinal, "sourceUrl": "https://x.com/fixture/status/" + identifier, "authorHandle": "fixture", "publishedAt": published, "capturedAt": stamp, "body": body}
if mode == "whole_source_failure":
    kind = "incomplete"
    surfaces = [
        {"surface": "for_you", "surfaceOrdinal": 0, "kind": "failed"},
        {"surface": "following", "surfaceOrdinal": 1, "kind": "unknown"},
        {"surface": "explore", "surfaceOrdinal": 2, "kind": "failed"},
    ]
else:
    kind = "complete"
    if mode == "recovered":
        acquired = [occurrence("202", {"kind": "sufficient", "text": "Controlled recovered source text."}, 0)]
    elif mode == "partial_body_shortage":
        acquired = [
            occurrence("101", {"kind": "insufficient", "reason": "controlled missing body"}, 0),
            occurrence("102", {"kind": "sufficient", "text": "Controlled usable source text."}, 1),
        ]
    elif mode == "single_judgement_failure":
        acquired = [
            occurrence("101", {"kind": "sufficient", "text": "Controlled first source text."}, 0),
            occurrence("102", {"kind": "sufficient", "text": "Controlled second source text."}, 1),
        ]
    elif mode == "all_body_insufficient":
        acquired = [occurrence("101", {"kind": "insufficient", "reason": "controlled missing body"}, 0)]
    else:
        acquired = [occurrence("101", {"kind": "sufficient", "text": "Controlled source text."}, 0)]
    surfaces = [
        {"surface": "for_you", "surfaceOrdinal": 0, "kind": "complete", "startedAt": stamp, "completedAt": stamp, "occurrences": acquired},
        {"surface": "following", "surfaceOrdinal": 1, "kind": "natural_zero", "startedAt": stamp, "completedAt": stamp, "occurrences": []},
        {"surface": "explore", "surfaceOrdinal": 2, "kind": "natural_zero", "startedAt": stamp, "completedAt": stamp, "occurrences": []},
    ]
with open(${JSON.stringify(eventsPath)}, "a", encoding="utf8") as stream:
    stream.write(json.dumps({"mode": mode, "kind": kind, "occurrences": 0 if mode == "whole_source_failure" else len(acquired)}) + "\\n")
print(json.dumps({"schemaVersion": 1, "requestId": request["requestId"], "cutoff": request["cutoff"], "shanghaiDay": request["shanghaiDay"], "kind": kind, "startedAt": stamp, "completedAt": stamp, "surfaces": surfaces}))
`
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const scenario = process.argv[2]
  if (!BOUNDARY_CASES.includes(scenario as BoundaryCase)) throw new Error(`Expected one of: ${BOUNDARY_CASES.join(', ')}`)
  const fixture = await prepareBoundaryFixture(scenario as BoundaryCase)
  process.stdout.write(`${JSON.stringify({ scenario, helperPid: process.pid, root: fixture.root, environmentPath: fixture.environmentPath, modelEventsPath: fixture.modelEventsPath, observationEventsPath: fixture.observationEventsPath })}\n`)
  process.once('SIGUSR1', () => {
    void fixture.recover().then(() => process.stdout.write('Fixture recovered.\n'))
  })
  // The operator owns the temporary serve process; stop it before terminating this helper.
  await new Promise<void>(resolve => {
    process.once('SIGTERM', resolve)
    process.once('SIGINT', resolve)
  })
  await fixture.close()
}
