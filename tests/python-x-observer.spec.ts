import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createPythonXObserver } from '../src/python-x-observer.ts'

async function waitForFile(path: string): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { return await readFile(path, 'utf8') } catch { await new Promise(resolve => setTimeout(resolve, 5)) }
  }
  throw new Error(`file did not appear: ${path}`)
}

describe('Python X observer adapter', () => {
  it('reports an incomplete window when an observed original has insufficient body', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'personal-feed-insufficient-'))
    const script = join(directory, 'fake-observer.mjs')
    await writeFile(script, `
const request = JSON.parse(process.argv[2]);
const occurrence = {sourceUrl: 'https://x.com/example/status/123', authorHandle: 'example', publishedAt: request.cutoff, occurrenceOrdinal: 0, capturedAt: request.cutoff, body: {kind: 'insufficient', reason: 'empty'}};
const surfaces = ['for_you', 'following', 'explore'].map((surface, index) => ({kind: index === 0 ? 'complete' : 'natural_zero', surface, surfaceOrdinal: index, startedAt: request.cutoff, completedAt: request.cutoff, occurrences: index === 0 ? [occurrence] : []}));
process.stdout.write(JSON.stringify({schemaVersion: 1, requestId: request.requestId, cutoff: request.cutoff, shanghaiDay: request.shanghaiDay, kind: 'complete', startedAt: request.cutoff, completedAt: request.cutoff, surfaces}) + '\\n');
`)
    const observer = createPythonXObserver({ pythonBin: process.execPath, observerCliPath: script, timeoutMs: 2_000 })
    try {
      await expect(observer.observe({
        requestId: 'pf:00000000000000000000000000000001',
        cutoff: '2026-09-04T00:00:00.000Z',
        shanghaiDay: '2026-09-04',
        signal: new AbortController().signal,
      })).resolves.toEqual({ status: 'incomplete', stage: 'source_window', reason: 'material_insufficient' })
    } finally {
      await observer.close()
    }
  })

  it('distinguishes partial observation from an observation that failed before any page completed', async () => {
    const cases = [
      {
        name: 'partial observation',
        result: {
          kind: 'incomplete',
          surfaces: [
            { surface: 'for_you', surfaceOrdinal: 0, kind: 'partial' },
            { surface: 'following', surfaceOrdinal: 1, kind: 'unknown' },
            { surface: 'explore', surfaceOrdinal: 2, kind: 'failed' },
          ],
        },
        reason: 'partial_observation',
      },
      {
        name: 'failed observation',
        result: {
          kind: 'incomplete',
          surfaces: [
            { surface: 'for_you', surfaceOrdinal: 0, kind: 'failed' },
            { surface: 'following', surfaceOrdinal: 1, kind: 'unknown' },
            { surface: 'explore', surfaceOrdinal: 2, kind: 'failed' },
          ],
        },
        reason: 'observation_failed',
      },
      {
        name: 'declared incomplete despite complete-looking pages',
        result: {
          kind: 'incomplete',
          surfaces: [
            { surface: 'for_you', surfaceOrdinal: 0, kind: 'complete' },
            { surface: 'following', surfaceOrdinal: 1, kind: 'natural_zero' },
            { surface: 'explore', surfaceOrdinal: 2, kind: 'complete' },
          ],
        },
        reason: 'partial_observation',
      },
    ] as const

    for (const testCase of cases) {
      const directory = await mkdtemp(join(tmpdir(), 'personal-feed-observer-reason-'))
      const script = join(directory, 'fake-observer.mjs')
      await writeFile(script, `
const request = JSON.parse(process.argv[2]);
const result = ${JSON.stringify(testCase.result)};
process.stdout.write(JSON.stringify({...result, schemaVersion: 1, requestId: request.requestId, cutoff: request.cutoff, shanghaiDay: request.shanghaiDay, startedAt: request.cutoff, completedAt: request.cutoff}) + '\\n');
`)
      const observer = createPythonXObserver({ pythonBin: process.execPath, observerCliPath: script, timeoutMs: 2_000 })
      try {
        await expect(observer.observe({
          requestId: 'pf:00000000000000000000000000000001',
          cutoff: '2026-09-04T00:00:00.000Z',
          shanghaiDay: '2026-09-04',
          signal: new AbortController().signal,
        })).resolves.toEqual({ status: 'incomplete', stage: 'source_window', reason: testCase.reason })
      } finally {
        await observer.close()
      }
    }
  })

  it('uses a service-generated identity and flattens all three observed surfaces', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'personal-feed-observer-'))
    const script = join(directory, 'fake-observer.mjs')
    await writeFile(script, `
const request = JSON.parse(process.argv[2]);
const occurrence = (id, author) => ({sourceUrl: \`https://x.com/\${author}/status/\${id}\`, authorHandle: author, publishedAt: request.cutoff, occurrenceOrdinal: 0, capturedAt: request.cutoff, body: {kind: 'sufficient', text: \`body-\${id}\`}});
const faces = ['for_you', 'following', 'explore'].map((surface, index) => ({kind: 'complete', surface, surfaceOrdinal: index, startedAt: request.cutoff, completedAt: request.cutoff, occurrences: [occurrence(String(index + 1), 'author' + index)]}));
process.stdout.write(JSON.stringify({schemaVersion: 1, requestId: request.requestId, cutoff: request.cutoff, shanghaiDay: request.shanghaiDay, kind: 'complete', startedAt: request.cutoff, completedAt: request.cutoff, surfaces: faces}) + '\\n');
`, { mode: 0o700 })
    const observer = createPythonXObserver({ pythonBin: process.execPath, observerCliPath: script, timeoutMs: 2_000 })
    const result = await observer.observe({
      requestId: 'pf:00000000000000000000000000000001',
      cutoff: '2026-09-04T00:00:00.000Z',
      shanghaiDay: '2026-09-04',
      signal: new AbortController().signal,
    })

    expect(result).toMatchObject({
      status: 'complete',
      candidates: [
        { stableId: 'x-status:1', surface: 'for_you' },
        { stableId: 'x-status:2', surface: 'following' },
        { stableId: 'x-status:3', surface: 'explore' },
      ],
    })
    await observer.close()
  })

  it('accepts three natural-zero pages and passes candidates through in source order', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'personal-feed-observer-empty-'))
    const script = join(directory, 'fake-observer.mjs')
    await writeFile(script, `
const request = JSON.parse(process.argv[2]);
const occurrence = (id, author, body, surfaceOrdinal, occurrenceOrdinal) => ({sourceUrl: \`https://x.com/\${author}/status/\${id}\`, authorHandle: author, publishedAt: request.cutoff, occurrenceOrdinal, capturedAt: request.cutoff, body: {kind: 'sufficient', text: body}});
const surfaces = [
  {kind: 'complete', surface: 'for_you', surfaceOrdinal: 0, startedAt: request.cutoff, completedAt: request.cutoff, occurrences: [occurrence('10', 'alice', 'first', 0, 0), occurrence('11', 'alice', 'second', 0, 1)]},
  {kind: 'natural_zero', surface: 'following', surfaceOrdinal: 1, startedAt: request.cutoff, completedAt: request.cutoff, occurrences: []},
  {kind: 'complete', surface: 'explore', surfaceOrdinal: 2, startedAt: request.cutoff, completedAt: request.cutoff, occurrences: [occurrence('10', 'alice', 'duplicate across pages', 2, 0)]},
];
process.stdout.write(JSON.stringify({schemaVersion: 1, requestId: request.requestId, cutoff: request.cutoff, shanghaiDay: request.shanghaiDay, kind: 'complete', startedAt: request.cutoff, completedAt: request.cutoff, surfaces}) + '\\n');
`)
    const observer = createPythonXObserver({ pythonBin: process.execPath, observerCliPath: script, timeoutMs: 2_000 })
    try {
      await expect(observer.observe({
        requestId: 'pf:00000000000000000000000000000001',
        cutoff: '2026-09-04T00:00:00.000Z',
        shanghaiDay: '2026-09-04',
        signal: new AbortController().signal,
      })).resolves.toEqual({
        status: 'complete',
        candidates: [
          { stableId: 'x-status:10', canonicalUrl: 'https://x.com/alice/status/10', body: 'first', authorHandle: 'alice', publishedAt: '2026-09-04T00:00:00.000Z', surface: 'for_you' },
          { stableId: 'x-status:11', canonicalUrl: 'https://x.com/alice/status/11', body: 'second', authorHandle: 'alice', publishedAt: '2026-09-04T00:00:00.000Z', surface: 'for_you' },
          { stableId: 'x-status:10', canonicalUrl: 'https://x.com/alice/status/10', body: 'duplicate across pages', authorHandle: 'alice', publishedAt: '2026-09-04T00:00:00.000Z', surface: 'explore' },
        ],
      })
    } finally {
      await observer.close()
    }
  })

  it('rejects malformed completion structure even when an earlier body is insufficient', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'personal-feed-observer-invalid-'))
    const script = join(directory, 'fake-observer.mjs')
    await writeFile(script, `
const request = JSON.parse(process.argv[2]);
const occurrence = {sourceUrl: 'https://x.com/example/status/123', authorHandle: 'example', publishedAt: request.cutoff, occurrenceOrdinal: 0, capturedAt: request.cutoff, body: {kind: 'insufficient', reason: 'empty'}};
const surfaces = [
  {kind: 'complete', surface: 'for_you', surfaceOrdinal: 0, startedAt: request.cutoff, completedAt: request.cutoff, occurrences: [occurrence]},
  {kind: 'failed', surface: 'following', surfaceOrdinal: 1, startedAt: request.cutoff, completedAt: request.cutoff, occurrences: []},
  {kind: 'natural_zero', surface: 'explore', surfaceOrdinal: 2, startedAt: request.cutoff, completedAt: request.cutoff, occurrences: []},
];
process.stdout.write(JSON.stringify({schemaVersion: 1, requestId: request.requestId, cutoff: request.cutoff, shanghaiDay: request.shanghaiDay, kind: 'complete', startedAt: request.cutoff, completedAt: request.cutoff, surfaces}) + '\\n');
`)
    const observer = createPythonXObserver({ pythonBin: process.execPath, observerCliPath: script, timeoutMs: 2_000 })
    try {
      await expect(observer.observe({
        requestId: 'pf:00000000000000000000000000000001',
        cutoff: '2026-09-04T00:00:00.000Z',
        shanghaiDay: '2026-09-04',
        signal: new AbortController().signal,
      })).resolves.toEqual({ status: 'incomplete', stage: 'source_window', reason: 'observation_failed' })
    } finally {
      await observer.close()
    }
  })

  it('rejects a page whose occurrence ordinal does not match its array position', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'personal-feed-observer-ordinal-'))
    const script = join(directory, 'fake-observer.mjs')
    await writeFile(script, `
const request = JSON.parse(process.argv[2]);
const occurrence = {sourceUrl: 'https://x.com/example/status/123', authorHandle: 'example', publishedAt: request.cutoff, occurrenceOrdinal: 1, capturedAt: request.cutoff, body: {kind: 'sufficient', text: 'body'}};
const surfaces = ['for_you', 'following', 'explore'].map((surface, surfaceOrdinal) => ({kind: 'complete', surface, surfaceOrdinal, startedAt: request.cutoff, completedAt: request.cutoff, occurrences: [occurrence]}));
process.stdout.write(JSON.stringify({schemaVersion: 1, requestId: request.requestId, cutoff: request.cutoff, shanghaiDay: request.shanghaiDay, kind: 'complete', startedAt: request.cutoff, completedAt: request.cutoff, surfaces}) + '\\n');
`)
    const observer = createPythonXObserver({ pythonBin: process.execPath, observerCliPath: script, timeoutMs: 2_000 })
    try {
      await expect(observer.observe({
        requestId: 'pf:00000000000000000000000000000001',
        cutoff: '2026-09-04T00:00:00.000Z',
        shanghaiDay: '2026-09-04',
        signal: new AbortController().signal,
      })).resolves.toEqual({ status: 'incomplete', stage: 'source_window', reason: 'observation_failed' })
    } finally {
      await observer.close()
    }
  })

  it('rejects a sufficient occurrence whose body is empty', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'personal-feed-observer-empty-body-'))
    const script = join(directory, 'fake-observer.mjs')
    await writeFile(script, `
const request = JSON.parse(process.argv[2]);
const occurrence = {sourceUrl: 'https://x.com/example/status/123', authorHandle: 'example', publishedAt: request.cutoff, occurrenceOrdinal: 0, capturedAt: request.cutoff, body: {kind: 'sufficient', text: '   '}};
const surfaces = ['for_you', 'following', 'explore'].map((surface, surfaceOrdinal) => ({kind: 'complete', surface, surfaceOrdinal, startedAt: request.cutoff, completedAt: request.cutoff, occurrences: [occurrence]}));
process.stdout.write(JSON.stringify({schemaVersion: 1, requestId: request.requestId, cutoff: request.cutoff, shanghaiDay: request.shanghaiDay, kind: 'complete', startedAt: request.cutoff, completedAt: request.cutoff, surfaces}) + '\\n');
`)
    const observer = createPythonXObserver({ pythonBin: process.execPath, observerCliPath: script, timeoutMs: 2_000 })
    try {
      await expect(observer.observe({
        requestId: 'pf:00000000000000000000000000000001',
        cutoff: '2026-09-04T00:00:00.000Z',
        shanghaiDay: '2026-09-04',
        signal: new AbortController().signal,
      })).resolves.toEqual({ status: 'incomplete', stage: 'source_window', reason: 'observation_failed' })
    } finally {
      await observer.close()
    }
  })

  it('does not trust a completion with missing, duplicate, or empty complete pages', async () => {
    const cases = [
      {
        name: 'missing page',
        surfaces: [
          {kind: 'natural_zero', surface: 'for_you', surfaceOrdinal: 0, occurrences: []},
          {kind: 'natural_zero', surface: 'following', surfaceOrdinal: 1, occurrences: []},
        ],
      },
      {
        name: 'duplicate page',
        surfaces: [
          {kind: 'natural_zero', surface: 'for_you', surfaceOrdinal: 0, occurrences: []},
          {kind: 'natural_zero', surface: 'for_you', surfaceOrdinal: 1, occurrences: []},
          {kind: 'natural_zero', surface: 'explore', surfaceOrdinal: 2, occurrences: []},
        ],
      },
      {
        name: 'empty complete page',
        surfaces: [
          {kind: 'complete', surface: 'for_you', surfaceOrdinal: 0, occurrences: []},
          {kind: 'natural_zero', surface: 'following', surfaceOrdinal: 1, occurrences: []},
          {kind: 'natural_zero', surface: 'explore', surfaceOrdinal: 2, occurrences: []},
        ],
      },
    ] as const
    for (const testCase of cases) {
      const directory = await mkdtemp(join(tmpdir(), 'personal-feed-observer-pages-'))
      const script = join(directory, 'fake-observer.mjs')
      await writeFile(script, `
const request = JSON.parse(process.argv[2]);
const surfaces = ${JSON.stringify(testCase.surfaces)}.map(face => ({...face, startedAt: request.cutoff, completedAt: request.cutoff}));
process.stdout.write(JSON.stringify({schemaVersion: 1, requestId: request.requestId, cutoff: request.cutoff, shanghaiDay: request.shanghaiDay, kind: 'complete', startedAt: request.cutoff, completedAt: request.cutoff, surfaces}) + '\\n');
`)
      const observer = createPythonXObserver({ pythonBin: process.execPath, observerCliPath: script, timeoutMs: 2_000 })
      try {
        await expect(observer.observe({
          requestId: 'pf:00000000000000000000000000000001',
          cutoff: '2026-09-04T00:00:00.000Z',
          shanghaiDay: '2026-09-04',
          signal: new AbortController().signal,
        })).resolves.toEqual({ status: 'incomplete', stage: 'source_window', reason: 'observation_failed' })
      } finally {
        await observer.close()
      }
    }
  })

  it('maps process failure, malformed output, timeout, and cancellation to observation_failed', async () => {
    const cases = [
      { name: 'process failure', source: 'process.exit(7);' },
      { name: 'malformed output', source: "process.stdout.write('not-json\\n');" },
    ] as const
    for (const testCase of cases) {
      const directory = await mkdtemp(join(tmpdir(), 'personal-feed-observer-process-'))
      const script = join(directory, 'fake-observer.mjs')
      await writeFile(script, testCase.source)
      const observer = createPythonXObserver({ pythonBin: process.execPath, observerCliPath: script, timeoutMs: 2_000 })
      try {
        await expect(observer.observe({
          requestId: 'pf:00000000000000000000000000000001',
          cutoff: '2026-09-04T00:00:00.000Z',
          shanghaiDay: '2026-09-04',
          signal: new AbortController().signal,
        })).resolves.toEqual({ status: 'incomplete', stage: 'source_window', reason: 'observation_failed' })
      } finally {
        await observer.close()
      }
    }

    const timeoutDirectory = await mkdtemp(join(tmpdir(), 'personal-feed-observer-timeout-'))
    const timeoutScript = join(timeoutDirectory, 'fake-observer.cjs')
    await writeFile(timeoutScript, "const fs = require('node:fs'); const path = require('node:path'); const request = JSON.parse(process.argv[2]); fs.writeFileSync(path.join(process.env.PERSONAL_FEED_STATE_DIR, 'started'), String(process.pid)); setTimeout(() => { const surfaces = ['for_you', 'following', 'explore'].map((surface, surfaceOrdinal) => ({kind: 'natural_zero', surface, surfaceOrdinal, startedAt: request.cutoff, completedAt: request.cutoff, occurrences: []})); process.stdout.write(JSON.stringify({schemaVersion: 1, requestId: request.requestId, cutoff: request.cutoff, shanghaiDay: request.shanghaiDay, kind: 'complete', startedAt: request.cutoff, completedAt: request.cutoff, surfaces}) + '\\n'); }, 1_000);")
    const timeoutObserver = createPythonXObserver({
      pythonBin: process.execPath, observerCliPath: timeoutScript, stateDir: timeoutDirectory, timeoutMs: 200,
    })
    const timeoutPending = timeoutObserver.observe({
      requestId: 'pf:00000000000000000000000000000001',
      cutoff: '2026-09-04T00:00:00.000Z',
      shanghaiDay: '2026-09-04',
      signal: new AbortController().signal,
    })
    expect(await waitForFile(join(timeoutDirectory, 'started'))).toMatch(/^[0-9]+$/u)
    await expect(timeoutPending).resolves.toEqual({ status: 'incomplete', stage: 'source_window', reason: 'observation_failed' })
    await timeoutObserver.close()

    const directory = await mkdtemp(join(tmpdir(), 'personal-feed-observer-cancel-'))
    const script = join(directory, 'fake-observer.cjs')
    await writeFile(script, "const fs = require('node:fs'); const path = require('node:path'); const stop = path.join(process.env.PERSONAL_FEED_STATE_DIR, 'stopped'); process.on('SIGTERM', () => { fs.writeFileSync(stop, 'stopped'); process.exit(0); }); fs.writeFileSync(path.join(process.env.PERSONAL_FEED_STATE_DIR, 'started'), String(process.pid)); setTimeout(() => {}, 1_000);")
    const observer = createPythonXObserver({ pythonBin: process.execPath, observerCliPath: script, stateDir: directory, timeoutMs: 2_000 })
    const controller = new AbortController()
    const pending = observer.observe({
      requestId: 'pf:00000000000000000000000000000001',
      cutoff: '2026-09-04T00:00:00.000Z',
      shanghaiDay: '2026-09-04',
      signal: controller.signal,
    })
    await waitForFile(join(directory, 'started'))
    controller.abort()
    await expect(pending).resolves.toEqual({ status: 'incomplete', stage: 'source_window', reason: 'observation_failed' })
    await observer.close()
    await expect(waitForFile(join(directory, 'stopped'))).resolves.toBe('stopped')
  })

  it('accepts serialization produced by the real Python observer and CLI fixtures', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'personal-feed-observer-production-'))
    const wrapperSource = (mode: string): string => `
import io
import json
import sys

sys.path.insert(0, ${JSON.stringify(join(process.cwd(), 'python'))})
from test_x_personal_feed_observer import _FakeBrowser, _FakeClock, _FakeEvaluator, _FakeLock, _body_item, _plans_for_empty, _plans_for_snapshot, _invoke
import x_personal_feed_observer
import x_personal_feed_observer_cli

mode = ${JSON.stringify(mode)}
request = json.loads(sys.argv[1])
clock = _FakeClock()
browser = _FakeBrowser(clock)
lock = _FakeLock()
if mode == 'empty':
    evaluator = _FakeEvaluator(clock, plans=_plans_for_empty())
elif mode == 'success':
    item = _body_item('https://x.com/alice/status/901', body='production body')
    evaluator = _FakeEvaluator(clock, plans=_plans_for_snapshot({'items': [item], 'cards': [item], 'explicitEmpty': False}))
elif mode == 'partial':
    item = _body_item('https://x.com/alice/status/902', body='production partial')
    plans = _plans_for_snapshot({'items': [item], 'cards': [item], 'explicitEmpty': False})
    plans[('for_you', 'snapshot')] = [plans[('for_you', 'snapshot')][0], RuntimeError('snapshot_failed')]
    evaluator = _FakeEvaluator(clock, plans=plans)
else:
    raise AssertionError(mode)
observed = _invoke(x_personal_feed_observer, clock, browser, lock, evaluator)
output = io.StringIO()
x_personal_feed_observer_cli.run_cli(bytes(json.dumps(request), 'utf-8'), stdout=output, observer=lambda _deadline: observed)
sys.stdout.write(output.getvalue())
`
    const request = {
      schemaVersion: 1,
      requestId: 'pf:00000000000000000000000000000001',
      cutoff: '2026-09-01T00:00:00.000Z',
      shanghaiDay: '2026-09-01',
      deadlineEpochMs: 1_100_000,
    }
    const expected = {
      success: {
        status: 'complete',
        candidates: [{
          stableId: 'x-status:901', canonicalUrl: 'https://x.com/alice/status/901', body: 'production body',
          authorHandle: 'alice', publishedAt: '2026-09-01T00:00:00.000Z', surface: 'for_you',
        }, {
          stableId: 'x-status:901', canonicalUrl: 'https://x.com/alice/status/901', body: 'production body',
          authorHandle: 'alice', publishedAt: '2026-09-01T00:00:00.000Z', surface: 'following',
        }, {
          stableId: 'x-status:901', canonicalUrl: 'https://x.com/alice/status/901', body: 'production body',
          authorHandle: 'alice', publishedAt: '2026-09-01T00:00:00.000Z', surface: 'explore',
        }],
      },
      empty: { status: 'complete', candidates: [] },
      partial: { status: 'incomplete', stage: 'source_window', reason: 'partial_observation' },
    } as const
    for (const mode of ['success', 'empty', 'partial'] as const) {
      const wrapper = join(directory, `${mode}-wrapper.py`)
      await writeFile(wrapper, wrapperSource(mode))
      const observer = createPythonXObserver({ pythonBin: 'python3', observerCliPath: wrapper, timeoutMs: 2_000 })
      await expect(observer.observe({
        requestId: request.requestId,
        cutoff: request.cutoff,
        shanghaiDay: request.shanghaiDay,
        signal: new AbortController().signal,
      }), mode).resolves.toEqual(expected[mode])
      await observer.close()
    }
  })
})
