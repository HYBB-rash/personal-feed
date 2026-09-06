import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPersonalFeedApplication } from '../src/application.ts'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
const interest = { lane: 'long_term_interest', statement: 'editing', stance: 'include' } as const
const knowledge = { lane: 'existing_knowledge', statement: 'simple edits are automated', epistemic: 'asserted' } as const
const changes = (additions: unknown[] = [], replacements: unknown[] = []) => ({ additions, replacements })
const remaining = { question: 'Which claim, and which scope?', unresolvedScope: 'claim and scope' }
async function fixture() {
  const stateDir = await mkdtemp(join(tmpdir(), 'pf-d05-'))
  cleanup.push(() => rm(stateDir, { recursive: true, force: true }))
  const model = { observeContext: vi.fn(async () => ({ status: 'ignored' })), interpretFeedback: vi.fn(async () => ({ status: 'pass' })), judgeCandidate: vi.fn() }
  const observer = { observe: vi.fn(async () => ({ status: 'complete', candidates: [] })), close: vi.fn(async () => {}) }
  const app = createPersonalFeedApplication({ stateDir, model: model as never, observer, shutdownTimeoutMs: 5 })
  cleanup.push(() => app.close())
  return { app, model, observer, stateDir, facts: async () => JSON.parse(await readFile(join(stateDir, 'personal-context.json'), 'utf8')).facts }
}

it('commits clear parts over three rounds and carries only the original expression and remaining scope', async () => {
  const { app, model, facts, observer } = await fixture()
  model.observeContext.mockResolvedValueOnce({ status: 'applied', changes: changes([interest]), remaining } as never)
  const first = await app.observeContext({ currentText: 'Editing interests me, but that claim is wrong.' })
  expect(first).toMatchObject({ status: 'applied', appliedCount: 1, question: remaining.question, continuationToken: expect.any(String) })
  expect(await facts()).toEqual([interest])
  model.observeContext.mockResolvedValueOnce({ status: 'applied', changes: changes([knowledge]), remaining: { question: 'What about complex edits?', unresolvedScope: 'complex edits' } } as never)
  const second = await app.observeContext({ currentText: 'Simple edits are automated; complex ones are unclear.', continuationToken: first.continuationToken })
  expect(second.continuationToken).not.toBe(first.continuationToken)
  expect(await facts()).toEqual([interest, knowledge])
  expect(model.observeContext.mock.lastCall![0]).toMatchObject({ activeFacts: [interest], clarification: { originalText: 'Editing interests me, but that claim is wrong.', ...remaining } })
  model.observeContext.mockResolvedValueOnce({ status: 'ignored', remaining: null } as never)
  expect(await app.observeContext({ currentText: 'Leave complex edits unresolved as knowledge; no further correction.', continuationToken: second.continuationToken })).toEqual({ status: 'ignored' })
  expect(model.observeContext.mock.lastCall![0]).toMatchObject({ clarification: { originalText: 'Editing interests me, but that claim is wrong.', question: 'What about complex edits?', unresolvedScope: 'complex edits' } })
  await expect(app.observeContext({ currentText: 'again', continuationToken: first.continuationToken })).resolves.toEqual({ status: 'incomplete', stage: 'context_observation' })
  expect(observer.observe).not.toHaveBeenCalled(); expect(model.judgeCandidate).not.toHaveBeenCalled()
})

it('keeps a separate ordinary update from consuming a question and retains the pair after invalid/model replies', async () => {
  const { app, model, facts } = await fixture()
  model.observeContext.mockResolvedValueOnce({ status: 'ignored', remaining } as never)
  const first = await app.observeContext({ currentText: 'That old claim is wrong.' })
  expect(first.continuationToken).toEqual(expect.any(String))
  model.observeContext.mockResolvedValueOnce({ status: 'applied', changes: changes([interest]) } as never)
  await app.observeContext({ currentText: 'I like editing.' })
  expect(model.observeContext.mock.lastCall![0]).not.toHaveProperty('clarification')
  for (const output of [{ status: 'ignored' }, { status: 'ignored', remaining: {} }, { status: 'applied', changes: changes([knowledge]), remaining: 'bad' }]) {
    model.observeContext.mockResolvedValueOnce(output as never)
    expect(await app.observeContext({ currentText: 'answer', continuationToken: first.continuationToken })).toMatchObject({ status: 'incomplete', question: remaining.question, continuationToken: first.continuationToken })
    expect(await facts()).toEqual([interest])
  }
  model.observeContext.mockRejectedValueOnce(new Error('fixture'))
  expect(await app.observeContext({ currentText: 'answer', continuationToken: first.continuationToken })).toMatchObject({ status: 'incomplete', continuationToken: first.continuationToken })
  model.observeContext.mockResolvedValueOnce({ status: 'ignored', remaining: null } as never)
  expect(await app.observeContext({ currentText: 'withdraw correction', continuationToken: first.continuationToken })).toEqual({ status: 'ignored' })
})

