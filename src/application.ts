import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { AsyncQueue } from './async-queue.ts'
import { PersonalFeedClosedError, PersonalFeedInputError, PersonalFeedStorageError } from './errors.ts'
import { appendJsonLine, atomicWriteJson, readJson, readJsonLines } from './persistence.ts'

export interface CallOptions {
  readonly signal?: AbortSignal
}

export type PersonalContextFact =
  | { readonly lane: 'long_term_interest'; readonly statement: string; readonly stance: 'include' | 'exclude' }
  | { readonly lane: 'existing_knowledge'; readonly statement: string; readonly epistemic: 'asserted' | 'uncertain' }

export interface ContextChanges {
  readonly additions: readonly PersonalContextFact[]
  readonly replacements: readonly {
    readonly target: PersonalContextFact
    readonly replacement: readonly PersonalContextFact[]
  }[]
}

export interface XCandidate {
  readonly stableId: string
  readonly canonicalUrl: string
  readonly body: string
  readonly authorHandle: string
  readonly publishedAt: string
  readonly surface?: 'for_you' | 'following' | 'explore'
}

export type XObservation =
  | { readonly status: 'complete'; readonly candidates: readonly XCandidate[] }
  | {
      readonly status: 'incomplete'
      readonly stage: 'source_window'
      readonly reason: 'material_insufficient' | 'partial_observation' | 'observation_failed'
    }

export interface XObserver {
  readonly observe: (input: {
    readonly requestId: string
    readonly cutoff: string
    readonly shanghaiDay: string
    readonly signal: AbortSignal
  }) => Promise<XObservation>
  readonly close: () => Promise<void>
}

export interface RemainingClarification {
  readonly question: string
  readonly unresolvedScope: string
}

export interface ClarificationInput extends RemainingClarification {
  readonly originalText: string
  readonly referenceText?: string
}

type ClarificationOutput = {
  readonly remaining?: RemainingClarification | null
  readonly resolvedReferenceText?: string
}

export interface PersonalFeedModel {
  readonly observeContext: (input: {
    readonly currentText: string
    readonly activeFacts: readonly PersonalContextFact[]
    readonly assessForFeed?: true
    readonly clarification?: ClarificationInput
    readonly signal: AbortSignal
  }) => Promise<ClarificationOutput & (
    | { readonly status: 'applied'; readonly changes: ContextChanges; readonly sufficient?: boolean }
    | { readonly status: 'ignored'; readonly sufficient?: boolean }
    | { readonly status: 'incomplete' }
  )>
  readonly judgeCandidate: (input: {
    readonly currentText: string
    readonly personalContext: readonly PersonalContextFact[]
    readonly candidate: XCandidate
    readonly cutoff: string
    readonly shanghaiDay: string
    readonly signal: AbortSignal
  }) => Promise<
    | { readonly status: 'qualified' }
    | { readonly status: 'not_qualified' }
    | { readonly status: 'incomplete' }
  >
  readonly interpretFeedback: (input: {
    readonly currentText: string
    readonly activeFacts: readonly PersonalContextFact[]
    readonly referenceText?: string
    readonly clarification?: ClarificationInput
    readonly signal: AbortSignal
  }) => Promise<ClarificationOutput & { readonly changes?: ContextChanges } & (
    | { readonly status: 'pass' }
    | { readonly status: 'discarded' }
    | { readonly status: 'needs_input'; readonly remaining: RemainingClarification }
    | { readonly status: 'completed'; readonly sentiment: 'like' | 'dislike'; readonly targetText: string; readonly reason?: string }
    | { readonly status: 'incomplete' }
  )>
}

/** A Feed outcome without clarification fields, also used inside update results. */
export type FeedResult =
  | { readonly status: 'one_link'; readonly url: string }
  | { readonly status: 'business_empty' }
  | { readonly status: 'incomplete'; readonly stage: 'context_observation' | 'personal_context' | 'source_window' | 'judgement_execution' | 'conflict' | 'shutdown' }

type QuestionHandoff =
  | { readonly question: string; readonly continuationToken: string }
  | { readonly question?: never; readonly continuationToken?: never }

export type RequestResult = FeedResult & QuestionHandoff

