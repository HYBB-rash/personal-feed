import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createPersonalFeedApplication,
  type ContextChanges,
  type PersonalContextFact,
  type PersonalFeedModel,
} from '../src/application.ts'
import { PersonalFeedStorageError } from '../src/errors.ts'
import * as persistence from '../src/persistence.ts'

const interest = { lane: 'long_term_interest', statement: 'video editing', stance: 'include' } as const
const broad = { lane: 'existing_knowledge', statement: 'All editing can be automated', epistemic: 'asserted' } as const
const other = { lane: 'existing_knowledge', statement: 'I know audio mixing', epistemic: 'asserted' } as const
const narrow = { ...broad, statement: 'Simple edits can be automated' } as const
const doubt = { ...broad, statement: 'Complex edits remain unclear', epistemic: 'uncertain' } as const
const cleanup: Array<() => Promise<unknown>> = []

afterEach(async () => {
  vi.restoreAllMocks()
  for (const close of cleanup.splice(0).reverse()) await close()
})

async function fixture(facts: readonly PersonalContextFact[] = [interest, broad, other]) {
  const stateDir = await mkdtemp(join(tmpdir(), 'personal-feed-context-'))
  cleanup.push(() => rm(stateDir, { recursive: true, force: true }))
  const path = join(stateDir, 'personal-context.json')
  await writeFile(path, JSON.stringify({ schemaVersion: 1, generation: 7, facts }))
  const observeContext = vi.fn<PersonalFeedModel['observeContext']>(async ({ assessForFeed }) => ({
    status: 'ignored', ...(assessForFeed ? { sufficient: true } : {}),
  }))
  const judgeCandidate = vi.fn<PersonalFeedModel['judgeCandidate']>(async () => ({ status: 'qualified' }))
  const observe = vi.fn(async () => ({ status: 'complete' as const, candidates: [{
    stableId: 'x-status:1', canonicalUrl: 'https://x.com/fixture/status/1',
    body: 'A controlled editing example', authorHandle: 'fixture', publishedAt: '2026-09-06T00:00:00.000Z',
  }] }))
  const app = createPersonalFeedApplication({
    stateDir,
    model: { observeContext, judgeCandidate, interpretFeedback: async () => ({ status: 'pass' }) },
    observer: { observe, close: async () => {} },
    shutdownTimeoutMs: 5,
  })
  cleanup.push(() => app.close())
  return {
    app, path, stateDir, observeContext, judgeCandidate, observe,
    read: async () => JSON.parse(await readFile(path, 'utf8')) as { schemaVersion: number; generation: number; facts: PersonalContextFact[] },
    change: (changes: ContextChanges) => observeContext.mockImplementationOnce(async ({ assessForFeed }) => ({
      status: 'applied', changes, ...(assessForFeed ? { sufficient: true } : {}),
    })),
  }
}