it('preserves the explicit feedback reference across partial replies without inventing a topic exclusion', async () => {
  const { app, model, facts, stateDir, observer } = await fixture()
  model.interpretFeedback.mockResolvedValueOnce({ status: 'needs_input', remaining: { question: 'Why dislike it?', unresolvedScope: 'dislike reason' } } as never)
  const first = await app.processFeedback({ currentText: 'I dislike this.', referenceText: 'original item' })
  expect(first).toMatchObject({ status: 'needs_input', question: 'Why dislike it?', continuationToken: expect.any(String) })
  model.interpretFeedback.mockResolvedValueOnce({ status: 'needs_input', changes: changes([interest]), remaining: { question: 'Which style issue?', unresolvedScope: 'style reason' } } as never)
  const second = await app.processFeedback({ currentText: 'I still like editing, but the style...', continuationToken: first.continuationToken })
  expect(await facts()).toEqual([interest])
  model.interpretFeedback.mockResolvedValueOnce({ status: 'completed', sentiment: 'dislike', targetText: 'original item', reason: 'sensational style', remaining: null } as never)
  expect(await app.processFeedback({ currentText: 'Too sensational.', referenceText: 'a conflicting new reference', continuationToken: second.continuationToken })).toEqual({ status: 'completed' })
  expect(model.interpretFeedback.mock.lastCall![0]).toMatchObject({ referenceText: 'original item', activeFacts: [interest], clarification: { originalText: 'I dislike this.', referenceText: 'original item', question: 'Which style issue?', unresolvedScope: 'style reason' } })
  expect(await facts()).toEqual([interest])
  expect((await readFile(join(stateDir, 'feedback.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(1)
  expect(observer.observe).not.toHaveBeenCalled(); expect(model.judgeCandidate).not.toHaveBeenCalled()
})

it('rejects a dislike without a reason and an answer sent to the wrong tool', async () => {
  const { app, model } = await fixture()
  model.interpretFeedback.mockResolvedValueOnce({ status: 'completed', sentiment: 'dislike', targetText: 'item', remaining: null } as never)
  expect(await app.processFeedback({ currentText: 'dislike', referenceText: 'item' })).toEqual({ status: 'incomplete', stage: 'feedback_interpretation' })
  model.interpretFeedback.mockResolvedValueOnce({ status: 'needs_input', remaining } as never)
  const first = await app.processFeedback({ currentText: 'dislike' })
  expect(first.continuationToken).toEqual(expect.any(String))
  expect(await app.observeContext({ currentText: 'answer', continuationToken: first.continuationToken })).toEqual({ status: 'incomplete', stage: 'context_observation' })
  expect(model.observeContext).not.toHaveBeenCalled()
  model.interpretFeedback.mockResolvedValueOnce({ status: 'discarded', remaining: null } as never)
  expect(await app.processFeedback({ currentText: 'never mind', continuationToken: first.continuationToken })).toEqual({ status: 'discarded' })
  expect(await app.processFeedback({ currentText: 'repeat', continuationToken: first.continuationToken })).toEqual({ status: 'incomplete', stage: 'feedback_interpretation' })
})

it('allows only one concurrent answer to commit', async () => {
  const { app, model, facts } = await fixture()
  model.observeContext.mockResolvedValueOnce({ status: 'ignored', remaining } as never)
  const first = await app.observeContext({ currentText: 'unclear' })
  expect(first.continuationToken).toEqual(expect.any(String))
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let started = 0
  model.observeContext.mockImplementation(async () => { if (++started === 2) release(); await gate; return { status: 'applied', changes: changes([interest]), remaining: null } as never })
  const replies = await Promise.all([1, 2].map(() => app.observeContext({ currentText: 'editing', continuationToken: first.continuationToken })))
  expect(replies.map(reply => reply.status).sort()).toEqual(['applied', 'incomplete'])
  expect(replies.find(reply => reply.status === 'incomplete')).not.toHaveProperty('continuationToken')
  expect(await facts()).toEqual([interest])
})

it('retains facts and the usable question after a feedback ledger fault, then retries against current facts', async () => {
  const { app, model, facts, stateDir } = await fixture()
  model.interpretFeedback.mockResolvedValueOnce({ status: 'needs_input', remaining } as never)
  const first = await app.processFeedback({ currentText: 'unclear', referenceText: 'item' })
  expect(first.continuationToken).toEqual(expect.any(String))
  const ledger = join(stateDir, 'feedback.jsonl')
  await mkdir(ledger)
  model.interpretFeedback.mockResolvedValue({ status: 'completed', sentiment: 'dislike', targetText: 'item', reason: 'style', changes: changes([interest]), remaining: null } as never)
  await expect(app.processFeedback({ currentText: 'style', continuationToken: first.continuationToken })).rejects.toMatchObject({ name: 'PersonalFeedStorageError' })
  expect(await facts()).toEqual([interest])
  await rm(ledger, { recursive: true })
  expect(await app.processFeedback({ currentText: 'style', continuationToken: first.continuationToken })).toEqual({ status: 'completed' })
  expect(model.interpretFeedback.mock.lastCall![0]).toMatchObject({ activeFacts: [interest], clarification: remaining })
  expect((await readFile(ledger, 'utf8')).trim().split('\n')).toHaveLength(1)
})

it('loses process questions on restart but retains facts and leaves the legacy snapshot untouched', async () => {
  const { app, model, stateDir, observer, facts } = await fixture()
  const legacy = join(stateDir, 'pending-feedback.json')
  await writeFile(legacy, 'not even valid JSON')
  model.observeContext.mockResolvedValueOnce({ status: 'applied', changes: changes([interest]), remaining } as never)
  const first = await app.observeContext({ currentText: 'editing and something unclear' })
  expect(first.continuationToken).toEqual(expect.any(String))
  await app.close()
  const reopened = createPersonalFeedApplication({ stateDir, model: model as never, observer, shutdownTimeoutMs: 5 })
  cleanup.push(() => reopened.close())
  expect(await reopened.observeContext({ currentText: 'answer', continuationToken: first.continuationToken })).toEqual({ status: 'incomplete', stage: 'context_observation' })
  expect(await facts()).toEqual([interest]); expect(await readFile(legacy, 'utf8')).toBe('not even valid JSON')
})

it('withdraws only the explicit target and keeps the uncertain correction pending', async () => {
  const { app, model, facts } = await fixture()
  model.observeContext.mockResolvedValueOnce({ status: 'applied', changes: changes([interest, knowledge]) } as never)
  await app.observeContext({ currentText: 'initial explicit facts' })
  model.observeContext.mockResolvedValueOnce({ status: 'applied', changes: changes([], [{ target: knowledge, replacement: [] }]), remaining } as never)
  const reply = await app.observeContext({ currentText: 'Withdraw simple edits; another claim is unclear.' })
  expect(reply).toMatchObject({ status: 'applied', appliedCount: 1, question: remaining.question })
  expect(await facts()).toEqual([interest])
})

it('keeps the original context question after a context storage fault', async () => {
  const { app, model, stateDir } = await fixture()
  model.observeContext.mockResolvedValueOnce({ status: 'ignored', remaining } as never)
  const first = await app.observeContext({ currentText: 'unclear' })
  const contextPath = join(stateDir, 'personal-context.json')
  const snapshot = await readFile(contextPath, 'utf8')
  model.observeContext.mockImplementationOnce(async () => {
    await rm(contextPath); await mkdir(contextPath)
    return { status: 'applied', changes: changes([interest]), remaining: null } as never
  })
  await expect(app.observeContext({ currentText: 'editing', continuationToken: first.continuationToken })).rejects.toMatchObject({ name: 'PersonalFeedStorageError' })
  await rm(contextPath, { recursive: true }); await writeFile(contextPath, snapshot)
  model.observeContext.mockResolvedValueOnce({ status: 'applied', changes: changes([interest]), remaining: null } as never)
  expect(await app.observeContext({ currentText: 'editing', continuationToken: first.continuationToken })).toEqual({ status: 'applied', appliedCount: 1 })
})

it.each([false, true])('preserves a Feed question while reusing D04 assessment (sufficient=%s)', async sufficient => {
  const { app, model, observer } = await fixture()
  model.observeContext.mockResolvedValueOnce({ status: 'applied', changes: changes([interest, knowledge]), sufficient, remaining } as never)
  expect(await app.request({ currentText: 'Feed with a remaining question' })).toMatchObject({ status: sufficient ? 'business_empty' : 'incomplete', question: remaining.question, continuationToken: expect.any(String) })
  expect(model.observeContext.mock.lastCall![0]).toMatchObject({ assessForFeed: true })
  expect(observer.observe).toHaveBeenCalledTimes(sufficient ? 1 : 0)
})

it('does not consume a feedback question on model failure or mismatched ledger event', async () => {
  const { createHash } = await import('node:crypto')
  const { app, model, stateDir } = await fixture()
  model.interpretFeedback.mockResolvedValueOnce({ status: 'needs_input', remaining } as never)
  const first = await app.processFeedback({ currentText: 'unclear', referenceText: 'item' })
  model.interpretFeedback.mockRejectedValueOnce(new Error('fixture model failure'))
  expect(await app.processFeedback({ currentText: 'reason', continuationToken: first.continuationToken })).toMatchObject({ status: 'incomplete', question: remaining.question, continuationToken: first.continuationToken })
  const event = { schemaVersion: 1, id: `continuation:${createHash('sha256').update(first.continuationToken!).digest('hex')}`, sentiment: 'like', targetText: 'different item', createdAt: '2026-09-06T00:00:00.000Z' }
  const ledger = join(stateDir, 'feedback.jsonl')
  await writeFile(ledger, `${JSON.stringify(event)}\n`)
  model.interpretFeedback.mockResolvedValue({ status: 'completed', sentiment: 'dislike', targetText: 'item', reason: 'style', remaining: null } as never)
  await expect(app.processFeedback({ currentText: 'style', continuationToken: first.continuationToken })).rejects.toMatchObject({ name: 'PersonalFeedStorageError' })
  expect(await readFile(ledger, 'utf8')).toBe(`${JSON.stringify(event)}\n`)
  await rm(ledger)
  expect(await app.processFeedback({ currentText: 'style', continuationToken: first.continuationToken })).toEqual({ status: 'completed' })
})

it('keeps an object first identified in the middle reply until its reason is resolved', async () => {
  const { app, model, stateDir } = await fixture()
  model.interpretFeedback.mockResolvedValueOnce({ status: 'needs_input', remaining: { question: 'Which item?', unresolvedScope: 'target and reason' } } as never)
  const first = await app.processFeedback({ currentText: 'I dislike it.' })
  model.interpretFeedback.mockResolvedValueOnce({ status: 'needs_input', resolvedReferenceText: 'post A', remaining: { question: 'Why dislike it?', unresolvedScope: 'reason' } } as never)
  const second = await app.processFeedback({ currentText: 'Post A.', continuationToken: first.continuationToken })
  model.interpretFeedback.mockImplementationOnce(async input => ({ status: 'completed', sentiment: 'dislike', targetText: input.referenceText, reason: 'sensational style', remaining: null }) as never)
  expect(await app.processFeedback({ currentText: 'Sensational style.', continuationToken: second.continuationToken })).toEqual({ status: 'completed' })
  expect(model.interpretFeedback.mock.lastCall![0]).toMatchObject({ referenceText: 'post A', clarification: { originalText: 'I dislike it.', referenceText: 'post A', question: 'Why dislike it?', unresolvedScope: 'reason' } })
  expect(JSON.parse((await readFile(join(stateDir, 'feedback.jsonl'), 'utf8')).trim()).targetText).toBe('post A')
  for (const token of [first.continuationToken, second.continuationToken]) expect(await app.processFeedback({ currentText: 'again', continuationToken: token })).toEqual({ status: 'incomplete', stage: 'feedback_interpretation' })
})
