import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPersonalFeedApplication, type XObserver } from '../src/application.ts'
import { createOpenAICompatiblePersonalFeedModel } from '../src/openai-compatible-model.ts'
import { PersonalFeedStorageError } from '../src/errors.ts'
import * as persistence from '../src/persistence.ts'

const originalText = 'Give me a beginner family-care Feed, focused on practical home care.'
const interest = { lane: 'long_term_interest', statement: 'family care', stance: 'include' } as const
const knowledge = { lane: 'existing_knowledge', statement: 'I am new to family care', epistemic: 'asserted' } as const
const gap = { question: 'What do you know about family care?', unresolvedScope: 'family-care knowledge' }
const doubt = { question: 'Which old claim remains uncertain?', unresolvedScope: 'old uncertain claim' }
const additions = { additions: [knowledge], replacements: [] }
const qualified = { longTermValue: 'pass', longTermInterestMatch: 'pass', informationIncrement: 'pass' }
const candidate = {
  stableId: 'x-status:101', canonicalUrl: 'https://x.com/fixture/status/101', body: 'A practical home-care explanation',
  authorHandle: 'fixture', publishedAt: '2026-09-06T00:00:00.000Z',
}
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  for (const close of cleanup.splice(0).reverse()) await close()
})

async function fixture() {
  const stateDir = await mkdtemp(join(tmpdir(), 'pf-d06-'))
  cleanup.push(() => rm(stateDir, { recursive: true, force: true }))
  const contextPath = join(stateDir, 'personal-context.json')
  await writeFile(contextPath, JSON.stringify({ schemaVersion: 1, generation: 1, facts: [interest] }))
  let response: Record<string, unknown> = { status: 'ignored', sufficient: false, remaining: gap }
  let judgment: Record<string, unknown> = qualified
  let now = new Date('2026-09-06T00:00:00.000Z')
  const contextInputs: Record<string, unknown>[] = []
  const judgmentInputs: Record<string, unknown>[] = []
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    const wire = JSON.parse(init!.body as string) as { messages: Array<{ content: string }> }
    const payload = JSON.parse(wire.messages[1]!.content) as Record<string, unknown>
    let result: Record<string, unknown>
    if (wire.messages[0]!.content.startsWith('Extract only durable personal context')) {
      contextInputs.push(payload)
      // The real decoder has different ordinary-update and Feed assessment contracts.
      const { sufficient: _sufficient, ...ordinary } = response
      result = payload.assessForFeed === true ? response : ordinary
    } else if (wire.messages[0]!.content.startsWith('Interpret whether the user')) {
      result = response
    } else {
      judgmentInputs.push(payload)
      result = judgment
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }))
  })
  vi.stubGlobal('fetch', fetch)
  const observer: XObserver = {
    observe: vi.fn(async () => ({ status: 'complete', candidates: [candidate] })),
    close: vi.fn(async () => {}),
  }
  const options = {
    stateDir, observer, shutdownTimeoutMs: 5, now: () => now,
    model: createOpenAICompatiblePersonalFeedModel({ baseURL: 'http://127.0.0.1:1/v1', model: 'fixture', apiKey: 'fixture', timeoutMs: 1_000 }),
  }
  const app = createPersonalFeedApplication(options)
  cleanup.push(() => app.close())
  return {
    app, options, stateDir, contextPath, observer, fetch, contextInputs, judgmentInputs,
    respond: (value: Record<string, unknown>) => { response = value },
    judge: (value: Record<string, unknown>) => { judgment = value },
    setNow: (value: string) => { now = new Date(value) },
    facts: async () => (JSON.parse(await readFile(contextPath, 'utf8')) as { facts: unknown[] }).facts,
    async waiting() {
      const result = await app.request({ currentText: originalText })
      expect(result).toMatchObject({ status: 'incomplete', stage: 'personal_context', question: gap.question })
      expect(result.continuationToken).toEqual(expect.any(String))
      return result.continuationToken!
    },
  }
}