export type ObserveContextResult = (
  | { readonly status: 'applied'; readonly appliedCount: number }
  | { readonly status: 'ignored' }
  | { readonly status: 'already_observed' }
  | { readonly status: 'incomplete'; readonly stage: 'context_observation' | 'conflict' }
) & QuestionHandoff & { readonly feed?: FeedResult }

type ContextPreparation = {
  readonly result: ObserveContextResult
  readonly effectiveFacts: readonly PersonalContextFact[]
  readonly sufficient?: boolean
}

export type ProcessFeedbackResult = (
  | { readonly status: 'pass' | 'completed' | 'discarded' }
  | { readonly status: 'needs_input'; readonly question: string; readonly continuationToken: string }
  | { readonly status: 'incomplete'; readonly stage: 'feedback_interpretation' | 'feedback_commit' | 'conflict' }
) & QuestionHandoff & { readonly feed?: FeedResult }

export type RecordFeedbackResult =
  | { readonly status: 'saved' | 'unsaved' | 'already_saved' | 'already_unsaved' }

export interface SavedItem {
  readonly url: string
  readonly title?: string
  readonly note?: string
  readonly savedAt: string
}

export interface PersonalFeedApplication {
  readonly request: (input: { readonly currentText: string }, options?: CallOptions) => Promise<RequestResult>
  readonly observeContext: (input: {
    readonly currentText: string
    readonly continuationToken?: string
  }, options?: CallOptions) => Promise<ObserveContextResult>
  readonly processFeedback: (input: {
    readonly currentText: string
    readonly referenceText?: string
    readonly continuationToken?: string
  }, options?: CallOptions) => Promise<ProcessFeedbackResult>
  readonly recordFeedback: (input: {
    readonly operation: 'save' | 'unsave'
    readonly url: string
    readonly title?: string
    readonly note?: string
  }, options?: CallOptions) => Promise<RecordFeedbackResult>
  readonly listSaved: (input: { readonly limit?: number }, options?: CallOptions) => Promise<{
    readonly status: 'completed'
    readonly items: readonly SavedItem[]
  }>
  readonly close: () => Promise<void>
}

export interface CreatePersonalFeedApplicationOptions {
  readonly stateDir: string
  readonly model: PersonalFeedModel
  readonly observer: XObserver
  readonly now?: () => Date
  readonly shutdownTimeoutMs?: number
}

type ContextState = {
  readonly schemaVersion: 1
  readonly generation: number
  readonly facts: readonly PersonalContextFact[]
}

type CandidateRecord = {
  readonly schemaVersion: 1
  readonly event: 'candidate_processed'
  readonly stableId: string
  readonly canonicalUrl: string
  readonly judgment: 'qualified' | 'not_qualified'
  readonly processedAt: string
}

type SavedEvent = {
  readonly schemaVersion: 1
  readonly id: string
  readonly operation: 'save' | 'unsave'
  readonly url: string
  readonly title?: string
  readonly note?: string
  readonly createdAt: string
}

type PendingEntry = {
  readonly tool: 'context' | 'feedback'
  readonly clarification: ClarificationInput
}

type FeedbackEvent = {
  readonly schemaVersion: 1
  readonly id: string
  readonly sentiment: 'like' | 'dislike'
  readonly targetText: string
  readonly createdAt: string
}

const EMPTY_CONTEXT: ContextState = Object.freeze({ schemaVersion: 1, generation: 0, facts: [] })

