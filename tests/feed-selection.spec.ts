import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createPersonalFeedApplication,
  type PersonalContextFact,
  type XCandidate,
  type XObserver,
} from '../src/application.ts'
import { createOpenAICompatiblePersonalFeedModel } from '../src/openai-compatible-model.ts'
import * as persistence from '../src/persistence.ts'

const interest = { lane: 'long_term_interest', statement: 'family care', stance: 'include' } as const
const knowledge = { lane: 'existing_knowledge', statement: 'I know family-care basics', epistemic: 'asserted' } as const
const novice = { ...knowledge, statement: 'I am new to family care and have no background' } as const
const unrelated = { ...knowledge, statement: 'I know compiler construction' } as const
const passed = { longTermValue: 'pass', longTermInterestMatch: 'pass', informationIncrement: 'pass' }
const rejected = { longTermValue: 'fail', longTermInterestMatch: 'not_reached', informationIncrement: 'not_reached' }
const cleanup: Array<() => Promise<unknown>> = []

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  for (const close of cleanup.splice(0).reverse()) await close()
})

function candidate(id = 1): XCandidate {
  return {
    stableId: `x-status:${id}`, canonicalUrl: `https://x.com/fixture/status/${id}`,
    body: 'A controlled family-care example', authorHandle: 'fixture', publishedAt: '2026-09-06T00:00:00.000Z',
  }
}

async function fixture(options: {
  facts?: readonly PersonalContextFact[]
  context?: Record<string, unknown>
  source?: XObserver['observe']
  judgment?: (payload: Record<string, unknown>) => Record<string, unknown> | Promise<Record<string, unknown>>
} = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), 'personal-feed-selection-'))
  cleanup.push(() => rm(stateDir, { recursive: true, force: true }))
  const contextPath = join(stateDir, 'personal-context.json')
  await writeFile(contextPath, JSON.stringify({ schemaVersion: 1, generation: 1, facts: options.facts ?? [interest, knowledge] }))
  const contextInputs: Record<string, unknown>[] = []
  const judgmentInputs: Record<string, unknown>[] = []
  let contextResponse = options.context ?? { status: 'ignored', sufficient: true }
  vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    const body = JSON.parse(init!.body as string) as { messages: Array<{ content: string }> }
    const payload = JSON.parse(body.messages[1]!.content) as Record<string, unknown>
    let result: unknown
    if (body.messages[0]!.content.startsWith('Extract only durable personal context')) {
      contextInputs.push(payload)
      // The controlled endpoint preserves the ordinary-update wire contract.
      const { sufficient: _sufficient, ...ordinaryResponse } = contextResponse
      result = payload.assessForFeed === true ? contextResponse : ordinaryResponse
    } else {
      judgmentInputs.push(payload)
      result = await (options.judgment?.(payload) ?? passed)
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }))
  }))
  let sourceCalls = 0
  const app = createPersonalFeedApplication({
    stateDir,
    model: createOpenAICompatiblePersonalFeedModel({ baseURL: 'http://127.0.0.1:1/v1', model: 'fixture', apiKey: 'fixture', timeoutMs: 1_000 }),
    observer: {
      observe: async input => {
        sourceCalls += 1
        return options.source?.(input) ?? { status: 'complete', candidates: [candidate()] }
      },
      close: async () => {},
    },
  })
  cleanup.push(() => app.close())
  return {
    app, stateDir, contextPath, contextInputs, judgmentInputs,
    sourceCalls: () => sourceCalls,
    respond: (response: Record<string, unknown>) => { contextResponse = response },
    facts: async () => (JSON.parse(await readFile(contextPath, 'utf8')) as { facts: PersonalContextFact[] }).facts,
    records: () => persistence.readJsonLines<{ stableId: string; judgment: string }>(join(stateDir, 'candidates.jsonl')),
  }
}

