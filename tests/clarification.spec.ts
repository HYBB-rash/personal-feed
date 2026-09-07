import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPersonalFeedApplication, type PersonalFeedModel } from '../src/application.ts'
import type { InteractionOptions } from '../src/interaction.ts'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
const interest = { lane: 'long_term_interest', statement: 'editing', stance: 'include' } as const
const knowledge = { lane: 'existing_knowledge', statement: 'simple edits are automated', epistemic: 'asserted' } as const
const changes = (additions: unknown[] = [], replacements: unknown[] = []) => ({ additions, replacements })
const remaining = { question: 'Which claim, and which scope?', unresolvedScope: 'claim and scope' }
const interactive = (ask: NonNullable<InteractionOptions['ask']>): InteractionOptions => ({ mode: 'interactive', ask })
async function fixture() {
  const stateDir = await mkdtemp(join(tmpdir(), 'pf-d05-'))
  cleanup.push(() => rm(stateDir, { recursive: true, force: true }))
  const model = {
    observeContext: vi.fn<PersonalFeedModel['observeContext']>().mockResolvedValue({ status: 'ignored' }),
    interpretFeedback: vi.fn<PersonalFeedModel['interpretFeedback']>().mockResolvedValue({ status: 'pass' }),
    assessContext: vi.fn<PersonalFeedModel['assessContext']>().mockResolvedValue({ status: 'completed', sufficient: true }),
    judgeCandidate: vi.fn<PersonalFeedModel['judgeCandidate']>(),
  }
  const observer = { observe: vi.fn(async () => ({ status: 'complete' as const, candidates: [] })), close: vi.fn(async () => {}) }
  const app = createPersonalFeedApplication({ stateDir, model, observer, shutdownTimeoutMs: 5 })
  cleanup.push(() => app.close())
  return { app, model, observer, stateDir, facts: async () => JSON.parse(await readFile(join(stateDir, 'personal-context.json'), 'utf8')).facts }
}

it('commits clear parts during one call and preserves the original expression and remaining scope', async () => {
  const { app, model, facts, observer } = await fixture()
  model.observeContext.mockResolvedValueOnce({ status: 'applied', changes: changes([interest]), remaining } as never)
    .mockResolvedValueOnce({ status: 'applied', changes: changes([knowledge]), remaining: { question: 'What about complex edits?', unresolvedScope: 'complex edits' } } as never)
    .mockResolvedValueOnce({ status: 'ignored', remaining: null })
  let round = 0
  const ask = vi.fn(async (question: string) => {
    if (round++ === 0) {
      expect(question).toBe(remaining.question)
      expect(await facts()).toEqual([interest])
      return { action: 'accept' as const, text: 'Simple edits are automated; complex ones are unclear.' }
    }
    expect(question).toBe('What about complex edits?')
    expect(await facts()).toEqual([interest, knowledge])
    return { action: 'accept' as const, text: 'Leave complex edits unresolved as knowledge; no further correction.' }
  })
  expect(await app.observeContext({ currentText: 'Editing interests me, but that claim is wrong.' }, interactive(ask))).toEqual({ status: 'applied', appliedCount: 2 })
  expect(model.observeContext.mock.calls[1]![0]).toMatchObject({ activeFacts: [interest], clarification: { originalText: 'Editing interests me, but that claim is wrong.', ...remaining } })
  expect(model.observeContext.mock.lastCall![0]).toMatchObject({ clarification: { originalText: 'Editing interests me, but that claim is wrong.', question: 'What about complex edits?', unresolvedScope: 'complex edits' } })
  expect(ask).toHaveBeenCalledTimes(2)
  expect(observer.observe).not.toHaveBeenCalled(); expect(model.judgeCandidate).not.toHaveBeenCalled()
})

it.each([
  { status: 'ignored' },
  { status: 'ignored', remaining: {} },
  { status: 'applied', changes: changes([knowledge]), remaining: 'bad' },
])('keeps independent updates while an invalid answer ends only its own call (%j)', async output => {
  const { app, model, facts } = await fixture()
  model.observeContext.mockResolvedValueOnce({ status: 'ignored', remaining })
  const ask = vi.fn(async () => {
    model.observeContext.mockResolvedValueOnce({ status: 'applied', changes: changes([interest]) } as never)
    await app.observeContext({ currentText: 'I like editing.' })
    expect(model.observeContext.mock.lastCall![0]).not.toHaveProperty('clarification')
    model.observeContext.mockResolvedValueOnce(output as never)
    return { action: 'accept' as const, text: 'answer' }
  })
  expect(await app.observeContext({ currentText: 'That old claim is wrong.' }, interactive(ask))).toMatchObject({ status: 'incomplete', stage: 'context_observation' })
  expect(await facts()).toEqual([interest])
  expect(ask).toHaveBeenCalledTimes(1)
  await app.observeContext({ currentText: 'a separate later expression' })
  expect(model.observeContext.mock.lastCall![0]).not.toHaveProperty('clarification')
})