export function createPersonalFeedApplication(options: CreatePersonalFeedApplicationOptions): PersonalFeedApplication {
  validateOptions(options)
  const now = options.now ?? (() => new Date())
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? 10_000
  const requestQueue = new AsyncQueue()
  const contextQueue = new AsyncQueue()
  const pending = new Map<string, PendingEntry>()
  const savedQueue = new AsyncQueue()
  const shutdown = new AbortController()
  const contextPath = join(options.stateDir, 'personal-context.json')
  const candidatesPath = join(options.stateDir, 'candidates.jsonl')
  const feedbackPath = join(options.stateDir, 'feedback.jsonl')
  const savedPath = join(options.stateDir, 'saved.jsonl')
  let closed = false

  const signalFor = (call?: CallOptions): AbortSignal => {
    if (closed) throw new PersonalFeedClosedError()
    if (call?.signal !== undefined && !(call.signal instanceof AbortSignal)) {
      throw new PersonalFeedInputError('signal must be an AbortSignal')
    }
    return call?.signal === undefined ? shutdown.signal : AbortSignal.any([shutdown.signal, call.signal])
  }

  // All commits share the existing context queue. Interpretations run outside it;
  // both facts and the particular question must still match at commit time.
  const questionPair = (token?: string, entry?: PendingEntry): QuestionHandoff =>
    token !== undefined && entry !== undefined && pending.get(token) === entry
      ? { question: entry.clarification.question, continuationToken: token } : {}

  const finishQuestion = (tool: PendingEntry['tool'], currentText: string, remaining: RemainingClarification | null | undefined,
    token?: string, prior?: PendingEntry, referenceText?: string, resolvedReferenceText?: string): QuestionHandoff => {
    if (token !== undefined) pending.delete(token)
    if (remaining == null) return {}
    const continuationToken = randomBytes(32).toString('base64url')
    const original = prior?.clarification
    const originalReference = (prior === undefined ? referenceText : original?.referenceText) ?? resolvedReferenceText
    pending.set(continuationToken, Object.freeze({ tool, clarification: Object.freeze({
      originalText: original?.originalText ?? currentText,
      ...(originalReference === undefined ? {} : { referenceText: originalReference }),
      ...remaining,
    }) }))
    return { question: remaining.question, continuationToken }
  }

  const observeContextWithSignal = async (currentText: string, signal: AbortSignal, assessForFeed = false,
    token?: string): Promise<ContextPreparation> => {
    const prior = token === undefined ? undefined : pending.get(token)
    const incomplete = (stage: 'context_observation' | 'conflict' = 'context_observation'): ContextPreparation => Object.freeze({
      result: Object.freeze({ status: 'incomplete', stage, ...(prior?.tool === 'context' ? questionPair(token, prior) : {}) }), effectiveFacts: [],
    })
    if (token !== undefined && prior?.tool !== 'context') return incomplete()
    const before = await contextQueue.run(async () => loadContext(contextPath))
    if (signal.aborted) return incomplete()
    let interpreted: Awaited<ReturnType<PersonalFeedModel['observeContext']>>
    try {
      interpreted = await options.model.observeContext({
        currentText, activeFacts: before.facts, signal, ...(assessForFeed ? { assessForFeed: true } : {}),
        ...(prior === undefined ? {} : { clarification: prior.clarification }),
      })
      if (signal.aborted || (interpreted.status !== 'applied' && interpreted.status !== 'ignored')
        || !validRemaining(interpreted.remaining, prior !== undefined)
        || interpreted.resolvedReferenceText !== undefined && !validModelText(interpreted.resolvedReferenceText)) return incomplete()
    } catch { return incomplete() }
    const sufficient = interpreted.sufficient
    if (assessForFeed && typeof sufficient !== 'boolean') return incomplete()
    const applied = interpreted.status === 'applied'
      ? applyContextChanges(before.facts, interpreted.changes)
      : { facts: before.facts, appliedCount: 0 }
    if (applied === undefined) return incomplete()
    return contextQueue.run(async () => {
      const latest = await loadContext(contextPath)
      if (latest.generation !== before.generation || token !== undefined && pending.get(token) !== prior) return incomplete('conflict')
      if (signal.aborted) return incomplete()
      const next: ContextState = { schemaVersion: 1, generation: latest.generation + 1, facts: applied.facts }
      await atomicWriteJson(contextPath, next)
      const pair = finishQuestion('context', currentText, interpreted.remaining, token, prior, undefined, interpreted.resolvedReferenceText)
      return Object.freeze({
        result: interpreted.status === 'ignored'
          ? Object.freeze({ status: 'ignored' as const, ...pair })
          : Object.freeze({ status: 'applied' as const, appliedCount: applied.appliedCount, ...pair }),
        effectiveFacts: Object.freeze(next.facts.filter(fact => fact.lane !== 'existing_knowledge' || fact.epistemic === 'asserted')),
        ...(assessForFeed && typeof sufficient === 'boolean' ? { sufficient } : {}),
      })
    })
  }

  const observeContext = async (input: {
    readonly currentText: string
    readonly continuationToken?: string
  }, call?: CallOptions): Promise<ObserveContextResult> => {
    validateExact(input, ['currentText', 'continuationToken'], ['currentText'])
    const currentText = validateText(input.currentText, 'currentText')
    const token = optionalToken(input.continuationToken)
    const signal = signalFor(call)
    return (await observeContextWithSignal(currentText, signal, false, token)).result
  }

  const request = async (input: { readonly currentText: string }, call?: CallOptions): Promise<RequestResult> => {
    validateExact(input, ['currentText'])
    const currentText = validateText(input.currentText, 'currentText')
    const signal = signalFor(call)
    return requestQueue.run(async () => {
      if (signal.aborted) return Object.freeze({ status: 'incomplete', stage: 'shutdown' })
      const prepared = await observeContextWithSignal(currentText, signal, true)
      const observed = prepared.result
      const pair = observed.continuationToken === undefined ? {} : { question: observed.question, continuationToken: observed.continuationToken }
      if (observed.status === 'incomplete') {
        return Object.freeze({ ...pair, status: 'incomplete', stage: observed.stage === 'conflict' ? 'conflict' : 'context_observation' })
      }
      const personalContext = prepared.effectiveFacts
      if (!prepared.sufficient || !contextIsSufficient(personalContext)) {
        return Object.freeze({ ...pair, status: 'incomplete', stage: 'personal_context' })
      }
      const cutoff = validNow(now).toISOString()
      const requestId = `pf:${randomBytes(16).toString('hex')}`
      let observedWindow: XObservation
      try {
        observedWindow = await options.observer.observe({
          requestId,
          cutoff,
          shanghaiDay: shanghaiDay(cutoff),
          signal,
        })
      } catch {
        return Object.freeze({ ...pair, status: 'incomplete', stage: 'source_window' })
      }
      if (signal.aborted || observedWindow.status === 'incomplete') {
        return Object.freeze({ ...pair, status: 'incomplete', stage: 'source_window' })
      }
      const candidates = uniqueCandidates(observedWindow.candidates)
      if (candidates === undefined) return Object.freeze({ ...pair, status: 'incomplete', stage: 'source_window' })
      const startRecords = await loadCandidateRecords(candidatesPath)
      const processed = new Set(startRecords.map(record => record.stableId))
      for (const candidate of candidates) {
        if (processed.has(candidate.stableId)) continue
        let judgment: Awaited<ReturnType<PersonalFeedModel['judgeCandidate']>>
        try {
          judgment = await options.model.judgeCandidate({
            currentText,
            personalContext,
            candidate,
            cutoff,
            shanghaiDay: shanghaiDay(cutoff),
            signal,
          })
        } catch {
          return Object.freeze({ ...pair, status: 'incomplete', stage: 'judgement_execution' })
        }
        if (signal.aborted || judgment.status === 'incomplete') {
          return Object.freeze({ ...pair, status: 'incomplete', stage: 'judgement_execution' })
        }
        const record: CandidateRecord = {
          schemaVersion: 1,
          event: 'candidate_processed',
          stableId: candidate.stableId,
          canonicalUrl: candidate.canonicalUrl,
          judgment: judgment.status,
          processedAt: validNow(now).toISOString(),
        }
        await appendJsonLine(candidatesPath, record)
        if (judgment.status === 'qualified') return Object.freeze({ ...pair, status: 'one_link', url: candidate.canonicalUrl })
      }
      return Object.freeze({ ...pair, status: 'business_empty' })
    })
  }

  const processFeedback = async (input: {
    readonly currentText: string
    readonly referenceText?: string
    readonly continuationToken?: string
  }, call?: CallOptions): Promise<ProcessFeedbackResult> => {
    validateExact(input, ['currentText', 'referenceText', 'continuationToken'], ['currentText'])
    const currentText = validateText(input.currentText, 'currentText')
    const referenceText = optionalText(input.referenceText, 'referenceText')
    const token = optionalToken(input.continuationToken)
    const signal = signalFor(call)
    const prior = token === undefined ? undefined : pending.get(token)
    const incomplete = (stage: 'feedback_interpretation' | 'conflict' = 'feedback_interpretation'): ProcessFeedbackResult =>
      Object.freeze({ status: 'incomplete', stage, ...(prior?.tool === 'feedback' ? questionPair(token, prior) : {}) })
    if (token !== undefined && prior?.tool !== 'feedback') return incomplete()
    const before = await contextQueue.run(async () => loadContext(contextPath))
    if (signal.aborted) return incomplete()
    let interpreted: Awaited<ReturnType<PersonalFeedModel['interpretFeedback']>>
    try {
      const resolvedReference = prior === undefined ? referenceText : prior.clarification.referenceText
      interpreted = await options.model.interpretFeedback({
        currentText, activeFacts: before.facts,
        ...(resolvedReference === undefined ? {} : { referenceText: resolvedReference }),
        ...(prior === undefined ? {} : { clarification: prior.clarification }), signal,
      })
      if (signal.aborted || !['pass', 'discarded', 'needs_input', 'completed'].includes(interpreted.status)
        || !validRemaining(interpreted.remaining, prior !== undefined)
        || interpreted.resolvedReferenceText !== undefined && !validModelText(interpreted.resolvedReferenceText)
        || interpreted.status === 'needs_input' && interpreted.remaining == null
        || interpreted.status === 'completed' && (
          !validModelText(interpreted.targetText) || !['like', 'dislike'].includes(interpreted.sentiment)
          || interpreted.sentiment === 'dislike' && !validModelText(interpreted.reason))) return incomplete()
    } catch { return incomplete() }
    const applied = interpreted.changes === undefined ? { facts: before.facts, appliedCount: 0 }
      : applyContextChanges(before.facts, interpreted.changes)
    if (applied === undefined) return incomplete()
    return contextQueue.run(async () => {
      const latest = await loadContext(contextPath)
      if (latest.generation !== before.generation || token !== undefined && pending.get(token) !== prior) return incomplete('conflict')
      if (signal.aborted) return incomplete()
      // Save facts before the feedback ledger. A storage fault leaves the question
      // usable; the next interpretation re-reads these facts instead of replaying changes.
      if (interpreted.changes !== undefined) await atomicWriteJson(contextPath, {
        schemaVersion: 1, generation: latest.generation + 1, facts: applied.facts,
      })
      if (interpreted.status === 'completed') {
        const eventId = token === undefined ? randomUUID() : feedbackEventId(token)
        const previous = (await loadFeedbackEvents(feedbackPath)).find(event => event.id === eventId)
        if (previous !== undefined && (previous.sentiment !== interpreted.sentiment || previous.targetText !== interpreted.targetText)) {
          throw new PersonalFeedStorageError('feedback event conflicts with the pending answer')
        }
        if (previous === undefined) await appendJsonLine(feedbackPath, {
          schemaVersion: 1, id: eventId, sentiment: interpreted.sentiment,
          targetText: interpreted.targetText, createdAt: validNow(now).toISOString(),
        } satisfies FeedbackEvent)
      }
      const pair = finishQuestion('feedback', currentText, interpreted.remaining, token, prior, referenceText, interpreted.resolvedReferenceText)
      if (interpreted.status === 'needs_input') {
        return Object.freeze({ status: 'needs_input', ...pair }) as ProcessFeedbackResult
      }
      return Object.freeze({ status: interpreted.status as 'pass' | 'completed' | 'discarded', ...pair })
    })
  }

  const recordFeedback = async (input: {
    readonly operation: 'save' | 'unsave'
    readonly url: string
    readonly title?: string
    readonly note?: string
  }, call?: CallOptions): Promise<RecordFeedbackResult> => {
    validateExact(input, ['operation', 'url', 'title', 'note'], ['operation', 'url'])
    if (input.operation !== 'save' && input.operation !== 'unsave') throw new PersonalFeedInputError('operation must be save or unsave')
    const url = canonicalizeUrl(input.url)
    const title = optionalText(input.title, 'title', 1_000)
    const note = optionalText(input.note, 'note', 2_000)
    const signal = signalFor(call)
    if (signal.aborted) throw new PersonalFeedClosedError('operation was cancelled')
    return savedQueue.run(async () => {
      const events = await loadSavedEvents(savedPath)
      const current = foldSaved(events).get(url)
      if (input.operation === 'save' && current?.saved === true) return Object.freeze({ status: 'already_saved' })
      if (input.operation === 'unsave' && current?.saved !== true) return Object.freeze({ status: 'already_unsaved' })
      const event: SavedEvent = {
        schemaVersion: 1,
        id: randomUUID(),
        operation: input.operation,
        url,
        ...(title === undefined ? {} : { title }),
        ...(note === undefined ? {} : { note }),
        createdAt: validNow(now).toISOString(),
      }
      await appendJsonLine(savedPath, event)
      return Object.freeze({ status: input.operation === 'save' ? 'saved' : 'unsaved' })
    })
  }

  const listSaved = async (input: { readonly limit?: number }, call?: CallOptions): Promise<{
    readonly status: 'completed'
    readonly items: readonly SavedItem[]
  }> => {
    validateExact(input, ['limit'], [])
    const limit = input.limit ?? 20
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new PersonalFeedInputError('limit must be an integer between 1 and 1000')
    const signal = signalFor(call)
    if (signal.aborted) throw new PersonalFeedClosedError('operation was cancelled')
    return savedQueue.run(async () => {
      const folded = [...foldSaved(await loadSavedEvents(savedPath)).values()]
        .filter(item => item.saved)
        .sort((left, right) => right.savedAt.localeCompare(left.savedAt))
        .slice(0, limit)
        .map(({ saved: _saved, ...item }) => item)
      return Object.freeze({ status: 'completed', items: folded })
    })
  }

  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    shutdown.abort(new Error('personal-feed shutdown'))
    pending.clear()
    await Promise.allSettled([options.observer.close()])
    const idle = Promise.all([
      requestQueue.idle(), contextQueue.idle(), savedQueue.idle(),
    ]).then(() => undefined)
    await Promise.race([idle, new Promise<void>(resolve => setTimeout(resolve, shutdownTimeoutMs))])
  }

  return Object.freeze({ request, observeContext, processFeedback, recordFeedback, listSaved, close })
}

