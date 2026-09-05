import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createPythonXObserver } from '../src/python-x-observer.ts'

describe('Python X observer adapter', () => {
  it('reports an incomplete window when an observed original has insufficient body', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'personal-feed-insufficient-'))
    const script = join(directory, 'fake-observer.mjs')
    await writeFile(script, `
const request = JSON.parse(process.argv[2]);
const occurrence = {sourceUrl: 'https://x.com/example/status/123', authorHandle: 'example', publishedAt: request.cutoff, occurrenceOrdinal: 0, capturedAt: request.cutoff, body: {kind: 'insufficient', reason: 'empty'}};
const surfaces = ['for_you', 'following', 'explore'].map((surface, index) => ({kind: 'complete', surface, surfaceOrdinal: index, startedAt: request.cutoff, completedAt: request.cutoff, occurrences: index === 0 ? [occurrence] : []}));
process.stdout.write(JSON.stringify({...request, kind: 'complete', startedAt: request.cutoff, completedAt: request.cutoff, surfaces}) + '\\n');
`)
    const observer = createPythonXObserver({ pythonBin: process.execPath, observerCliPath: script, timeoutMs: 2_000 })
    try {
      await expect(observer.observe({
        requestId: 'pf:00000000000000000000000000000001',
        cutoff: '2026-09-04T00:00:00.000Z',
        shanghaiDay: '2026-09-04',
        signal: new AbortController().signal,
      })).resolves.toEqual({ status: 'incomplete', stage: 'source_window' })
    } finally {
      await observer.close()
    }
  })

  it('uses a service-generated identity and flattens all three observed surfaces', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'personal-feed-observer-'))
    const script = join(directory, 'fake-observer.mjs')
    await writeFile(script, `
const request = JSON.parse(process.argv[2]);
const occurrence = (id, author) => ({sourceUrl: \`https://x.com/\${author}/status/\${id}\`, authorHandle: author, publishedAt: request.cutoff, occurrenceOrdinal: 0, capturedAt: request.cutoff, body: {kind: 'sufficient', text: \`body-\${id}\`}});
const faces = ['for_you', 'following', 'explore'].map((surface, index) => ({kind: 'complete', surface, surfaceOrdinal: index, startedAt: request.cutoff, completedAt: request.cutoff, occurrences: [occurrence(String(index + 1), 'author' + index)]}));
process.stdout.write(JSON.stringify({...request, kind: 'complete', startedAt: request.cutoff, completedAt: request.cutoff, surfaces: faces}) + '\\n');
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
})