describe('one complete Feed selection', () => {
  it('discovers from an empty profile without assessment or elicitation', async () => {
    const f = await fixture({ facts: [] })
    const ask = vi.fn(async () => ({ action: 'accept' as const, text: 'should not be requested' }))

    await expect(f.app.request({ currentText: 'Give me a Feed.' }, { mode: 'interactive', ask }))
      .resolves.toEqual({ status: 'one_link', url: candidate().canonicalUrl })
    expect(ask).not.toHaveBeenCalled()
    expect(f.contextInputs).toEqual([])
    expect(f.sourceCalls()).toBe(1)
    expect(f.judgmentInputs).toHaveLength(1)
    expect(f.judgmentInputs[0]?.personalContext).toEqual([])
  })

  it('reports the removable V0 exploration gap instead of a normal empty result', async () => {
    const f = await fixture({ facts: [], source: async () => ({ status: 'complete', candidates: [] }) })

    await expect(f.app.request({ currentText: 'Give me a Feed.' })).resolves.toEqual({
      status: 'incomplete',
      stage: 'judgement_execution',
      reason: 'exploration_not_ready',
    })
    expect(f.sourceCalls()).toBe(1)
    expect(f.judgmentInputs).toEqual([])
  })

  it('does not let unrelated knowledge restore the removed profile gate', async () => {
    const f = await fixture({
      facts: [interest, unrelated], context: { status: 'ignored', sufficient: false,
        remaining: { question: 'What do you know about family care?', unresolvedScope: 'family-care knowledge' } },
      source: async () => ({ status: 'complete', candidates: [] }),
    })
    await expect(f.app.request({ currentText: 'Give me a family-care Feed.' }, { mode: 'interactive' }))
      .resolves.toEqual({ status: 'incomplete', stage: 'judgement_execution', reason: 'exploration_not_ready' })
    expect(f.sourceCalls()).toBe(1)
    expect(f.judgmentInputs).toEqual([])
    expect(f.contextInputs).toEqual([])
  })

  it('uses an explicit novice update from its independent entry on the next request', async () => {
    const f = await fixture({ facts: [interest], context: {
      status: 'applied', changes: { additions: [novice], replacements: [] }, sufficient: true,
    } })
    await expect(f.app.observeContext({ currentText: 'I am new to family care.' }))
      .resolves.toEqual({ status: 'applied', appliedCount: 1 })
    await expect(f.app.request({ currentText: 'Give me a Feed.' }, { mode: 'interactive' }))
      .resolves.toEqual({ status: 'one_link', url: candidate().canonicalUrl })
    expect(f.contextInputs).toHaveLength(1)
    expect(f.contextInputs[0]).not.toHaveProperty('assessForFeed')
    expect(f.judgmentInputs[0]?.personalContext).toEqual([interest, novice])
    expect(await f.facts()).toEqual([interest, novice])
  })

  it('does not treat request text as a personal-context update', async () => {
    const f = await fixture({ facts: [interest], context: {
      status: 'applied', changes: { additions: [unrelated], replacements: [] }, sufficient: false,
      remaining: { question: 'What do you know about family care?', unresolvedScope: 'family-care knowledge' },
    } })
    await expect(f.app.request({ currentText: 'I know compilers; give me a family-care Feed.' }, { mode: 'interactive' }))
      .resolves.toEqual({ status: 'one_link', url: candidate().canonicalUrl })
    expect(await f.facts()).toEqual([interest])
    expect(f.contextInputs).toEqual([])
    expect(f.sourceCalls()).toBe(1)
  })

  it.each([
    { status: 'ignored' },
    { status: 'ignored', sufficient: 'true' },
    { status: 'incomplete' },
  ])('does not consult the removed Feed assessment: %j', async context => {
    const f = await fixture({ context })
    await expect(f.app.request({ currentText: 'Feed' }, { mode: 'interactive' }))
      .resolves.toEqual({ status: 'one_link', url: candidate().canonicalUrl })
    expect(f.sourceCalls()).toBe(1)
    expect(f.contextInputs).toEqual([])
  })

  it('does not require Feed sufficiency for an ordinary update or start a recommendation', async () => {
    const f = await fixture({ facts: [], context: { status: 'applied', changes: { additions: [interest], replacements: [] } } })
    await expect(f.app.observeContext({ currentText: 'I follow family care.' })).resolves.toEqual({ status: 'applied', appliedCount: 1 })
    expect(await f.facts()).toEqual([interest])
    expect(f.contextInputs).toEqual([{ currentText: 'I follow family care.', activeFacts: [] }])
    expect(f.sourceCalls()).toBe(0)
  })

  it('uses one effective snapshot through deduplication and stops at the first match', async () => {
    const contexts: unknown[] = []
    let f: Awaited<ReturnType<typeof fixture>>
    f = await fixture({
      source: async () => ({ status: 'complete', candidates: [candidate(1), candidate(1), candidate(2), candidate(3)] }),
      judgment: async payload => {
        contexts.push(payload.personalContext)
        if (contexts.length === 1) {
          f.respond({ status: 'applied', changes: { additions: [], replacements: [{ target: knowledge, replacement: [novice] }] } })
          await f.app.observeContext({ currentText: 'Actually I am a novice.' })
          return rejected
        }
        return passed
      },
    })
    await expect(f.app.request({ currentText: 'Feed' }, { mode: 'interactive' })).resolves.toEqual({ status: 'one_link', url: candidate(2).canonicalUrl })
    expect(contexts).toEqual([[interest, knowledge], [interest, knowledge]])
    expect(await f.facts()).toEqual([interest, novice])
    expect(await f.records()).toEqual([])
  })

  it('returns a trustworthy candidate together with every source limitation', async () => {
    const f = await fixture({ facts: [], source: async () => ({
      status: 'incomplete',
      stage: 'source_window',
      reason: 'partial_observation',
      candidates: [candidate()],
      limitations: ['partial_observation', 'material_insufficient'],
    }) })

    await expect(f.app.request({ currentText: 'Feed' })).resolves.toEqual({
      status: 'one_link',
      url: candidate().canonicalUrl,
      limitations: ['partial_observation', 'material_insufficient'],
    })
    expect(f.judgmentInputs).toHaveLength(1)
  })

  it('keeps judging after one candidate fails and reports the limitation on a later link', async () => {
    let calls = 0
    const f = await fixture({
      facts: [],
      source: async () => ({ status: 'complete', candidates: [candidate(1), candidate(2)] }),
      judgment: async () => {
        calls += 1
        if (calls === 1) throw new Error('controlled candidate failure')
        return passed
      },
    })

    await expect(f.app.request({ currentText: 'Feed' })).resolves.toEqual({
      status: 'one_link',
      url: candidate(2).canonicalUrl,
      limitations: ['judgement_incomplete'],
    })
    expect(f.judgmentInputs).toHaveLength(2)
  })

  it('does not use or extend the historical processed ledger as an admission filter', async () => {
    const f = await fixture({ facts: [] })
    const historical = {
      schemaVersion: 1,
      event: 'candidate_processed',
      stableId: candidate().stableId,
      canonicalUrl: candidate().canonicalUrl,
      judgment: 'not_qualified',
      processedAt: '2026-09-05T00:00:00.000Z',
    }
    await writeFile(join(f.stateDir, 'candidates.jsonl'), `${JSON.stringify(historical)}\n`)

    await expect(f.app.request({ currentText: 'Feed' })).resolves.toEqual({
      status: 'one_link',
      url: candidate().canonicalUrl,
    })
    expect(f.judgmentInputs).toHaveLength(1)
    expect(await f.records()).toEqual([historical])
  })

  it('does not persist an unfinished or later successful judgment', async () => {
    let attempt = 0
    const f = await fixture({ judgment: async () => ++attempt === 1
      ? { longTermValue: 'pass', longTermInterestMatch: 'not_reached', informationIncrement: 'not_reached' }
      : passed })
    await expect(f.app.request({ currentText: 'Feed' }, { mode: 'interactive' })).resolves.toEqual({ status: 'incomplete', stage: 'judgement_execution' })
    expect(await f.records()).toEqual([])
    await expect(f.app.request({ currentText: 'Try a Feed again.' }, { mode: 'interactive' })).resolves.toEqual({ status: 'one_link', url: candidate().canonicalUrl })
    expect(await f.records()).toEqual([])
  })

  it.each([
    { ...candidate(), body: '' },
    { ...candidate(), canonicalUrl: 'not a URL' },
    { ...candidate(), stableId: 'x-status:2' },
  ])('reports invalid source material as incomplete rather than a storage fault: %j', async invalid => {
    const f = await fixture({ source: async () => ({ status: 'complete', candidates: [invalid] }) })
    await expect(f.app.request({ currentText: 'Feed' }, { mode: 'interactive' })).resolves.toEqual({ status: 'incomplete', stage: 'source_window', reason: 'material_insufficient' })
    expect(f.judgmentInputs).toEqual([])
    expect(await f.records()).toEqual([])
  })

  it('leaves a corrupt historical processed ledger unused and unchanged', async () => {
    const f = await fixture()
    await writeFile(join(f.stateDir, 'candidates.jsonl'), '{invalid json}\n')
    await expect(f.app.request({ currentText: 'Feed' }, { mode: 'interactive' }))
      .resolves.toEqual({ status: 'one_link', url: candidate().canonicalUrl })
    expect(f.judgmentInputs).toHaveLength(1)
    expect(await readFile(join(f.stateDir, 'candidates.jsonl'), 'utf8')).toBe('{invalid json}\n')
  })

  it('does not append a processed record for a Feed judgment', async () => {
    const f = await fixture()
    const append = vi.spyOn(persistence, 'appendJsonLine')
    await expect(f.app.request({ currentText: 'Feed' }, { mode: 'interactive' }))
      .resolves.toEqual({ status: 'one_link', url: candidate().canonicalUrl })
    expect(append).not.toHaveBeenCalled()
    expect(await f.records()).toEqual([])
  })
})