function validateOptions(options: CreatePersonalFeedApplicationOptions): void {
  if (options === null || typeof options !== 'object' || typeof options.stateDir !== 'string' || options.stateDir.trim() === ''
    || options.model === null || typeof options.model !== 'object'
    || typeof options.model.observeContext !== 'function' || typeof options.model.judgeCandidate !== 'function'
    || typeof options.model.interpretFeedback !== 'function'
    || options.observer === null || typeof options.observer !== 'object'
    || typeof options.observer.observe !== 'function' || typeof options.observer.close !== 'function') {
    throw new PersonalFeedInputError('application options are invalid')
  }
}

function validateExact(value: unknown, allowed: readonly string[], required = allowed): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new PersonalFeedInputError('input must be an object')
  const keys = Object.keys(value)
  if (keys.some(key => !allowed.includes(key)) || required.some(key => !keys.includes(key))) {
    throw new PersonalFeedInputError('input contains missing or unknown fields')
  }
}

function validateText(value: unknown, field: string, maximum = 16_000): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > maximum) {
    throw new PersonalFeedInputError(`${field} must be a non-empty string no longer than ${maximum} characters`)
  }
  return value
}

function optionalText(value: unknown, field: string, maximum = 16_000): string | undefined {
  return value === undefined ? undefined : validateText(value, field, maximum)
}

