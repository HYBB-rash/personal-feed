import { createHash } from 'node:crypto'
import { appendFile, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  createPersonalFeedApplication,
  type PersonalFeedModel,
  type XObserver,
} from '../src/application.ts'
import { createPythonXObserver } from '../src/python-x-observer.ts'

async function fixture(overrides: Partial<{
  model: PersonalFeedModel
  observer: XObserver
}> = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), 'personal-feed-core-'))
  const model: PersonalFeedModel = overrides.model ?? {
    observeContext: vi.fn(async () => ({
      status: 'applied' as const,
      facts: [
        { lane: 'long_term_interest' as const, statement: 'agent systems', stance: 'include' as const },
        { lane: 'existing_knowledge' as const, statement: 'I know the basic agent loop', epistemic: 'asserted' as const },
      ],
    })),
    judgeCandidate: vi.fn(async () => ({ status: 'qualified' as const })),
    interpretFeedback: vi.fn(async () => ({ status: 'pass' as const })),
  }
  const observer: XObserver = overrides.observer ?? {
    observe: vi.fn(async () => ({
      status: 'complete' as const,
      candidates: [{
        stableId: 'x-status:123',
        canonicalUrl: 'https://x.com/example/status/123',
        body: 'A concrete update about agent systems.',
        authorHandle: 'example',
        publishedAt: '2026-09-04T01:00:00.000Z',
      }],
    })),
    close: vi.fn(async () => undefined),
  }
  const app = createPersonalFeedApplication({ stateDir, model, observer })
  return { app, stateDir, model, observer }
}