it('preserves the feedback reference through partial raw answers without inventing a topic exclusion', async () => {
  const { app, model, facts, stateDir, observer } = await fixture()
  model.interpretFeedback.mockResolvedValueOnce({ status: 'needs_input', remaining: { question: 'Why dislike it?', unresolvedScope: 'dislike reason' } })
    .mockResolvedValueOnce({ status: 'needs_input', changes: changes([interest]), remaining: { question: 'Which style issue?', unresolvedScope: 'style reason' } } as never)
    .mockResolvedValueOnce({ status: 'completed', sentiment: 'dislike', targetText: 'original item', reason: 'sensational style', remaining: null })
  const answers = ['I still like editing, but the style...', '  Too sensational.  ']
  const ask = vi.fn(async () => ({ action: 'accept' as const, text: answers.shift()! }))
  expect(await app.processFeedback({ currentText: 'I dislike this.', referenceText: 'original item' }, interactive(ask))).toEqual({ status: 'completed' })
  expect(model.interpretFeedback.mock.lastCall![0]).toMatchObject({ currentText: '  Too sensational.  ', referenceText: 'original item', activeFacts: [interest], clarification: { originalText: 'I dislike this.', referenceText: 'original item', question: 'Which style issue?', unresolvedScope: 'style reason' } })
  expect(await facts()).toEqual([interest])
  expect((await readFile(join(stateDir, 'feedback.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(1)
  expect(observer.observe).not.toHaveBeenCalled(); expect(model.judgeCandidate).not.toHaveBeenCalled()
})

it('rejects a reasonless dislike and refuses the removed cross-call token input', async () => {
  const { app, model } = await fixture()
  model.interpretFeedback.mockResolvedValueOnce({ status: 'completed', sentiment: 'dislike', targetText: 'item', remaining: null } as never)
  expect(await app.processFeedback({ currentText: 'dislike', referenceText: 'item' })).toEqual({ status: 'incomplete', stage: 'feedback_interpretation' })
  const input = { currentText: 'answer', continuationToken: 'A'.repeat(43) }
  await expect(app.observeContext(input as never)).rejects.toMatchObject({ name: 'PersonalFeedInputError' })
  await expect(app.processFeedback(input as never)).rejects.toMatchObject({ name: 'PersonalFeedInputError' })
  expect(model.observeContext).not.toHaveBeenCalled()
  expect(model.interpretFeedback).toHaveBeenCalledTimes(1)
})

it('retains committed facts after feedback storage failure and recovers only through a new explicit call', async () => {
  const { app, model, facts, stateDir } = await fixture()
  const ledger = join(stateDir, 'feedback.jsonl')
  model.interpretFeedback.mockResolvedValueOnce({ status: 'needs_input', remaining })
  const ask = vi.fn(async () => {
    await mkdir(ledger)
    model.interpretFeedback.mockResolvedValue({ status: 'completed', sentiment: 'dislike', targetText: 'item', reason: 'style', changes: changes([interest]), remaining: null } as never)
    return { action: 'accept' as const, text: 'style' }
  })
  await expect(app.processFeedback({ currentText: 'unclear', referenceText: 'item' }, interactive(ask))).rejects.toMatchObject({ name: 'PersonalFeedStorageError' })
  expect(await facts()).toEqual([interest])
  await rm(ledger, { recursive: true })
  expect(await app.processFeedback({ currentText: 'I dislike this style.', referenceText: 'item' })).toEqual({ status: 'completed' })
  expect(model.interpretFeedback.mock.lastCall![0]).toMatchObject({ activeFacts: [interest] })
  expect(model.interpretFeedback.mock.lastCall![0]).not.toHaveProperty('clarification')
  expect((await readFile(ledger, 'utf8')).trim().split('\n')).toHaveLength(1)
})

it('ends a pending question on close while retaining facts and leaving unrelated legacy files untouched', async () => {
  const { app, model, stateDir, observer, facts } = await fixture()
  const legacy = join(stateDir, 'pending-feedback.json')
  await writeFile(legacy, 'not even valid JSON')
  model.observeContext.mockResolvedValueOnce({ status: 'applied', changes: changes([interest]), remaining } as never)
  const asked = Promise.withResolvers<void>()
  const pending = app.observeContext({ currentText: 'editing and something unclear' }, interactive(async () => {
    asked.resolve()
    return new Promise(() => {})
  }))
  await asked.promise
  await app.close()
  expect(await pending).toMatchObject({ status: 'incomplete', reason: 'interaction_cancelled' })
  const reopened = createPersonalFeedApplication({ stateDir, model, observer, shutdownTimeoutMs: 5 })
  cleanup.push(() => reopened.close())
  await reopened.observeContext({ currentText: 'another explicit expression' })
  expect(model.observeContext.mock.lastCall![0]).not.toHaveProperty('clarification')
  expect(await facts()).toEqual([interest]); expect(await readFile(legacy, 'utf8')).toBe('not even valid JSON')
})

it('withdraws only the explicit target even when the remaining question is cancelled', async () => {
  const { app, model, facts } = await fixture()
  model.observeContext.mockResolvedValueOnce({ status: 'applied', changes: changes([interest, knowledge]) } as never)
  await app.observeContext({ currentText: 'initial explicit facts' })
  model.observeContext.mockResolvedValueOnce({ status: 'applied', changes: changes([], [{ target: knowledge, replacement: [] }]), remaining } as never)
  const result = await app.observeContext({ currentText: 'Withdraw simple edits; another claim is unclear.' }, interactive(async () => ({ action: 'cancel' })))
  expect(result).toMatchObject({ status: 'incomplete', reason: 'interaction_cancelled' })
  expect(await facts()).toEqual([interest])
})

it('ends a question on context storage failure without silently replaying it after repair', async () => {
  const { app, model, stateDir } = await fixture()
  model.observeContext.mockResolvedValueOnce({ status: 'ignored', remaining })
  const contextPath = join(stateDir, 'personal-context.json')
  let snapshot = ''
  await expect(app.observeContext({ currentText: 'unclear' }, interactive(async () => {
    snapshot = await readFile(contextPath, 'utf8')
    model.observeContext.mockImplementationOnce(async () => {
      await rm(contextPath); await mkdir(contextPath)
      return { status: 'applied', changes: changes([interest]), remaining: null } as never
    })
    return { action: 'accept', text: 'editing' }
  }))).rejects.toMatchObject({ name: 'PersonalFeedStorageError' })
  await rm(contextPath, { recursive: true }); await writeFile(contextPath, snapshot)
  model.observeContext.mockResolvedValueOnce({ status: 'applied', changes: changes([interest]) } as never)
  expect(await app.observeContext({ currentText: 'I like editing.' })).toEqual({ status: 'applied', appliedCount: 1 })
  expect(model.observeContext.mock.lastCall![0]).not.toHaveProperty('clarification')
})

it('does not turn an optional context question into a discovery gate', async () => {
  const { app, model, observer } = await fixture()
  model.observeContext.mockResolvedValueOnce({ status: 'applied', changes: changes([interest, knowledge]), remaining } as never)
  const ask = vi.fn(async () => ({ action: 'cancel' as const }))
  const result = await app.request({ currentText: 'Feed with a remaining question' }, interactive(ask))
  expect(result).toEqual({ status: 'incomplete', stage: 'judgement_execution', reason: 'exploration_not_ready' })
  expect(observer.observe).toHaveBeenCalledTimes(1)
  expect(model.observeContext).not.toHaveBeenCalled()
  expect(ask).not.toHaveBeenCalled()
})

it('does not write feedback on model failure or silently overwrite a damaged ledger', async () => {
  const { app, model, stateDir } = await fixture()
  model.interpretFeedback.mockResolvedValueOnce({ status: 'needs_input', remaining })
  const result = await app.processFeedback({ currentText: 'unclear', referenceText: 'item' }, interactive(async () => {
    model.interpretFeedback.mockRejectedValueOnce(new Error('fixture model failure'))
    return { action: 'accept', text: 'reason' }
  }))
  expect(result).toEqual({ status: 'incomplete', stage: 'feedback_interpretation' })
  const ledger = join(stateDir, 'feedback.jsonl')
  await expect(readFile(ledger, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  await writeFile(ledger, '{invalid ledger\n')
  model.interpretFeedback.mockResolvedValue({ status: 'completed', sentiment: 'dislike', targetText: 'item', reason: 'style', remaining: null })
  await expect(app.processFeedback({ currentText: 'I dislike its style.', referenceText: 'item' })).rejects.toMatchObject({ name: 'PersonalFeedStorageError' })
  expect(await readFile(ledger, 'utf8')).toBe('{invalid ledger\n')
})

it('retains a target identified in the middle answer until its reason is resolved', async () => {
  const { app, model, stateDir } = await fixture()
  model.interpretFeedback.mockResolvedValueOnce({ status: 'needs_input', remaining: { question: 'Which item?', unresolvedScope: 'target and reason' } })
    .mockResolvedValueOnce({ status: 'needs_input', resolvedReferenceText: 'post A', remaining: { question: 'Why dislike it?', unresolvedScope: 'reason' } })
    .mockImplementationOnce(async input => ({ status: 'completed', sentiment: 'dislike', targetText: input.referenceText!, reason: 'sensational style', remaining: null }))
  const answers = ['Post A.', 'Sensational style.']
  expect(await app.processFeedback({ currentText: 'I dislike it.' }, interactive(async () => ({ action: 'accept', text: answers.shift()! })))).toEqual({ status: 'completed' })
  expect(model.interpretFeedback.mock.lastCall![0]).toMatchObject({ referenceText: 'post A', clarification: { originalText: 'I dislike it.', referenceText: 'post A', question: 'Why dislike it?', unresolvedScope: 'reason' } })
  expect(JSON.parse((await readFile(join(stateDir, 'feedback.jsonl'), 'utf8')).trim()).targetText).toBe('post A')
})