function optionalToken(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(value)) throw new PersonalFeedInputError('continuationToken is invalid')
  return value
}

function validNow(now: () => Date): Date {
  const value = now()
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new PersonalFeedStorageError('clock returned an invalid instant')
  return value
}

function shanghaiDay(stamp: string): string {
  return new Date(Date.parse(stamp) + 8 * 60 * 60 * 1_000).toISOString().slice(0, 10)
}

async function loadContext(path: string): Promise<ContextState> {
  const value = await readJson<unknown>(path, EMPTY_CONTEXT)
  if (!isRecord(value) || value.schemaVersion !== 1 || !Number.isSafeInteger(value.generation)
    || !Array.isArray(value.facts) || !validFacts(value.facts)) throw new PersonalFeedStorageError('personal context state is invalid')
  return value as unknown as ContextState
}

function validFacts(value: readonly unknown[]): value is readonly PersonalContextFact[] {
  return value.every(fact => isRecord(fact) && typeof fact.statement === 'string' && fact.statement.trim() !== ''
    && (fact.lane === 'long_term_interest'
      ? (fact.stance === 'include' || fact.stance === 'exclude') && exactKeys(fact, ['lane', 'statement', 'stance'])
      : fact.lane === 'existing_knowledge'
        && (fact.epistemic === 'asserted' || fact.epistemic === 'uncertain')
        && exactKeys(fact, ['lane', 'statement', 'epistemic'])))
}

