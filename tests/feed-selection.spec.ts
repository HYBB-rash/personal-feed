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
import { PersonalFeedStorageError } from '../src/errors.ts'
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
  it('blocks unrelated knowledge before even an empty source can hide insufficient context', async () => {
    const f = await fixture({
      facts: [interest, unrelated], context: { status: 'ignored', sufficient: false },
      source: async () => ({ status: 'complete', candidates: [] }),
    })
    await expect(f.app.request({ currentText: 'Give me a family-care Feed.' }))
      .resolves.toEqual({ status: 'incomplete', stage: 'personal_context' })
    expect(f.sourceCalls()).toBe(0)
    expect(f.judgmentInputs).toEqual([])
    expect(await f.records()).toEqual([])
    expect(f.contextInputs).toEqual([{ currentText: 'Give me a family-care Feed.', activeFacts: [interest, unrelated], assessForFeed: true }])
  })

  it('uses an explicit novice update and its sufficiency in the same request', async () => {
    const f = await fixture({ facts: [interest], context: {
      status: 'applied', changes: { additions: [novice], replacements: [] }, sufficient: true,
    } })
    await expect(f.app.request({ currentText: 'I am new to family care; give me a Feed.' }))
      .resolves.toEqual({ status: 'one_link', url: candidate().canonicalUrl })
    expect(f.contextInputs).toHaveLength(1)
    expect(f.contextInputs[0]).toMatchObject({ assessForFeed: true })
    expect(f.judgmentInputs[0]?.personalContext).toEqual([interest, novice])
    expect(await f.facts()).toEqual([interest, novice])
    expect(await f.records()).toMatchObject([{ stableId: 'x-status:1', judgment: 'qualified' }])
  })

  it('commits an explicit update even when it still cannot support this Feed', async () => {
    const f = await fixture({ facts: [interest], context: {
      status: 'applied', changes: { additions: [unrelated], replacements: [] }, sufficient: false,
    } })
    await expect(f.app.request({ currentText: 'I know compilers; give me a family-care Feed.' }))
      .resolves.toEqual({ status: 'incomplete', stage: 'personal_context' })
    expect(await f.facts()).toEqual([interest, unrelated])
    expect(f.sourceCalls()).toBe(0)
    expect(await f.records()).toEqual([])
  })

  it.each([
    { status: 'ignored' },
    { status: 'ignored', sufficient: 'true' },
    { status: 'incomplete' },
  ])('does not select when preparation lacks a usable assessment: %j', async context => {
    const f = await fixture({ context })
    await expect(f.app.request({ currentText: 'Feed' }))
      .resolves.toEqual({ status: 'incomplete', stage: 'context_observation' })
    expect(f.sourceCalls()).toBe(0)
    expect(await f.records()).toEqual([])
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
    await expect(f.app.request({ currentText: 'Feed' })).resolves.toEqual({ status: 'one_link', url: candidate(2).canonicalUrl })
    expect(contexts).toEqual([[interest, knowledge], [interest, knowledge]])
    expect(await f.facts()).toEqual([interest, novice])
    expect(await f.records()).toEqual([
      expect.objectContaining({ stableId: 'x-status:1', judgment: 'not_qualified' }),
      expect.objectContaining({ stableId: 'x-status:2', judgment: 'qualified' }),
    ])
  })

  it('leaves an unfinished judgment unprocessed so a later request can judge it', async () => {
    let attempt = 0
    const f = await fixture({ judgment: async () => ++attempt === 1
      ? { longTermValue: 'pass', longTermInterestMatch: 'not_reached', informationIncrement: 'not_reached' }
      : passed })
    await expect(f.app.request({ currentText: 'Feed' })).resolves.toEqual({ status: 'incomplete', stage: 'judgement_execution' })
    expect(await f.records()).toEqual([])
    await expect(f.app.request({ currentText: 'Try a Feed again.' })).resolves.toEqual({ status: 'one_link', url: candidate().canonicalUrl })
    expect(await f.records()).toHaveLength(1)
  })

  it.each([
    { ...candidate(), body: '' },
    { ...candidate(), canonicalUrl: 'not a URL' },
    { ...candidate(), stableId: 'x-status:2' },
  ])('reports invalid source material as incomplete rather than a storage fault: %j', async invalid => {
    const f = await fixture({ source: async () => ({ status: 'complete', candidates: [invalid] }) })
    await expect(f.app.request({ currentText: 'Feed' })).resolves.toEqual({ status: 'incomplete', stage: 'source_window' })
    expect(f.judgmentInputs).toEqual([])
    expect(await f.records()).toEqual([])
  })

  it('does not turn a corrupt stored ledger into a source incomplete', async () => {
    const f = await fixture()
    await writeFile(join(f.stateDir, 'candidates.jsonl'), '{invalid json}\n')
    await expect(f.app.request({ currentText: 'Feed' })).rejects.toBeInstanceOf(PersonalFeedStorageError)
    expect(f.judgmentInputs).toEqual([])
  })

  it('does not report a Feed result when writing the processed record fails', async () => {
    const f = await fixture()
    vi.spyOn(persistence, 'appendJsonLine').mockRejectedValueOnce(new PersonalFeedStorageError('controlled write failure'))
    await expect(f.app.request({ currentText: 'Feed' })).rejects.toBeInstanceOf(PersonalFeedStorageError)
    expect(await f.records()).toEqual([])
  })
})