describe('explicit personal-context changes', () => {
  it('replaces a rephrased claim immediately while preserving unrelated facts and avoiding a Feed', async () => {
    const f = await fixture()
    f.change({ additions: [], replacements: [{ target: broad, replacement: [narrow] }] })
    await expect(f.app.observeContext({ currentText: 'Only simple edits can be automated.' }))
      .resolves.toEqual({ status: 'applied', appliedCount: 1 })
    expect((await f.read()).facts).toEqual([interest, narrow, other])
    expect(f.observe).not.toHaveBeenCalled()
    expect(f.judgeCandidate).not.toHaveBeenCalled()
  })

  it('withdraws only the targeted knowledge and counts a removal as a change', async () => {
    const f = await fixture()
    f.change({ additions: [], replacements: [{ target: broad, replacement: [] }] })
    await expect(f.app.observeContext({ currentText: 'Withdraw the automation claim.' }))
      .resolves.toEqual({ status: 'applied', appliedCount: 1 })
    expect((await f.read()).facts).toEqual([interest, other])
  })

  it('counts a same-length stance replacement and permits a later return to that interest', async () => {
    const f = await fixture()
    const excluded = { ...interest, stance: 'exclude' } as const
    f.change({ additions: [], replacements: [{ target: interest, replacement: [excluded] }] })
    await expect(f.app.observeContext({ currentText: 'I no longer follow video editing.' }))
      .resolves.toEqual({ status: 'applied', appliedCount: 1 })
    expect((await f.read()).facts).toEqual([excluded, broad, other])
    f.change({ additions: [], replacements: [{ target: excluded, replacement: [interest] }] })
    await expect(f.app.observeContext({ currentText: 'I follow video editing again.' }))
      .resolves.toEqual({ status: 'applied', appliedCount: 1 })
    expect((await f.read()).facts).toEqual([interest, broad, other])
  })

  it('adds facts without duplicating repeated additions or requiring a complete profile', async () => {
    const f = await fixture([])
    f.change({ additions: [interest, interest], replacements: [] })
    await expect(f.app.observeContext({ currentText: 'I follow video editing.' }))
      .resolves.toEqual({ status: 'applied', appliedCount: 1 })
    f.change({ additions: [interest], replacements: [] })
    await expect(f.app.observeContext({ currentText: 'I still follow video editing.' }))
      .resolves.toEqual({ status: 'applied', appliedCount: 0 })
    expect((await f.read()).facts).toEqual([interest])
    expect(f.observe).not.toHaveBeenCalled()
  })

  it('reports zero for identity replacement and repeated facts', async () => {
    const f = await fixture()
    f.change({ additions: [other], replacements: [{ target: broad, replacement: [broad, broad] }] })
    await expect(f.app.observeContext({ currentText: 'Keep my existing understanding.' }))
      .resolves.toEqual({ status: 'applied', appliedCount: 0 })
    expect((await f.read()).facts).toEqual([interest, broad, other])
  })

  it.each([
    { additions: [], replacements: [{ target: broad, replacement: [broad, other] }] },
    { additions: [broad], replacements: [{ target: broad, replacement: [] }] },
  ])('does not count operations that leave the stored facts unchanged', async changes => {
    const f = await fixture()
    f.change(changes)
    await expect(f.app.observeContext({ currentText: 'Keep those facts.' }))
      .resolves.toEqual({ status: 'applied', appliedCount: 0 })
    expect((await f.read()).facts).toEqual(expect.arrayContaining([interest, broad, other]))
    expect((await f.read()).facts).toHaveLength(3)
  })

  it('counts only the actual addition when a replacement repeats existing facts', async () => {
    const f = await fixture()
    f.change({ additions: [narrow], replacements: [{ target: broad, replacement: [broad, other] }] })
    await expect(f.app.observeContext({ currentText: 'Keep those facts and add this separate claim.' }))
      .resolves.toEqual({ status: 'applied', appliedCount: 1 })
    expect((await f.read()).facts).toEqual([interest, broad, other, narrow])
  })

  it('splits confirmed and uncertain scopes, counting one target while retaining both', async () => {
    const f = await fixture()
    f.change({ additions: [], replacements: [{ target: broad, replacement: [narrow, doubt] }] })
    await expect(f.app.observeContext({ currentText: 'Simple edits work; complex ones are uncertain.' }))
      .resolves.toEqual({ status: 'applied', appliedCount: 1 })
    expect((await f.read()).facts).toEqual([interest, narrow, doubt, other])
    await f.app.request({ currentText: 'Feed' })
    expect(f.judgeCandidate).toHaveBeenCalledWith(expect.objectContaining({ personalContext: [interest, narrow, other] }))
    expect(f.observeContext).toHaveBeenLastCalledWith(expect.objectContaining({ activeFacts: [interest, narrow, doubt, other] }))
  })

  it('uses an explicit correction for the candidate in that same request', async () => {
    const f = await fixture()
    f.change({ additions: [], replacements: [{ target: broad, replacement: [narrow] }] })
    await expect(f.app.request({ currentText: 'Only simple edits work; give me a Feed.' }))
      .resolves.toEqual({ status: 'one_link', url: 'https://x.com/fixture/status/1' })
    expect(f.judgeCandidate).toHaveBeenCalledWith(expect.objectContaining({ personalContext: [interest, narrow, other] }))
    expect((await f.read()).facts).toEqual([interest, narrow, other])
  })

  it('keeps newly doubted knowledge stored but does not use it to permit selection', async () => {
    const f = await fixture([interest, broad])
    const uncertain = { ...broad, epistemic: 'uncertain' } as const
    f.change({ additions: [], replacements: [{ target: broad, replacement: [uncertain] }] })
    await expect(f.app.request({ currentText: 'I doubt that claim; give me a Feed.' }))
      .resolves.toEqual({ status: 'incomplete', stage: 'personal_context', question: expect.any(String), continuationToken: expect.any(String) })
    expect((await f.read()).facts).toEqual([interest, uncertain])
    expect(f.observe).not.toHaveBeenCalled()
    expect(f.judgeCandidate).not.toHaveBeenCalled()
  })

  it('passes an explicit novice knowledge boundary through to selection', async () => {
    const f = await fixture([interest])
    const novice = { ...broad, statement: 'I am new to video editing and know none of its basics' }
    f.change({ additions: [novice], replacements: [] })
    await expect(f.app.request({ currentText: 'I am new to this; give me a Feed.' })).resolves.toMatchObject({ status: 'one_link' })
    expect(f.judgeCandidate).toHaveBeenCalledWith(expect.objectContaining({ personalContext: [interest, novice] }))
  })

  it.each([
    ['unknown target', { additions: [narrow], replacements: [{ target: doubt, replacement: [] }] }],
    ['wrong target certainty', { additions: [], replacements: [{ target: { ...broad, epistemic: 'uncertain' }, replacement: [] }] }],
    ['duplicate target', { additions: [], replacements: [{ target: broad, replacement: [narrow] }, { target: broad, replacement: [] }] }],
    ['implicit override', { additions: [{ ...interest, stance: 'exclude' }], replacements: [] }],
    ['unrelated fact collision', { additions: [], replacements: [{ target: broad, replacement: [{ ...other, epistemic: 'uncertain' }] }] }],
    ['conflicting batch outputs', { additions: [{ ...narrow, epistemic: 'uncertain' }], replacements: [{ target: broad, replacement: [narrow] }] }],
    ['malformed replacement', { additions: [narrow], replacements: [{ target: broad, replacement: null }] }],
  ])('rejects %s without committing any of the batch', async (_name, changes) => {
    const f = await fixture()
    const before = await readFile(f.path, 'utf8')
    f.observeContext.mockResolvedValueOnce({ status: 'applied', changes } as never)
    await expect(f.app.observeContext({ currentText: 'controlled update' }))
      .resolves.toEqual({ status: 'incomplete', stage: 'context_observation' })
    expect(await readFile(f.path, 'utf8')).toBe(before)
  })

  it('rejects a stale replacement after another update commits', async () => {
    const f = await fixture()
    let release!: () => void
    let entered!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const reading = new Promise<void>(resolve => { entered = resolve })
    f.observeContext.mockImplementationOnce(async () => {
      entered()
      await held
      return { status: 'applied', changes: { additions: [], replacements: [{ target: broad, replacement: [] }] } }
    })
    const stale = f.app.observeContext({ currentText: 'Withdraw the old claim.' })
    await reading
    f.change({ additions: [], replacements: [{ target: broad, replacement: [narrow] }] })
    await expect(f.app.observeContext({ currentText: 'Only simple edits work.' })).resolves.toMatchObject({ status: 'applied' })
    release()
    await expect(stale).resolves.toEqual({ status: 'incomplete', stage: 'conflict' })
    expect((await f.read()).facts).toEqual([interest, narrow, other])
  })

  it('does not report success or alter the snapshot if committing the update fails', async () => {
    const f = await fixture()
    const before = await readFile(f.path, 'utf8')
    f.change({ additions: [], replacements: [{ target: broad, replacement: [] }] })
    vi.spyOn(persistence, 'atomicWriteJson').mockRejectedValueOnce(new PersonalFeedStorageError('controlled write failure'))
    await expect(f.app.observeContext({ currentText: 'Withdraw the claim.' })).rejects.toBeInstanceOf(PersonalFeedStorageError)
    expect(await readFile(f.path, 'utf8')).toBe(before)
  })

  it('persists replacements, withdrawals and doubts for a fresh application process', async () => {
    const f = await fixture()
    f.change({ additions: [], replacements: [
      { target: broad, replacement: [narrow, doubt] },
      { target: other, replacement: [] },
    ] })
    await expect(f.app.observeContext({ currentText: 'Narrow my claim and withdraw my mixing knowledge.' }))
      .resolves.toEqual({ status: 'applied', appliedCount: 2 })
    await f.app.close()
    const script = `
      import { createPersonalFeedApplication } from ${JSON.stringify(new URL('../src/application.ts', import.meta.url).href)};
      let captured;
      const app = createPersonalFeedApplication({ stateDir: process.argv[1], shutdownTimeoutMs: 5,
        model: { observeContext: async ({ activeFacts }) => { captured = activeFacts; return { status: 'ignored' }; },
          judgeCandidate: async () => { throw new Error('unexpected judgment'); }, interpretFeedback: async () => ({ status: 'pass' }) },
        observer: { observe: async () => { throw new Error('unexpected observation'); }, close: async () => {} } });
      try { await app.observeContext({ currentText: 'synthetic read' }); process.stdout.write(JSON.stringify(captured)); }
      finally { await app.close(); }
    `
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, f.stateDir], { timeout: 5_000 })
    expect(JSON.parse(stdout)).toEqual([interest, narrow, doubt])
    expect((await f.read()).schemaVersion).toBe(1)
  })

  it('does not treat a recommendation, save or unspecified dislike as learned knowledge', async () => {
    const f = await fixture()
    await f.app.request({ currentText: 'Feed' })
    await f.app.recordFeedback({ operation: 'save', url: 'https://x.com/fixture/status/1' })
    await f.app.processFeedback({ currentText: 'I dislike it.' })
    expect((await f.read()).facts).toEqual([interest, broad, other])
  })
})