function applyContextChanges(existing: readonly PersonalContextFact[], changes: unknown): {
  readonly facts: readonly PersonalContextFact[]
  readonly appliedCount: number
} | undefined {
  if (!validContextChanges(changes)) return undefined
  const replacements = new Map<number, readonly PersonalContextFact[]>()
  for (const entry of changes.replacements) {
    const index = existing.findIndex(fact => sameFact(fact, entry.target))
    if (index === -1 || replacements.has(index)) return undefined
    const replacement = distinctFacts(entry.replacement)
    if (replacement === undefined) return undefined
    replacements.set(index, replacement)
  }
  const retained = distinctFacts(existing.flatMap((fact, index) => replacements.get(index) ?? [fact]))
  if (retained === undefined) return undefined
  const facts = new Map(retained.map(fact => [factKey(fact), fact]))
  for (const fact of changes.additions) {
    const previous = facts.get(factKey(fact))
    if (previous !== undefined) {
      if (!sameFact(previous, fact)) return undefined
      continue
    }
    facts.set(factKey(fact), fact)
  }
  const finalFacts = [...facts.values()]
  const newFacts = new Set(finalFacts.filter(fact => !existing.some(old => sameFact(old, fact))).map(factKey))
  let appliedCount = 0
  // Count removed or changed targets first, including any new facts in their replacement.
  for (const [index, replacement] of replacements) {
    if (finalFacts.some(fact => sameFact(fact, existing[index]!))) continue
    appliedCount += 1
    for (const fact of replacement) newFacts.delete(factKey(fact))
  }
  // A retained target only changed if its replacement contributes a new fact.
  for (const [index, replacement] of replacements) {
    if (!finalFacts.some(fact => sameFact(fact, existing[index]!))) continue
    if (!replacement.some(fact => newFacts.has(factKey(fact)))) continue
    appliedCount += 1
    for (const fact of replacement) newFacts.delete(factKey(fact))
  }
  appliedCount += newFacts.size
  return { facts: [...facts.values()].map(fact => Object.freeze({ ...fact })), appliedCount }
}

