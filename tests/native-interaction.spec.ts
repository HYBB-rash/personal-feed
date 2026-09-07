import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createPersonalFeedApplication, type PersonalFeedModel } from '../src/application.ts'
const interest = { lane: 'long_term_interest', statement: 'editing', stance: 'include' } as const
const knowledge = { lane: 'existing_knowledge', statement: 'I am a novice at editing', epistemic: 'asserted' } as const
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function fixture() {
  const stateDir = await mkdtemp(join(tmpdir(), 'pf-native-'))
  cleanup.push(() => rm(stateDir, { recursive: true, force: true }))
  const model = { assessContext: vi.fn(async () => ({ status: 'completed', sufficient: true })), observeContext: vi.fn(), interpretFeedback: vi.fn(), judgeCandidate: vi.fn() }
  const observer = { observe: vi.fn(async () => ({ status: 'complete' as const, candidates: [] })), close: async () => {} }
  const app = createPersonalFeedApplication({ stateDir, model: model as unknown as PersonalFeedModel, observer })
  cleanup.push(() => app.close())
  return { app, model, observer, stateDir }
}
it('default background discovers without interpreting scheduler text or creating context state', async () => {
  const { app, model, observer, stateDir } = await fixture()
  const ask = vi.fn()
  expect(await app.request({ currentText: 'Daily template: I love investing' }, { ask })).toEqual({
    status: 'incomplete', stage: 'judgement_execution', reason: 'exploration_not_ready',
  })
  expect(model.observeContext).not.toHaveBeenCalled(); expect(model.assessContext).not.toHaveBeenCalled()
  expect(ask).not.toHaveBeenCalled(); expect(observer.observe).toHaveBeenCalledTimes(1)
  await expect(readFile(join(stateDir, 'personal-context.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})
it('background uses saved facts without assessing or committing them', async () => {
  const { app, model, observer, stateDir } = await fixture()
  const path = join(stateDir, 'personal-context.json')
  const saved = JSON.stringify({ schemaVersion: 1, generation: 1, facts: [interest, knowledge] })
  await writeFile(path, saved)
  model.assessContext.mockResolvedValue({ status: 'completed', sufficient: false })
  expect(await app.request({ currentText: 'Scheduled request' })).toEqual({
    status: 'incomplete', stage: 'judgement_execution', reason: 'exploration_not_ready',
  })
  expect(await readFile(path, 'utf8')).toBe(saved)
  expect(model.observeContext).not.toHaveBeenCalled(); expect(model.assessContext).not.toHaveBeenCalled()
  expect(observer.observe).toHaveBeenCalledTimes(1)
})
it('interactive context updates can resolve within one call without starting discovery', async () => {
  const { app, model, observer, stateDir } = await fixture()
  model.observeContext.mockResolvedValueOnce({ status: 'applied', changes: { additions: [interest], replacements: [] }, remaining: { question: 'What do you know?', unresolvedScope: 'knowledge' } })
    .mockResolvedValueOnce({ status: 'applied', changes: { additions: [knowledge], replacements: [] }, remaining: null })
  const ask = vi.fn(async () => {
    expect(JSON.parse(await readFile(join(stateDir, 'personal-context.json'), 'utf8')).facts).toEqual([interest])
    return { action: 'accept' as const, text: 'I am a novice at editing' }
  })
  expect(await app.observeContext({ currentText: 'Editing interests me' }, { mode: 'interactive', ask })).toEqual({ status: 'applied', appliedCount: 2 })
  expect(ask).toHaveBeenCalledTimes(1); expect(observer.observe).not.toHaveBeenCalled()
  expect(model.observeContext.mock.calls[1]?.[0]).toMatchObject({ currentText: 'I am a novice at editing', activeFacts: [interest] })
})
it.each(['decline', 'cancel', 'unavailable', 'timeout'] as const)('preserves explicit facts when an answer ends with %s', async action => {
  const { app, model, observer, stateDir } = await fixture()
  model.observeContext.mockResolvedValue({ status: 'applied', changes: { additions: [interest], replacements: [] }, remaining: { question: 'What else?', unresolvedScope: 'knowledge' } })
  const reasons = { decline: 'interaction_declined', cancel: 'interaction_cancelled', unavailable: 'interaction_unavailable', timeout: 'interaction_timeout' }
  expect(await app.observeContext({ currentText: 'editing interests me' }, { mode: 'interactive', ask: async () => ({ action }) }))
    .toEqual({ status: 'incomplete', stage: 'context_observation', reason: reasons[action] })
  expect(JSON.parse(await readFile(join(stateDir, 'personal-context.json'), 'utf8')).facts).toEqual([interest])
  expect(observer.observe).not.toHaveBeenCalled()
})
it('bounds a non-cooperative answer with the parent deadline and ignores its later text', async () => {
  const { app, model, observer } = await fixture()
  model.observeContext.mockResolvedValue({ status: 'ignored', remaining: { question: 'Profile?', unresolvedScope: 'profile' } })
  const controller = new AbortController(); let resolve!: (reply: any) => void
  const result = await app.observeContext({ currentText: 'Profile' }, { mode: 'interactive', signal: controller.signal, ask: async () => {
    queueMicrotask(() => controller.abort(new DOMException('deadline', 'TimeoutError')))
    return new Promise(done => { resolve = done })
  } })
  expect(result).toMatchObject({ reason: 'interaction_timeout' })
  resolve({ action: 'accept', text: 'Late profile' }); await Promise.resolve()
  expect(model.observeContext).toHaveBeenCalledTimes(1); expect(observer.observe).not.toHaveBeenCalled()
})
it('does not occupy the source selection queue while a context update waits for an answer', async () => {
  const { app, model, observer, stateDir } = await fixture()
  await writeFile(join(stateDir, 'personal-context.json'), JSON.stringify({ schemaVersion: 1, generation: 1, facts: [interest, knowledge] }))
  model.observeContext.mockResolvedValue({ status: 'ignored', remaining: { question: 'Which scope?', unresolvedScope: 'scope' } })
  const result = await app.observeContext({ currentText: 'Different scope' }, { mode: 'interactive', ask: async () => {
    expect(await app.request({ currentText: 'Saved scope' })).toEqual({
      status: 'incomplete', stage: 'judgement_execution', reason: 'exploration_not_ready',
    })
    return { action: 'cancel' }
  } })
  expect(result).toMatchObject({ reason: 'interaction_cancelled' }); expect(observer.observe).toHaveBeenCalledTimes(1)
})
it('completes explicit feedback without asking an independent optional context doubt', async () => {
  const { app, model, stateDir } = await fixture()
  const completed = { status: 'completed', sentiment: 'like', targetText: 'concrete item' }
  model.interpretFeedback.mockResolvedValueOnce({ ...completed, remaining: { question: 'Which prior knowledge?', unresolvedScope: 'knowledge correction' } })
    .mockResolvedValueOnce({ ...completed, remaining: null })
  const ask = vi.fn(async () => ({ action: 'accept' as const, text: 'Leave old knowledge unchanged' }))
  expect(await app.processFeedback({ currentText: 'I like it, but the old knowledge is unclear', referenceText: 'concrete item' }, {
    mode: 'interactive', ask,
  })).toEqual({ status: 'completed' })
  expect(ask).not.toHaveBeenCalled()
  expect(model.interpretFeedback).toHaveBeenCalledTimes(1)
  expect((await readFile(join(stateDir, 'feedback.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(1)
})
