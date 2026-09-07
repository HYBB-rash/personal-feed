import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
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
    assessContext: vi.fn(async () => ({ status: 'completed' as const, sufficient: true })),
    observeContext: vi.fn<PersonalFeedModel['observeContext']>(async ({ assessForFeed }) => ({
      status: 'applied' as const,
      ...(assessForFeed ? { sufficient: true } : {}),
      changes: { additions: [
        { lane: 'long_term_interest' as const, statement: 'agent systems', stance: 'include' as const },
        { lane: 'existing_knowledge' as const, statement: 'I know the basic agent loop', epistemic: 'asserted' as const },
      ], replacements: [] },
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
  it.each(['observeContext', 'processFeedback'] as const)('rejects the removed cross-call association input in %s without touching state', async operation => {
    const { app, model, observer, stateDir } = await fixture()
    try {
      await app.observeContext({ currentText: '保存已有的明确资料。' })
      const before = await readFile(join(stateDir, 'personal-context.json'), 'utf8')
      const files = await readdir(stateDir)
      vi.mocked(model.observeContext).mockClear()

      await expect(app[operation]({ currentText: '补充回答。', continuationToken: 'A'.repeat(43) } as never)).rejects.toMatchObject({ name: 'PersonalFeedInputError' })
      expect(await readdir(stateDir)).toEqual(files)
      expect(await readFile(join(stateDir, 'personal-context.json'), 'utf8')).toBe(before)
      expect(model.observeContext).not.toHaveBeenCalled()
      expect(model.interpretFeedback).not.toHaveBeenCalled()
      expect(model.judgeCandidate).not.toHaveBeenCalled()
      expect(observer.observe).not.toHaveBeenCalled()
    } finally {
      await app.close()
      await rm(stateDir, { recursive: true, force: true })
    }
  })

  it.each(['observeContext', 'processFeedback'] as const)('keeps malformed association tokens as input errors in %s', async operation => {
    const { app, model, observer, stateDir } = await fixture()
    try {
      await expect(app[operation]({ currentText: '回答。', continuationToken: 'invalid' } as never)).rejects.toMatchObject({
        name: 'PersonalFeedInputError',
      })
      expect(await readdir(stateDir)).toEqual([])
      expect(model.observeContext).not.toHaveBeenCalled()
      expect(model.interpretFeedback).not.toHaveBeenCalled()
      expect(observer.observe).not.toHaveBeenCalled()
    } finally {
      await app.close()
      await rm(stateDir, { recursive: true, force: true })
    }
  })

  it('uses the current request as discovery intent without rewriting personal context', async () => {
    const { app, model, observer } = await fixture()

    const currentText = '  我长期关注 agent systems  '
    const result = await app.request({ currentText }, { mode: 'interactive' })

    expect(result).toEqual({ status: 'one_link', url: 'https://x.com/example/status/123' })
    expect(model.observeContext).not.toHaveBeenCalled()
    expect(model.judgeCandidate).toHaveBeenCalledWith(expect.objectContaining({ requestText: currentText }))
    expect(observer.observe).toHaveBeenCalledTimes(1)
    await app.close()
  })

  it('keeps business-empty distinct from model and source incompletes', async () => {
    const empty = await fixture({ observer: {
      observe: vi.fn(async () => ({ status: 'complete' as const, candidates: [] })),
      close: vi.fn(async () => undefined),
    } })
    await expect(empty.app.request({ currentText: '我长期关注 agent systems' }, { mode: 'interactive' })).resolves.toEqual({
      status: 'incomplete', stage: 'judgement_execution', reason: 'exploration_not_ready',
    })
    await empty.app.close()

    const incomplete = await fixture({ observer: {
      observe: vi.fn(async () => ({ status: 'incomplete' as const, stage: 'source_window' as const, reason: 'observation_failed' as const })),
      close: vi.fn(async () => undefined),
    } })
    await expect(incomplete.app.request({ currentText: '我长期关注 agent systems' }, { mode: 'interactive' })).resolves.toEqual({
      status: 'incomplete', stage: 'source_window', reason: 'observation_failed',
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
        expected: { status: 'incomplete', stage: 'judgement_execution', reason: 'exploration_not_ready' },
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
        expected: { status: 'incomplete', stage: 'source_window', reason: 'material_insufficient' },
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
        expected: { status: 'incomplete', stage: 'source_window', reason: 'observation_failed' },
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
      await expect(entry.app.request({ currentText: '我长期关注 agent systems' }, { mode: 'interactive' })).resolves.toEqual(testCase.expected)
      expect(entry.model.judgeCandidate).not.toHaveBeenCalled()
      await entry.app.close()
    }
  })

  it('can discover directly with an empty personal context', async () => {
    const model: PersonalFeedModel = {
      assessContext: vi.fn(async () => ({ status: 'completed' as const, sufficient: true })),
      observeContext: vi.fn(async () => ({
        status: 'applied',
        sufficient: true,
        changes: { additions: [{ lane: 'long_term_interest', statement: 'agent systems', stance: 'include' }], replacements: [] },
      })),
      judgeCandidate: vi.fn(async () => ({ status: 'qualified' })),
      interpretFeedback: vi.fn(async () => ({ status: 'pass' })),
    }
    const { app, observer } = await fixture({ model })

    await expect(app.request({ currentText: '我长期关注 agent systems' }, { mode: 'interactive' })).resolves.toEqual({
      status: 'one_link', url: 'https://x.com/example/status/123',
    })
    expect(observer.observe).toHaveBeenCalledTimes(1)
    expect(model.judgeCandidate).toHaveBeenCalledWith(expect.objectContaining({ personalContext: [] }))
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
      assessContext: vi.fn(async () => ({ status: 'completed' as const, sufficient: true })),
      observeContext: async ({ currentText, activeFacts }) => {
        if (currentText === 'Feed') return { status: 'ignored', sufficient: true }
        const interest = { lane: 'long_term_interest' as const, statement: 'agents', stance: currentText === '不再关注 agents' ? 'exclude' as const : 'include' as const }
        const previous = activeFacts.find(fact => fact.lane === 'long_term_interest')
        return { status: 'applied', changes: {
          additions: [
            ...(previous === undefined ? [interest] : []),
            { lane: 'existing_knowledge', statement: 'basic agent loop', epistemic: 'asserted' },
          ],
          replacements: previous === undefined ? [] : [{ target: previous, replacement: [interest] }],
        } }
      },
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
      await expect(app.request({ currentText: 'Feed' }, { mode: 'interactive' })).resolves.toEqual({
        status: 'one_link', url: 'https://x.com/example/status/123',
      })
    } finally {
      await app.close()
    }
  })

  it('deduplicates stable ids within each request without persisting selection history', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'personal-feed-history-'))
    const judgeCandidate = vi.fn(async ({ candidate }: Parameters<PersonalFeedModel['judgeCandidate']>[0]) => ({
      status: candidate.stableId === 'x-status:222' ? 'qualified' as const : 'not_qualified' as const,
    }))
    const model: PersonalFeedModel = {
      assessContext: vi.fn(async () => ({ status: 'completed' as const, sufficient: true })),
      observeContext: vi.fn(async () => ({ status: 'applied', sufficient: true, changes: { additions: [
        { lane: 'long_term_interest', statement: 'distributed systems', stance: 'include' },
        { lane: 'existing_knowledge', statement: 'I know consensus basics', epistemic: 'asserted' },
      ], replacements: [] } })),
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

    await expect(first.request({ currentText: '我长期关注分布式系统，也了解共识基础' }, { mode: 'interactive' })).resolves.toEqual({
      status: 'one_link', url: 'https://x.com/b/status/222',
    })
    expect(judgeCandidate.mock.calls.map(call => call[0].candidate.stableId)).toEqual(['x-status:111', 'x-status:222'])
    await first.close()

    judgeCandidate.mockClear()
    const reopened = createPersonalFeedApplication({ stateDir, model, observer })
    await expect(reopened.request({ currentText: '我长期关注分布式系统，也了解共识基础' }, { mode: 'interactive' })).resolves.toEqual({
      status: 'one_link', url: 'https://x.com/b/status/222',
    })
    expect(judgeCandidate.mock.calls.map(call => call[0].candidate.stableId)).toEqual(['x-status:111', 'x-status:222'])
    await reopened.close()
  })

  it('serializes background selection requests', async () => {
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

    await app.observeContext({ currentText: '保存明确的关注和已有认识' })
    const first = app.request({ currentText: 'monitor saved interests' })
    const second = app.request({ currentText: 'monitor saved interests again' })
    await vi.waitFor(() => expect(calls).toBe(1))
    releaseFirst()
    expect(await Promise.all([first, second])).toEqual([
      { status: 'one_link', url: 'https://x.com/example/status/123' },
      { status: 'one_link', url: 'https://x.com/example/status/123' },
    ])

    expect(maximum).toBe(1)
    await app.close()
  })

  it('revalidates context state after model wait and reports a conflict instead of overwriting', async () => {
    let arrivals = 0
    let release!: () => void
    const bothArrived = new Promise<void>(resolve => { release = resolve })
    const model: PersonalFeedModel = {
      assessContext: vi.fn(async () => ({ status: 'completed' as const, sufficient: true })),
      observeContext: vi.fn(async ({ currentText }) => {
        arrivals += 1
        if (arrivals === 2) release()
        await bothArrived
        return { status: 'applied', changes: { additions: [
          { lane: 'long_term_interest' as const, statement: currentText, stance: 'include' as const },
        ], replacements: [] } }
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

  it('keeps raw feedback answers inside the original call without publishing an association', async () => {
    const { app, model, stateDir, observer } = await fixture({ model: {
      assessContext: vi.fn(async () => ({ status: 'completed' as const, sufficient: true })),
      observeContext: vi.fn(async () => ({ status: 'ignored' as const })),
      judgeCandidate: vi.fn(async () => ({ status: 'not_qualified' as const })),
      interpretFeedback: vi.fn(async ({ currentText }) => currentText.trim() === '不喜欢'
        ? { status: 'needs_input' as const, remaining: { question: '你指的是哪一条，为什么不喜欢？', unresolvedScope: 'target and reason' } }
        : { status: 'completed' as const, sentiment: 'dislike' as const, targetText: 'https://x.com/example/status/123', reason: '标题夸张', remaining: null }),
    } })
    try {
      const firstText = '  不喜欢  '
      const answerText = '\n就是这条，标题夸张\t'
      const ask = vi.fn(async () => ({ action: 'accept' as const, text: answerText }))
      const result = await app.processFeedback({ currentText: firstText }, { mode: 'interactive', ask })
      expect(result).toEqual({ status: 'completed' })
      expect(JSON.stringify(result)).not.toMatch(/token|chat|message|session/iu)
      expect(ask).toHaveBeenCalledTimes(1)
      expect(model.interpretFeedback).toHaveBeenLastCalledWith(expect.objectContaining({
        currentText: answerText,
        clarification: { originalText: firstText, question: '你指的是哪一条，为什么不喜欢？', unresolvedScope: 'target and reason' },
      }))
      const ledger = await readFile(join(stateDir, 'feedback.jsonl'), 'utf8')
      expect(ledger.trim().split('\n')).toHaveLength(1)
      expect(ledger).toContain('https://x.com/example/status/123')
      await expect(readFile(join(stateDir, 'pending-feedback.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      expect(observer.observe).not.toHaveBeenCalled()
    } finally { await app.close(); await rm(stateDir, { recursive: true, force: true }) }
  })

  it('settles one answer only once without duplicate feedback events', async () => {
    const { app, model, stateDir } = await fixture({ model: {
      assessContext: vi.fn(async () => ({ status: 'completed' as const, sufficient: true })),
      observeContext: vi.fn(async () => ({ status: 'ignored' as const })),
      judgeCandidate: vi.fn(async () => ({ status: 'not_qualified' as const })),
      interpretFeedback: vi.fn(async ({ currentText }) => currentText === '不喜欢'
        ? { status: 'needs_input' as const, remaining: { question: '你指的是哪一条，为什么不喜欢？', unresolvedScope: 'target and reason' } }
        : { status: 'completed' as const, sentiment: 'dislike' as const, targetText: 'https://x.com/example/status/123', reason: '标题夸张', remaining: null }),
    } })
    try {
      const result = await app.processFeedback({ currentText: '不喜欢' }, {
        mode: 'interactive',
        ask: async () => new Promise(resolve => {
          resolve({ action: 'accept', text: '就是这条，标题夸张' })
          resolve({ action: 'accept', text: 'a stale second answer' })
        }),
      })
      expect(result).toEqual({ status: 'completed' })
      expect(model.interpretFeedback).toHaveBeenCalledTimes(2)
      expect(model.interpretFeedback).toHaveBeenLastCalledWith(expect.objectContaining({ currentText: '就是这条，标题夸张' }))
      const events = (await readFile(join(stateDir, 'feedback.jsonl'), 'utf8')).trim().split('\n')
      expect(events).toHaveLength(1)
    } finally { await app.close(); await rm(stateDir, { recursive: true, force: true }) }
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
      assessContext: vi.fn(async () => ({ status: 'completed' as const, sufficient: true })),
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

  it.each([
    ['AbortError', 'interaction_cancelled'],
    ['TimeoutError', 'interaction_timeout'],
  ] as const)('reports an aborted source observation as shutdown / %s', async (name, reason) => {
    const observer: XObserver = {
      observe: vi.fn(async ({ signal }) => {
        await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
        return { status: 'incomplete', stage: 'source_window', reason: 'observation_failed' }
      }),
      close: vi.fn(async () => undefined),
    }
    const { app } = await fixture({ observer })
    const abort = new AbortController()
    const pending = app.request({ currentText: 'direct discovery' }, { signal: abort.signal })
    await vi.waitFor(() => expect(observer.observe).toHaveBeenCalled())
    abort.abort(new DOMException('controlled stop', name))
    await expect(pending).resolves.toEqual({ status: 'incomplete', stage: 'shutdown', reason })
    await app.close()
  })

  it('reports a timed-out candidate judgment as shutdown instead of a judgment fault', async () => {
    const base = await fixture()
    await base.app.close()
    const model = base.model
    vi.mocked(model.judgeCandidate).mockImplementation(async ({ signal }) => {
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
      return { status: 'incomplete' }
    })
    const app = createPersonalFeedApplication({ stateDir: base.stateDir, model, observer: base.observer })
    const abort = new AbortController()
    const pending = app.request({ currentText: 'direct discovery' }, { signal: abort.signal })
    await vi.waitFor(() => expect(model.judgeCandidate).toHaveBeenCalled())
    abort.abort(new DOMException('controlled deadline', 'TimeoutError'))
    await expect(pending).resolves.toEqual({ status: 'incomplete', stage: 'shutdown', reason: 'interaction_timeout' })
    await app.close()
  })

  it.each([
    ['observeContext', 'observeContext', 'context_observation'],
    ['processFeedback', 'interpretFeedback', 'feedback_interpretation'],
  ] as const)('preserves a local deadline reason from %s model work', async (operation, modelOperation, stage) => {
    const { app, model } = await fixture()
    vi.mocked(model[modelOperation]).mockImplementation(async ({ signal }: { signal: AbortSignal }) => {
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
      return { status: 'incomplete' } as never
    })
    const abort = new AbortController()
    const pending = app[operation]({ currentText: 'controlled input' }, { signal: abort.signal })
    await vi.waitFor(() => expect(model[modelOperation]).toHaveBeenCalled())
    abort.abort(new DOMException('controlled deadline', 'TimeoutError'))
    await expect(pending).resolves.toEqual({ status: 'incomplete', stage, reason: 'interaction_timeout' })
    await app.close()
  })

  it('does not commit a save that is cancelled after it enters the saved queue', async () => {
    const { app, stateDir } = await fixture()
    const abort = new AbortController()
    const pending = app.recordFeedback({ operation: 'save', url: 'https://x.com/cancelled/status/9' }, { signal: abort.signal })
    abort.abort()
    await expect(pending).rejects.toMatchObject({ name: 'PersonalFeedClosedError' })
    await expect(readFile(join(stateDir, 'saved.jsonl'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await app.close()
  })

  it('does not read the saved ledger after a queued list is cancelled', async () => {
    const { app, stateDir } = await fixture()
    await writeFile(join(stateDir, 'saved.jsonl'), '{invalid ledger\n')
    const abort = new AbortController()
    const pending = app.listSaved({}, { signal: abort.signal })
    abort.abort()
    await expect(pending).rejects.toMatchObject({ name: 'PersonalFeedClosedError' })
    await app.close()
  })
})
