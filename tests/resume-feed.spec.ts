import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPersonalFeedApplication, type PersonalFeedModel, type XObserver } from '../src/application.ts'

const candidate = {
  stableId: 'x-status:101', canonicalUrl: 'https://x.com/fixture/status/101', body: 'A practical home-care explanation',
  authorHandle: 'fixture', publishedAt: '2026-09-06T00:00:00.000Z',
}
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

async function fixture(facts: readonly unknown[] = [], observerOverride?: XObserver) {
  const stateDir = await mkdtemp(join(tmpdir(), 'pf-v0-discovery-'))
  cleanup.push(() => rm(stateDir, { recursive: true, force: true }))
  await writeFile(join(stateDir, 'personal-context.json'), JSON.stringify({ schemaVersion: 1, generation: 1, facts }))
  const model: PersonalFeedModel = {
    assessContext: vi.fn(async () => ({ status: 'completed', sufficient: false })),
    observeContext: vi.fn(async () => ({ status: 'ignored' })),
    judgeCandidate: vi.fn(async () => ({ status: 'qualified' })),
    interpretFeedback: vi.fn(async () => ({ status: 'pass' })),
  }
  const observer = observerOverride ?? {
    observe: vi.fn(async () => ({ status: 'complete' as const, candidates: [candidate] })),
    close: vi.fn(async () => {}),
  }
  const app = createPersonalFeedApplication({
    stateDir, model, observer, now: () => new Date('2026-09-07T01:00:00.000Z'), shutdownTimeoutMs: 5,
  })
  cleanup.push(() => app.close())
  return { app, stateDir, model, observer }
}

describe('V0 direct discovery without a profile continuation', () => {
  it('uses the original request once with empty context and never elicits', async () => {
    const f = await fixture()
    const ask = vi.fn(async () => ({ action: 'cancel' as const }))
    const requestText = 'Give me a beginner family-care Feed.'

    await expect(f.app.request({ currentText: requestText }, { mode: 'interactive', ask }))
      .resolves.toEqual({ status: 'one_link', url: candidate.canonicalUrl })
    expect(ask).not.toHaveBeenCalled()
    expect(f.model.assessContext).not.toHaveBeenCalled()
    expect(f.model.observeContext).not.toHaveBeenCalled()
    expect(f.model.judgeCandidate).toHaveBeenCalledWith(expect.objectContaining({
      requestText, personalContext: [], cutoff: '2026-09-07T01:00:00.000Z',
    }))
    expect(JSON.parse(await readFile(join(f.stateDir, 'personal-context.json'), 'utf8')).facts).toEqual([])
  })

  it('uses asserted saved facts while keeping uncertain facts out of judgment', async () => {
    const interest = { lane: 'long_term_interest', statement: 'family care', stance: 'include' } as const
    const asserted = { lane: 'existing_knowledge', statement: 'basic home care', epistemic: 'asserted' } as const
    const uncertain = { lane: 'existing_knowledge', statement: 'advanced care', epistemic: 'uncertain' } as const
    const f = await fixture([interest, asserted, uncertain])

    await f.app.request({ currentText: 'Find a useful item.' })
    expect(f.model.judgeCandidate).toHaveBeenCalledWith(expect.objectContaining({ personalContext: [interest, asserted] }))
  })

  it('keeps explicit context updates separate from discovery', async () => {
    const f = await fixture()
    const interest = { lane: 'long_term_interest', statement: 'family care', stance: 'include' } as const
    vi.mocked(f.model.observeContext).mockResolvedValueOnce({
      status: 'applied', changes: { additions: [interest], replacements: [] },
    })

    await expect(f.app.observeContext({ currentText: 'I follow family care.' }))
      .resolves.toEqual({ status: 'applied', appliedCount: 1 })
    expect(f.observer.observe).not.toHaveBeenCalled()
    await expect(f.app.request({ currentText: 'Now discover.' })).resolves.toMatchObject({ status: 'one_link' })
    expect(f.model.judgeCandidate).toHaveBeenCalledWith(expect.objectContaining({ personalContext: [interest] }))
  })

  it('ends source cancellation as shutdown and never returns the candidate', async () => {
    const observer: XObserver = {
      observe: vi.fn(async ({ signal }) => {
        await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
        return { status: 'complete', candidates: [candidate] }
      }),
      close: vi.fn(async () => {}),
    }
    const f = await fixture([], observer)
    const abort = new AbortController()
    const pending = f.app.request({ currentText: 'Discover.' }, { signal: abort.signal })
    await vi.waitFor(() => expect(observer.observe).toHaveBeenCalled())
    abort.abort()
    await expect(pending).resolves.toEqual({ status: 'incomplete', stage: 'shutdown', reason: 'interaction_cancelled' })
    expect(f.model.judgeCandidate).not.toHaveBeenCalled()
  })
})