describe('continue the original Feed after clarification', () => {
  it('waits through an unclear answer and selects once using the original intent and the accepted new facts', async () => {
    const f = await fixture()
    const token = await f.waiting()
    f.respond({ status: 'ignored', sufficient: false, remaining: gap })
    const unclear = await f.app.observeContext({ currentText: 'I am not sure.', continuationToken: token })
    expect(unclear).toMatchObject({ status: 'ignored', question: gap.question })
    expect(unclear).not.toHaveProperty('feed')
    expect(f.observer.observe).not.toHaveBeenCalled()
    f.setNow('2026-09-07T01:00:00.000Z')
    f.respond({ status: 'applied', changes: additions, sufficient: true, remaining: null })
    const answer = '  I am a novice in family care.\n'
    const result = await f.app.observeContext({ currentText: answer, continuationToken: unclear.continuationToken })
    expect(result).toEqual({ status: 'applied', appliedCount: 1, feed: { status: 'one_link', url: candidate.canonicalUrl } })
    expect(await f.facts()).toEqual([interest, knowledge])
    expect(f.contextInputs.map(input => input.currentText)).toEqual([originalText, 'I am not sure.', answer])
    expect(f.contextInputs.map(input => input.assessForFeed)).toEqual([true, true, true])
    expect(f.contextInputs[2]?.clarification).toMatchObject({ originalText, ...gap })
    expect(f.judgmentInputs).toEqual([expect.objectContaining({ requestText: originalText, personalContext: [interest, knowledge] })])
    expect(f.observer.observe).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ cutoff: '2026-09-07T01:00:00.000Z', shanghaiDay: '2026-09-07' }))
    await expect(f.app.observeContext({ currentText: answer, continuationToken: unclear.continuationToken }))
      .resolves.toEqual({ status: 'incomplete', stage: 'context_observation' })
    expect(f.observer.observe).toHaveBeenCalledTimes(1)
  })

  it('keeps a remaining question without carrying an already executed Feed into the next answer', async () => {
    const f = await fixture()
    const token = await f.waiting()
    f.respond({ status: 'applied', changes: additions, sufficient: true, remaining: doubt })
    const first = await f.app.observeContext({ currentText: 'I am a novice; the old claim is still unclear.', continuationToken: token })
    expect(first).toMatchObject({ status: 'applied', question: doubt.question, feed: { status: 'one_link' } })
    f.respond({ status: 'ignored', remaining: null })
    expect(await f.app.observeContext({ currentText: 'Leave the old claim unresolved.', continuationToken: first.continuationToken }))
      .toEqual({ status: 'ignored' })
    expect(f.contextInputs.at(-1)).not.toHaveProperty('assessForFeed')
    expect(f.observer.observe).toHaveBeenCalledTimes(1)
  })

  it('does not let a no-token update, feedback or a different question claim a waiting Feed', async () => {
    const f = await fixture()
    const token = await f.waiting()
    f.respond({ status: 'ignored', remaining: doubt })
    const independent = await f.app.observeContext({ currentText: 'Another unclear claim.' })
    f.respond({ status: 'applied', changes: additions, remaining: null })
    expect(await f.app.observeContext({ currentText: 'I am a novice.', continuationToken: independent.continuationToken }))
      .toEqual({ status: 'applied', appliedCount: 1 })
    expect(await f.app.observeContext({ currentText: 'Ordinary update.' })).not.toHaveProperty('feed')
    f.respond({ status: 'pass' })
    expect(await f.app.processFeedback({ currentText: 'No feedback.' })).toEqual({ status: 'pass' })
    expect(await f.app.processFeedback({ currentText: 'Wrong tool.', continuationToken: token }))
      .toEqual({ status: 'incomplete', stage: 'feedback_interpretation' })
    expect(f.observer.observe).not.toHaveBeenCalled()
    f.respond({ status: 'ignored', sufficient: true, remaining: null })
    expect(await f.app.observeContext({ currentText: 'The saved novice boundary answers that question.', continuationToken: token }))
      .toMatchObject({ status: 'ignored', feed: { status: 'one_link' } })
  })

  it.each([
    { status: 'incomplete' },
    { status: 'ignored', remaining: gap },
  ])('retains the original association when preparation cannot finish: %j', async response => {
    const f = await fixture()
    const token = await f.waiting()
    f.respond(response)
    expect(await f.app.observeContext({ currentText: 'Unusable answer.', continuationToken: token }))
      .toEqual({ status: 'incomplete', stage: 'context_observation', question: gap.question, continuationToken: token })
    expect(f.observer.observe).not.toHaveBeenCalled()
    f.respond({ status: 'applied', changes: additions, sufficient: true, remaining: null })
    expect(await f.app.observeContext({ currentText: 'I am a novice.', continuationToken: token }))
      .toMatchObject({ feed: { status: 'one_link' } })
  })

  it('keeps the answer usable after a fact write failure before claiming the Feed', async () => {
    const f = await fixture()
    const token = await f.waiting()
    f.respond({ status: 'applied', changes: additions, sufficient: true, remaining: null })
    vi.spyOn(persistence, 'atomicWriteJson').mockRejectedValueOnce(new PersonalFeedStorageError('controlled write failure'))
    await expect(f.app.observeContext({ currentText: 'I am a novice.', continuationToken: token })).rejects.toBeInstanceOf(PersonalFeedStorageError)
    expect(await f.facts()).toEqual([interest])
    expect(f.observer.observe).not.toHaveBeenCalled()
    expect(await f.app.observeContext({ currentText: 'I am a novice.', continuationToken: token }))
      .toMatchObject({ feed: { status: 'one_link' } })
  })

  it.each(['empty', 'source', 'judgment'] as const)('returns the actual resumed %s result and never retries it on a remaining answer', async outcome => {
    const f = await fixture()
    const token = await f.waiting()
    if (outcome === 'empty') vi.mocked(f.observer.observe).mockResolvedValue({ status: 'complete', candidates: [] })
    if (outcome === 'source') vi.mocked(f.observer.observe).mockResolvedValue({ status: 'incomplete', stage: 'source_window', reason: 'observation_failed' })
    if (outcome === 'judgment') f.judge({ longTermValue: 'unknown', longTermInterestMatch: 'not_reached', informationIncrement: 'not_reached' })
    f.respond({ status: 'applied', changes: additions, sufficient: true, remaining: doubt })
    const result = await f.app.observeContext({ currentText: 'I am a novice.', continuationToken: token })
    expect(result.feed).toEqual(outcome === 'empty' ? { status: 'business_empty' }
      : outcome === 'source' ? { status: 'incomplete', stage: 'source_window', reason: 'observation_failed' }
        : { status: 'incomplete', stage: 'judgement_execution' })
    expect(await f.facts()).toEqual([interest, knowledge])
    f.respond({ status: 'ignored', remaining: null })
    expect(await f.app.observeContext({ currentText: 'Leave the doubt unresolved.', continuationToken: result.continuationToken }))
      .toEqual({ status: 'ignored' })
    expect(f.observer.observe).toHaveBeenCalledTimes(1)
  })
  it('allows concurrent answers to claim the original request only once', async () => {
    const f = await fixture()
    const token = await f.waiting()
    f.respond({ status: 'applied', changes: additions, sufficient: true, remaining: null })
    const results = await Promise.all([
      f.app.observeContext({ currentText: 'I am a novice.', continuationToken: token }),
      f.app.observeContext({ currentText: 'I am a novice.', continuationToken: token }),
    ])
    expect(results.filter(result => result.feed?.status === 'one_link')).toHaveLength(1)
    expect(results.filter(result => result.status === 'incomplete')).toHaveLength(1)
    expect(f.observer.observe).toHaveBeenCalledTimes(1)
    expect(await f.facts()).toEqual([interest, knowledge])
  })

  it('retains the association after a generation conflict and reinterprets on retry', async () => {
    const f = await fixture()
    const token = await f.waiting()
    let release!: () => void
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    f.fetch.mockImplementationOnce(async () => {
      entered(); await gate
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ status: 'applied', changes: additions, sufficient: true, remaining: null }) } }] }))
    })
    const pending = f.app.observeContext({ currentText: 'I am a novice.', continuationToken: token })
    await started
    f.respond({ status: 'ignored' })
    await f.app.observeContext({ currentText: 'An independent update.' })
    release()
    expect(await pending).toMatchObject({ status: 'incomplete', stage: 'conflict', continuationToken: token })
    expect(f.observer.observe).not.toHaveBeenCalled()
    f.respond({ status: 'applied', changes: additions, sufficient: true, remaining: null })
    expect(await f.app.observeContext({ currentText: 'I am a novice.', continuationToken: token })).toMatchObject({ feed: { status: 'one_link' } })
  })

  it('does not replay selection after a candidate storage failure', async () => {
    const f = await fixture()
    const token = await f.waiting()
    f.respond({ status: 'applied', changes: additions, sufficient: true, remaining: null })
    vi.spyOn(persistence, 'appendJsonLine').mockRejectedValueOnce(new PersonalFeedStorageError('controlled candidate failure'))
    await expect(f.app.observeContext({ currentText: 'I am a novice.', continuationToken: token })).rejects.toBeInstanceOf(PersonalFeedStorageError)
    expect(await f.facts()).toEqual([interest, knowledge])
    expect(await f.app.observeContext({ currentText: 'Retry.', continuationToken: token })).toEqual({ status: 'incomplete', stage: 'context_observation' })
    expect(f.observer.observe).toHaveBeenCalledTimes(1)
  })

  it('keeps a pre-claim cancellation retryable but consumes a selection cancelled after claim', async () => {
    const f = await fixture()
    const token = await f.waiting()
    f.respond({ status: 'applied', changes: additions, sufficient: true, remaining: null })
    const before = new AbortController(); before.abort()
    expect(await f.app.observeContext({ currentText: 'I am a novice.', continuationToken: token }, { signal: before.signal }))
      .toMatchObject({ status: 'incomplete', continuationToken: token })
    expect(f.observer.observe).not.toHaveBeenCalled()
    const during = new AbortController()
    vi.mocked(f.observer.observe).mockImplementationOnce(async () => {
      during.abort()
      return { status: 'complete', candidates: [candidate] }
    })
    expect(await f.app.observeContext({ currentText: 'I am a novice.', continuationToken: token }, { signal: during.signal }))
      .toMatchObject({ feed: { status: 'incomplete', stage: 'source_window' } })
    expect(await f.app.observeContext({ currentText: 'Retry.', continuationToken: token })).toEqual({ status: 'incomplete', stage: 'context_observation' })
    expect(f.observer.observe).toHaveBeenCalledTimes(1)
  })

  it('does not restore pending requests on restart and keeps accepted facts', async () => {
    const f = await fixture()
    const token = await f.waiting()
    await f.app.close()
    const restarted = createPersonalFeedApplication(f.options)
    cleanup.push(() => restarted.close())
    expect(await restarted.observeContext({ currentText: 'I am a novice.', continuationToken: token }))
      .toEqual({ status: 'incomplete', stage: 'context_observation' })
    expect(await f.facts()).toEqual([interest])
    expect(f.observer.observe).not.toHaveBeenCalled()
  })

})