function validContextChanges(value: unknown): value is ContextChanges {
  return isRecord(value) && exactKeys(value, ['additions', 'replacements'])
    && Array.isArray(value.additions) && validFacts(value.additions)
    && Array.isArray(value.replacements) && value.replacements.every(entry =>
      isRecord(entry) && exactKeys(entry, ['target', 'replacement']) && validFacts([entry.target])
      && Array.isArray(entry.replacement) && validFacts(entry.replacement))
}

function distinctFacts(input: readonly PersonalContextFact[]): PersonalContextFact[] | undefined {
  const facts = new Map<string, PersonalContextFact>()
  for (const fact of input) {
    const previous = facts.get(factKey(fact))
    if (previous !== undefined && !sameFact(previous, fact)) return undefined
    facts.set(factKey(fact), fact)
  }
  return [...facts.values()]
}

function factKey(fact: PersonalContextFact): string {
  return `${fact.lane}:${fact.statement.toLocaleLowerCase()}`
}

function sameFact(left: PersonalContextFact, right: PersonalContextFact): boolean {
  return left.statement === right.statement && (left.lane === 'long_term_interest'
    ? right.lane === left.lane && left.stance === right.stance
    : right.lane === left.lane && left.epistemic === right.epistemic)
}

function contextIsSufficient(facts: readonly PersonalContextFact[]): boolean {
  return facts.some(fact => fact.lane === 'long_term_interest' && fact.stance === 'include')
    && facts.some(fact => fact.lane === 'existing_knowledge')
}

async function loadCandidateRecords(path: string): Promise<CandidateRecord[]> {
  const records = await readJsonLines<unknown>(path)
  if (records.some(record => !isRecord(record) || record.schemaVersion !== 1 || record.event !== 'candidate_processed'
    || typeof record.stableId !== 'string' || typeof record.canonicalUrl !== 'string'
    || (record.judgment !== 'qualified' && record.judgment !== 'not_qualified') || typeof record.processedAt !== 'string')) {
    throw new PersonalFeedStorageError('candidate ledger is invalid')
  }
  return records as CandidateRecord[]
}