describe('PersonalFeedApplication public contract', () => {
  it('observes the current user text once and returns one qualified link', async () => {
    const { app, model, observer } = await fixture()

    const currentText = '  我长期关注 agent systems  '
    const result = await app.request({ currentText })

    expect(result).toEqual({ status: 'one_link', url: 'https://x.com/example/status/123' })
    expect(model.observeContext).toHaveBeenCalledTimes(1)
    expect(model.observeContext).toHaveBeenCalledWith(expect.objectContaining({ currentText }))
    expect(observer.observe).toHaveBeenCalledTimes(1)
    await app.close()
  })

  it('keeps business-empty distinct from model and source incompletes', async () => {
    const empty = await fixture({ observer: {
      observe: vi.fn(async () => ({ status: 'complete' as const, candidates: [] })),
      close: vi.fn(async () => undefined),
    } })
    await expect(empty.app.request({ currentText: '我长期关注 agent systems' })).resolves.toEqual({ status: 'business_empty' })
    await empty.app.close()

    const incomplete = await fixture({ observer: {
      observe: vi.fn(async () => ({ status: 'incomplete' as const, stage: 'source_window' as const, reason: 'observation_failed' as const })),
      close: vi.fn(async () => undefined),
    } })
    await expect(incomplete.app.request({ currentText: '我长期关注 agent systems' })).resolves.toEqual({
      status: 'incomplete', stage: 'source_window',
    })
    await incomplete.app.close()
  })

  it('keeps adapter incompletes out of candidate judgment while allowing a real empty result', async () => {
    const cases = [
      {
        name: 'natural empty',
        result: {
          kind: 'complete',
          surfaces: ['for_you', 'following', 'explore'].map((surface, surfaceOrdinal) => ({
            kind: 'natural_zero', surface, surfaceOrdinal, startedAt: '2026-09-04T00:00:00.000Z',
            completedAt: '2026-09-04T00:00:00.000Z', occurrences: [],
          })),
        },
        expected: { status: 'business_empty' },
      },
      {
        name: 'insufficient material',
        result: {
          kind: 'complete',
          surfaces: [
            {
              kind: 'complete', surface: 'for_you', surfaceOrdinal: 0,
              startedAt: '2026-09-04T00:00:00.000Z', completedAt: '2026-09-04T00:00:00.000Z',
              occurrences: [{
                sourceUrl: 'https://x.com/example/status/123', authorHandle: 'example',
                publishedAt: '2026-09-04T00:00:00.000Z', occurrenceOrdinal: 0,
                capturedAt: '2026-09-04T00:00:00.000Z', body: { kind: 'insufficient', reason: 'empty' },
              }],
            },
            ...['following', 'explore'].map((surface, surfaceOrdinal) => ({
              kind: 'natural_zero', surface, surfaceOrdinal: surfaceOrdinal + 1,
              startedAt: '2026-09-04T00:00:00.000Z', completedAt: '2026-09-04T00:00:00.000Z', occurrences: [],
            })),
          ],
        },
        expected: { status: 'incomplete', stage: 'source_window' },
      },
      {
        name: 'failed material',
        result: {
          kind: 'incomplete',
          surfaces: [
            { surface: 'for_you', surfaceOrdinal: 0, kind: 'failed' },
            { surface: 'following', surfaceOrdinal: 1, kind: 'unknown' },
            { surface: 'explore', surfaceOrdinal: 2, kind: 'failed' },
          ],
        },
        expected: { status: 'incomplete', stage: 'source_window' },
      },
    ] as const

    for (const testCase of cases) {
      const directory = await mkdtemp(join(tmpdir(), 'personal-feed-application-adapter-'))
      const script = join(directory, 'fake-observer.mjs')
      await writeFile(script, `
const request = JSON.parse(process.argv[2]);
const result = ${JSON.stringify(testCase.result)};
process.stdout.write(JSON.stringify({...result, schemaVersion: 1, requestId: request.requestId, cutoff: request.cutoff, shanghaiDay: request.shanghaiDay, startedAt: request.cutoff, completedAt: request.cutoff}) + '\\n');
`)
      const observer = createPythonXObserver({ pythonBin: process.execPath, observerCliPath: script, timeoutMs: 2_000 })
      const entry = await fixture({ observer })
      await expect(entry.app.request({ currentText: '我长期关注 agent systems' })).resolves.toEqual(testCase.expected)
      expect(entry.model.judgeCandidate).not.toHaveBeenCalled()
      await entry.app.close()
    }
  })

  it('requires both long-term-interest and existing-knowledge context lanes', async () => {
    const model: PersonalFeedModel = {
      observeContext: vi.fn(async () => ({
        status: 'applied',
        facts: [{ lane: 'long_term_interest', statement: 'agent systems', stance: 'include' }],
      })),
      judgeCandidate: vi.fn(async () => ({ status: 'qualified' })),
      interpretFeedback: vi.fn(async () => ({ status: 'pass' })),
    }
    const { app, observer } = await fixture({ model })

    await expect(app.request({ currentText: '我长期关注 agent systems' })).resolves.toEqual({
      status: 'incomplete', stage: 'personal_context',
    })
    expect(observer.observe).not.toHaveBeenCalled()
    await app.close()
  })

  it('passes the exact current user text through the direct context tool', async () => {
    const { app, model } = await fixture()
    const currentText = '\n 我已经了解基础原理。 \t'

    await expect(app.observeContext({ currentText })).resolves.toMatchObject({ status: 'applied' })
    expect(model.observeContext).toHaveBeenCalledWith(expect.objectContaining({ currentText }))
    await app.close()
  })

  it('updates an interest when the user returns to an earlier statement', async () => {
    const { app } = await fixture({ model: {
      observeContext: async ({ currentText }) => currentText === 'Feed'
        ? { status: 'ignored' }
        : { status: 'applied', facts: [
          { lane: 'long_term_interest', statement: 'agents', stance: currentText === '不再关注 agents' ? 'exclude' : 'include' },
          { lane: 'existing_knowledge', statement: 'basic agent loop', epistemic: 'asserted' },
        ] },
      judgeCandidate: async ({ personalContext }) => ({
        status: personalContext.some(fact => fact.lane === 'long_term_interest' && fact.stance === 'include')
          ? 'qualified' : 'not_qualified',
      }),
      interpretFeedback: async () => ({ status: 'pass' }),
    } })

    try {
      await app.observeContext({ currentText: '关注 agents' })
      await app.observeContext({ currentText: '不再关注 agents' })
      await app.observeContext({ currentText: '关注 agents' })
      await expect(app.request({ currentText: 'Feed' })).resolves.toEqual({
        status: 'one_link', url: 'https://x.com/example/status/123',
      })
    } finally {
      await app.close()
    }
  })

  it('deduplicates stable ids across three surfaces and never reselects processed candidates after restart', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'personal-feed-history-'))
    const judgeCandidate = vi.fn(async ({ candidate }: Parameters<PersonalFeedModel['judgeCandidate']>[0]) => ({
      status: candidate.stableId === 'x-status:222' ? 'qualified' as const : 'not_qualified' as const,
    }))
    const model: PersonalFeedModel = {
      observeContext: vi.fn(async () => ({ status: 'applied', facts: [
        { lane: 'long_term_interest', statement: 'distributed systems', stance: 'include' },
        { lane: 'existing_knowledge', statement: 'I know consensus basics', epistemic: 'asserted' },
      ] })),
      judgeCandidate,
      interpretFeedback: vi.fn(async () => ({ status: 'pass' })),
    }
    const candidates = [
      { stableId: 'x-status:111', canonicalUrl: 'https://x.com/a/status/111', body: 'first', authorHandle: 'a', publishedAt: '2026-09-04T00:00:00.000Z', surface: 'for_you' as const },
      { stableId: 'x-status:111', canonicalUrl: 'https://x.com/a/status/111', body: 'duplicate', authorHandle: 'a', publishedAt: '2026-09-04T00:00:00.000Z', surface: 'following' as const },
      { stableId: 'x-status:222', canonicalUrl: 'https://x.com/b/status/222', body: 'increment', authorHandle: 'b', publishedAt: '2026-09-04T00:00:00.000Z', surface: 'explore' as const },
    ]
    const observer: XObserver = {
      observe: vi.fn(async () => ({ status: 'complete', candidates })),
      close: vi.fn(async () => undefined),
    }
    const first = createPersonalFeedApplication({ stateDir, model, observer })

    await expect(first.request({ currentText: '我长期关注分布式系统，也了解共识基础' })).resolves.toEqual({
      status: 'one_link', url: 'https://x.com/b/status/222',
    })
    expect(judgeCandidate.mock.calls.map(call => call[0].candidate.stableId)).toEqual(['x-status:111', 'x-status:222'])
    await first.close()

    judgeCandidate.mockClear()
    const reopened = createPersonalFeedApplication({ stateDir, model, observer })
    await expect(reopened.request({ currentText: '我长期关注分布式系统，也了解共识基础' })).resolves.toEqual({ status: 'business_empty' })
    expect(judgeCandidate).not.toHaveBeenCalled()
    await reopened.close()
  })

  it('serializes full requests without reselecting their shared candidate', async () => {
    let active = 0
    let maximum = 0
    let releaseFirst!: () => void
    const gate = new Promise<void>(resolve => { releaseFirst = resolve })
    let calls = 0
    const { app } = await fixture({ observer: {
      observe: vi.fn(async () => {
        active += 1
        maximum = Math.max(maximum, active)
        calls += 1
        if (calls === 1) await gate
        active -= 1
        return { status: 'complete' as const, candidates: [{
          stableId: 'x-status:123', canonicalUrl: 'https://x.com/example/status/123',
          body: 'A concrete update about agents.', authorHandle: 'example', publishedAt: '2026-09-04T01:00:00.000Z',
        }] }
      }),
      close: vi.fn(async () => undefined),
    } })

    const first = app.request({ currentText: '我长期关注 agent systems' })
    const second = app.request({ currentText: '我长期关注 databases' })
    await vi.waitFor(() => expect(calls).toBe(1))
    releaseFirst()
    expect(await Promise.all([first, second])).toEqual([
      { status: 'one_link', url: 'https://x.com/example/status/123' },
      { status: 'business_empty' },
    ])

    expect(maximum).toBe(1)
    await app.close()
  })

  it('revalidates context state after model wait and reports a conflict instead of overwriting', async () => {
    let arrivals = 0
    let release!: () => void
    const bothArrived = new Promise<void>(resolve => { release = resolve })
    const model: PersonalFeedModel = {
      observeContext: vi.fn(async ({ currentText }) => {
        arrivals += 1
        if (arrivals === 2) release()
        await bothArrived
        return { status: 'applied', facts: [
          { lane: 'long_term_interest' as const, statement: currentText, stance: 'include' as const },
        ] }
      }),
      judgeCandidate: vi.fn(async () => ({ status: 'not_qualified' })),
      interpretFeedback: vi.fn(async () => ({ status: 'pass' })),
    }
    const { app } = await fixture({ model })

    const results = await Promise.all([
      app.observeContext({ currentText: 'topic A' }),
      app.observeContext({ currentText: 'topic B' }),
    ])

    expect(results.filter(result => result.status === 'applied')).toHaveLength(1)
    expect(results).toContainEqual({ status: 'incomplete', stage: 'conflict' })
    await app.close()
  })

  it('uses explicit opaque continuation tokens instead of hidden conversation identity', async () => {
    const { app, model, stateDir, observer } = await fixture({ model: {
      observeContext: vi.fn(async () => ({ status: 'ignored' as const })),
      judgeCandidate: vi.fn(async () => ({ status: 'not_qualified' as const })),
      interpretFeedback: vi.fn(async ({ currentText }) => currentText.trim() === '不喜欢'
        ? { status: 'needs_input' as const, question: '你指的是哪一条？' }
        : { status: 'completed' as const, sentiment: 'dislike' as const, targetText: 'https://x.com/example/status/123' }),
    } })

    const firstText = '  不喜欢  '
    const first = await app.processFeedback({ currentText: firstText })
    expect(first.status).toBe('needs_input')
    if (first.status !== 'needs_input') throw new Error('unexpected result')
    expect(first.continuationToken).toMatch(/^[A-Za-z0-9_-]{40,}$/u)
    expect(JSON.stringify(first)).not.toMatch(/chat|message|session/iu)

    const secondText = '\n就是这条\t'
    const second = await app.processFeedback({ currentText: secondText, continuationToken: first.continuationToken })
    expect(second).toEqual({ status: 'completed' })
    expect(model.interpretFeedback).toHaveBeenLastCalledWith(expect.objectContaining({
      currentText: secondText,
      referenceText: firstText,
    }))
    const ledger = await readFile(join(stateDir, 'feedback.jsonl'), 'utf8')
    expect(ledger).toContain('https://x.com/example/status/123')
    await app.close()
    expect(observer.close).toHaveBeenCalled()
  })

  it('recovers an appended feedback event without duplicating it after a pending-snapshot failure', async () => {
    const { app, stateDir } = await fixture({ model: {
      observeContext: vi.fn(async () => ({ status: 'ignored' as const })),
      judgeCandidate: vi.fn(async () => ({ status: 'not_qualified' as const })),
      interpretFeedback: vi.fn(async ({ currentText }) => currentText === '不喜欢'
        ? { status: 'needs_input' as const, question: '你指的是哪一条？' }
        : { status: 'completed' as const, sentiment: 'dislike' as const, targetText: 'https://x.com/example/status/123' }),
    } })

    const pending = await app.processFeedback({ currentText: '不喜欢' })
    if (pending.status !== 'needs_input') throw new Error('expected continuation token')
    const eventId = `continuation:${createHash('sha256').update(pending.continuationToken).digest('hex')}`
    await appendFile(join(stateDir, 'feedback.jsonl'), `${JSON.stringify({
      schemaVersion: 1,
      id: eventId,
      sentiment: 'dislike',
      targetText: 'https://x.com/example/status/123',
      createdAt: '2026-09-04T00:00:00.000Z',
    })}\n`)

    await expect(app.processFeedback({
      currentText: '就是这条',
      continuationToken: pending.continuationToken,
    })).resolves.toEqual({ status: 'completed' })
    const events = (await readFile(join(stateDir, 'feedback.jsonl'), 'utf8')).trim().split('\n')
    expect(events).toHaveLength(1)
    await app.close()
  })

  it('durably records only save/unsave and lists current saved state', async () => {
    const { app, stateDir } = await fixture()
    const url = 'https://twitter.com/Example/status/123?ref=test'

    await expect(app.recordFeedback({ operation: 'save', url, title: 'Read later' })).resolves.toMatchObject({ status: 'saved' })
    await expect(app.recordFeedback({ operation: 'save', url })).resolves.toEqual({ status: 'already_saved' })
    await expect(app.listSaved({})).resolves.toMatchObject({ status: 'completed', items: [{
      url: 'https://x.com/example/status/123', title: 'Read later',
    }] })
    const ledger = await readFile(join(stateDir, 'saved.jsonl'), 'utf8')
    expect(ledger.endsWith('\n')).toBe(true)
    await expect(app.recordFeedback({ operation: 'unsave', url })).resolves.toEqual({ status: 'unsaved' })
    await expect(app.recordFeedback({ operation: 'unsave', url })).resolves.toEqual({ status: 'already_unsaved' })
    await app.close()

    const model: PersonalFeedModel = {
      observeContext: vi.fn(async () => ({ status: 'ignored' })),
      judgeCandidate: vi.fn(async () => ({ status: 'not_qualified' })),
      interpretFeedback: vi.fn(async () => ({ status: 'pass' })),
    }
    const observer: XObserver = { observe: vi.fn(async () => ({ status: 'complete', candidates: [] })), close: vi.fn(async () => undefined) }
    const reopened = createPersonalFeedApplication({ stateDir, model, observer })
    await expect(reopened.listSaved({})).resolves.toEqual({ status: 'completed', items: [] })
    await reopened.close()
  })

  it('does not lose distinct concurrent save operations', async () => {
    const { app } = await fixture()

    await expect(Promise.all([
      app.recordFeedback({ operation: 'save', url: 'https://x.com/a/status/1' }),
      app.recordFeedback({ operation: 'save', url: 'https://x.com/b/status/2' }),
    ])).resolves.toEqual([{ status: 'saved' }, { status: 'saved' }])
    const listed = await app.listSaved({})
    expect(listed.items.map(item => item.url).sort()).toEqual([
      'https://x.com/a/status/1',
      'https://x.com/b/status/2',
    ])
    await app.close()
  })
})
