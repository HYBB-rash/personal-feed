import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createPersonalFeedApplication, type PersonalContextFact, type XObserver } from '../src/application.ts'
import { createOpenAICompatiblePersonalFeedModel } from '../src/openai-compatible-model.ts'

const interest = { lane: 'long_term_interest', statement: 'AI video production', stance: 'include' } as const
const knowledge = { lane: 'existing_knowledge', statement: 'I know generated shots still need editing', epistemic: 'asserted' } as const
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  vi.unstubAllGlobals()
  for (const close of cleanup.splice(0).reverse()) await close()
})

async function fixture(facts: readonly PersonalContextFact[]) {
  const stateDir = await mkdtemp(join(tmpdir(), 'pf-context-acceptance-'))
  cleanup.push(() => rm(stateDir, { recursive: true, force: true }))
  const path = join(stateDir, 'personal-context.json')
  await writeFile(path, JSON.stringify({ schemaVersion: 1, generation: 1, facts }))
  let response: unknown = { status: 'ignored', sufficient: false }
  const payloads: Record<string, unknown>[] = []
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    payloads.push(JSON.parse(JSON.parse(init.body).messages[1].content))
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(response) } }] }))
  }))
  const observer: XObserver = { observe: vi.fn(async () => ({ status: 'complete' as const, candidates: [] })), close: async () => {} }
  const events: unknown[] = []
  const app = createPersonalFeedApplication({
    stateDir, observer, onFailure: event => events.push(event),
    model: createOpenAICompatiblePersonalFeedModel({ baseURL: 'http://127.0.0.1:1', model: 'fixture', apiKey: 'fixture', timeoutMs: 1000 }),
  })
  cleanup.push(() => app.close())
  return { app, observer, events, payloads, respond: (value: unknown) => { response = value },
    facts: async () => JSON.parse(await readFile(path, 'utf8')).facts }
}

it.each([
  { name: 'empty', facts: [] },
  { name: 'partial', facts: [interest] },
  { name: 'uncertain', facts: [interest, { ...knowledge, epistemic: 'uncertain' as const }] },
])('A02 V0: discovers directly with $name context and never asks for profile completion', async scenario => {
  const f = await fixture(scenario.facts)
  const ask = vi.fn(async () => ({ action: 'cancel' as const }))
  const before = await f.facts()
  expect(await f.app.request({ currentText: '给我一次个人 Feed' }, { mode: 'interactive', ask })).toEqual({
    status: 'incomplete', stage: 'judgement_execution', reason: 'exploration_not_ready',
  })
  expect(ask).not.toHaveBeenCalled()
  expect(f.payloads).toEqual([])
  expect(f.observer.observe).toHaveBeenCalledTimes(1)
  expect(await f.facts()).toEqual(before)
})

it('an ordinary update has no sufficiency fallback and never starts Feed', async () => {
  const f = await fixture([])
  f.respond({ status: 'applied', changes: { additions: [interest], replacements: [] } })
  expect(await f.app.observeContext({ currentText: '明确的关注' })).toEqual({ status: 'applied', appliedCount: 1 })
  expect(f.observer.observe).not.toHaveBeenCalled()
})

it.each(['observation_failed', 'partial_observation', 'material_insufficient'] as const)('preserves the actual source cause: %s', async reason => {
  const f = await fixture([interest, knowledge])
  f.respond({ status: 'ignored', sufficient: true })
  vi.mocked(f.observer.observe).mockResolvedValue({ status: 'incomplete', stage: 'source_window', reason })
  expect(await f.app.request({ currentText: 'Feed' }, { mode: 'interactive' })).toEqual({ status: 'incomplete', stage: 'source_window', reason })
})

it('diagnoses an invalid feedback replacement without logging its target or changing facts', async () => {
  const f = await fixture([interest, knowledge])
  f.respond({ status: 'completed', sentiment: 'dislike', targetText: 'private-target', reason: 'private-reason',
    changes: { additions: [], replacements: [{ target: { ...knowledge, statement: 'private-missing-target' }, replacement: [] }] } })
  expect(await f.app.processFeedback({ currentText: 'private-reply', referenceText: 'private-target' }))
    .toEqual({ status: 'incomplete', stage: 'feedback_interpretation' })
  expect(f.events).toEqual([{ event: 'application_failure', operation: 'process_feedback', reason: 'context_changes_invalid' }])
  expect(JSON.stringify(f.events)).not.toContain('private-')
  expect(await f.facts()).toEqual([interest, knowledge])
})

it('clears its shutdown deadline when an idle application closes normally', async () => {
  const f = await fixture([])
  vi.useFakeTimers()
  try {
    await f.app.close()
    expect(vi.getTimerCount()).toBe(0)
  } finally { vi.useRealTimers() }
})