function uniqueCandidates(input: readonly XCandidate[]): XCandidate[] | undefined {
  if (!Array.isArray(input)) return undefined
  const unique = new Map<string, XCandidate>()
  for (const candidate of input) {
    if (!validCandidate(candidate)) return undefined
    if (!unique.has(candidate.stableId)) unique.set(candidate.stableId, Object.freeze({ ...candidate }))
  }
  return [...unique.values()]
}

function validCandidate(value: unknown): value is XCandidate {
  if (!isRecord(value) || typeof value.stableId !== 'string' || !/^x-status:[1-9]\d*$/u.test(value.stableId)
    || typeof value.canonicalUrl !== 'string' || typeof value.body !== 'string' || value.body.trim() === ''
    || typeof value.authorHandle !== 'string' || typeof value.publishedAt !== 'string') return false
  try {
    const canonical = canonicalizeUrl(value.canonicalUrl)
    return canonical === value.canonicalUrl && value.stableId === `x-status:${canonical.split('/')[5] ?? ''}`
  } catch {
    return false
  }
}

async function loadSavedEvents(path: string): Promise<SavedEvent[]> {
  const events = await readJsonLines<unknown>(path)
  if (events.some(event => !isRecord(event) || event.schemaVersion !== 1 || typeof event.id !== 'string'
    || (event.operation !== 'save' && event.operation !== 'unsave') || typeof event.url !== 'string'
    || typeof event.createdAt !== 'string')) throw new PersonalFeedStorageError('saved ledger is invalid')
  return events as SavedEvent[]
}

async function loadFeedbackEvents(path: string): Promise<FeedbackEvent[]> {
  const events = await readJsonLines<unknown>(path)
  if (events.some(event => !isRecord(event) || event.schemaVersion !== 1 || typeof event.id !== 'string'
    || (event.sentiment !== 'like' && event.sentiment !== 'dislike')
    || typeof event.targetText !== 'string' || typeof event.createdAt !== 'string')) {
    throw new PersonalFeedStorageError('feedback ledger is invalid')
  }
  return events as FeedbackEvent[]
}

function feedbackEventId(token: string): string {
  return `continuation:${createHash('sha256').update(token).digest('hex')}`
}

function foldSaved(events: readonly SavedEvent[]): Map<string, SavedItem & { readonly saved: boolean }> {
  const folded = new Map<string, SavedItem & { saved: boolean }>()
  for (const event of events) {
    const previous = folded.get(event.url)
    folded.set(event.url, event.operation === 'save'
      ? {
          url: event.url,
          saved: true,
          savedAt: event.createdAt,
          ...(event.title === undefined ? {} : { title: event.title }),
          ...(event.note === undefined ? {} : { note: event.note }),
        }
      : { url: event.url, saved: false, savedAt: previous?.savedAt ?? event.createdAt })
  }
  return folded
}

export function canonicalizeUrl(raw: string): string {
  const value = validateText(raw, 'url', 2_048).trim()
  let parsed: URL
  try { parsed = new URL(value) } catch { throw new PersonalFeedInputError('url must be an absolute HTTP URL') }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '') {
    throw new PersonalFeedInputError('url must be an absolute HTTP URL without credentials')
  }
  const host = ['twitter.com', 'www.twitter.com', 'mobile.twitter.com', 'www.x.com'].includes(parsed.hostname.toLowerCase())
    ? 'x.com'
    : parsed.hostname.toLowerCase()
  const pieces = parsed.pathname.replace(/\/+$/u, '').split('/')
  if (host === 'x.com' && pieces.length >= 4) pieces[1] = pieces[1]?.toLowerCase() ?? ''
  return `https://${host}${parsed.port === '' ? '' : `:${parsed.port}`}${pieces.join('/')}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && actual.every(key => keys.includes(key))
}

function validModelText(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '' && value.length <= 16_000
}

function validRemaining(value: unknown, required: boolean): boolean {
  return value === null || value === undefined && !required || isRecord(value)
    && exactKeys(value, ['question', 'unresolvedScope']) && validModelText(value.question) && validModelText(value.unresolvedScope)
}
