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

export interface PersonalFeedModel {
  readonly observeContext: (input: {
    readonly currentText: string
    readonly activeFacts: readonly PersonalContextFact[]
    readonly signal: AbortSignal
  }) => Promise<
    | { readonly status: 'applied'; readonly facts: readonly PersonalContextFact[] }
    | { readonly status: 'ignored' }
    | { readonly status: 'incomplete' }
  >
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
    readonly referenceText?: string
    readonly signal: AbortSignal
  }) => Promise<
    | { readonly status: 'pass' }
    | { readonly status: 'discarded' }
    | { readonly status: 'needs_input'; readonly question: string }
    | { readonly status: 'completed'; readonly sentiment: 'like' | 'dislike'; readonly targetText: string }
    | { readonly status: 'incomplete' }
  >
}

export type RequestResult =
  | { readonly status: 'one_link'; readonly url: string }
  | { readonly status: 'business_empty' }
  | { readonly status: 'incomplete'; readonly stage: 'context_observation' | 'personal_context' | 'source_window' | 'judgement_execution' | 'conflict' | 'shutdown' }

export type ObserveContextResult =
  | { readonly status: 'applied'; readonly appliedCount: number }
  | { readonly status: 'ignored' }
  | { readonly status: 'already_observed' }
  | { readonly status: 'incomplete'; readonly stage: 'context_observation' | 'conflict' }

export type ProcessFeedbackResult =
  | { readonly status: 'pass' | 'completed' | 'discarded' }
  | { readonly status: 'needs_input'; readonly question: string; readonly continuationToken: string }
  | { readonly status: 'incomplete'; readonly stage: 'feedback_interpretation' | 'feedback_commit' | 'conflict' }

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
  readonly observeContext: (input: { readonly currentText: string }, options?: CallOptions) => Promise<ObserveContextResult>
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
  readonly referenceText: string
  readonly createdAt: string
}

type PendingState = {
  readonly schemaVersion: 1
  readonly generation: number
  readonly entries: Readonly<Record<string, PendingEntry>>
}

type FeedbackEvent = {
  readonly schemaVersion: 1
  readonly id: string
  readonly sentiment: 'like' | 'dislike'
  readonly targetText: string
  readonly createdAt: string
}

const EMPTY_CONTEXT: ContextState = Object.freeze({ schemaVersion: 1, generation: 0, facts: [] })
const EMPTY_PENDING: PendingState = Object.freeze({ schemaVersion: 1, generation: 0, entries: {} })

export function createPersonalFeedApplication(options: CreatePersonalFeedApplicationOptions): PersonalFeedApplication {
  validateOptions(options)
  const now = options.now ?? (() => new Date())
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? 10_000
  const requestQueue = new AsyncQueue()
  const contextQueue = new AsyncQueue()
  const feedbackQueue = new AsyncQueue()
  const savedQueue = new AsyncQueue()
  const shutdown = new AbortController()
  const contextPath = join(options.stateDir, 'personal-context.json')
  const candidatesPath = join(options.stateDir, 'candidates.jsonl')
  const pendingPath = join(options.stateDir, 'pending-feedback.json')
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

  const observeContextWithSignal = async (currentText: string, signal: AbortSignal): Promise<ObserveContextResult> => {
    const text = validateText(currentText, 'currentText')
    const before = await contextQueue.run(async () => loadContext(contextPath))
    if (signal.aborted) return Object.freeze({ status: 'incomplete', stage: 'context_observation' })
    let interpreted: Awaited<ReturnType<PersonalFeedModel['observeContext']>>
    try {
      interpreted = await options.model.observeContext({ currentText: text, activeFacts: before.facts, signal })
    } catch {
      return Object.freeze({ status: 'incomplete', stage: 'context_observation' })
    }
    if (signal.aborted || interpreted.status === 'incomplete') {
      return Object.freeze({ status: 'incomplete', stage: 'context_observation' })
    }
    if (interpreted.status === 'applied' && !validFacts(interpreted.facts)) {
      return Object.freeze({ status: 'incomplete', stage: 'context_observation' })
    }
    return contextQueue.run(async () => {
      const latest = await loadContext(contextPath)
      if (latest.generation !== before.generation) return Object.freeze({ status: 'incomplete', stage: 'conflict' })
      const added = interpreted.status === 'applied' ? mergeFacts(latest.facts, interpreted.facts) : [...latest.facts]
      const next: ContextState = {
        schemaVersion: 1,
        generation: latest.generation + 1,
        facts: added,
      }
      await atomicWriteJson(contextPath, next)
      return interpreted.status === 'ignored'
        ? Object.freeze({ status: 'ignored' as const })
        : Object.freeze({ status: 'applied' as const, appliedCount: added.length - latest.facts.length })
    })
  }

  const observeContext = async (input: { readonly currentText: string }, call?: CallOptions): Promise<ObserveContextResult> => {
    validateExact(input, ['currentText'])
    return observeContextWithSignal(input.currentText, signalFor(call))
  }

  const request = async (input: { readonly currentText: string }, call?: CallOptions): Promise<RequestResult> => {
    validateExact(input, ['currentText'])
    const currentText = validateText(input.currentText, 'currentText')
    const signal = signalFor(call)
    return requestQueue.run(async () => {
      if (signal.aborted) return Object.freeze({ status: 'incomplete', stage: 'shutdown' })
      const observed = await observeContextWithSignal(currentText, signal)
      if (observed.status === 'incomplete') {
        return Object.freeze({ status: 'incomplete', stage: observed.stage === 'conflict' ? 'conflict' : 'context_observation' })
      }
      const personalContext = (await contextQueue.run(async () => loadContext(contextPath))).facts
      if (!contextIsSufficient(personalContext)) return Object.freeze({ status: 'incomplete', stage: 'personal_context' })
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
        return Object.freeze({ status: 'incomplete', stage: 'source_window' })
      }
      if (signal.aborted || observedWindow.status === 'incomplete') {
        return Object.freeze({ status: 'incomplete', stage: 'source_window' })
      }
      const candidates = uniqueCandidates(observedWindow.candidates)
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
          return Object.freeze({ status: 'incomplete', stage: 'judgement_execution' })
        }
        if (signal.aborted || judgment.status === 'incomplete') {
          return Object.freeze({ status: 'incomplete', stage: 'judgement_execution' })
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
        if (judgment.status === 'qualified') return Object.freeze({ status: 'one_link', url: candidate.canonicalUrl })
      }
      return Object.freeze({ status: 'business_empty' })
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
    const before = await feedbackQueue.run(async () => loadPending(pendingPath))
    const prior = token === undefined ? undefined : before.entries[token]
    if (token !== undefined && prior === undefined) {
      return createPending(before, currentText, '请重新提供需要反馈的内容。')
    }
    if (signal.aborted) return Object.freeze({ status: 'incomplete', stage: 'feedback_interpretation' })
    let interpreted: Awaited<ReturnType<PersonalFeedModel['interpretFeedback']>>
    try {
      const resolvedReference = referenceText ?? prior?.referenceText
      interpreted = await options.model.interpretFeedback({
        currentText,
        ...(resolvedReference === undefined ? {} : { referenceText: resolvedReference }),
        signal,
      })
    } catch {
      return Object.freeze({ status: 'incomplete', stage: 'feedback_interpretation' })
    }
    if (signal.aborted || interpreted.status === 'incomplete') {
      return Object.freeze({ status: 'incomplete', stage: 'feedback_interpretation' })
    }
    if (interpreted.status === 'pass') return Object.freeze({ status: 'pass' })
    if (interpreted.status === 'needs_input') return createPending(before, currentText, validateText(interpreted.question, 'question'))
    if (interpreted.status === 'completed' && validateText(interpreted.targetText, 'targetText') === '') {
      return Object.freeze({ status: 'incomplete', stage: 'feedback_interpretation' })
    }
    if (token === undefined) {
      if (interpreted.status === 'discarded') return Object.freeze({ status: 'discarded' })
      return feedbackQueue.run(async () => {
        const event: FeedbackEvent = {
          schemaVersion: 1,
          id: randomUUID(),
          sentiment: interpreted.sentiment,
          targetText: interpreted.targetText,
          createdAt: validNow(now).toISOString(),
        }
        await appendJsonLine(feedbackPath, event)
        return Object.freeze({ status: 'completed' as const })
      })
    }
    return feedbackQueue.run(async () => {
      const latest = await loadPending(pendingPath)
      if (latest.generation !== before.generation) return Object.freeze({ status: 'incomplete', stage: 'conflict' })
      const entries = { ...latest.entries }
      delete entries[token]
      if (interpreted.status === 'completed') {
        const eventId = feedbackEventId(token)
        const priorEvents = await loadFeedbackEvents(feedbackPath)
        const event: FeedbackEvent = {
          schemaVersion: 1,
          id: eventId,
          sentiment: interpreted.sentiment,
          targetText: interpreted.targetText,
          createdAt: validNow(now).toISOString(),
        }
        if (!priorEvents.some(previous => previous.id === eventId)) await appendJsonLine(feedbackPath, event)
      }
      await atomicWriteJson(pendingPath, { schemaVersion: 1, generation: latest.generation + 1, entries })
      return Object.freeze({ status: interpreted.status as 'completed' | 'discarded' })
    })
  }

  const createPending = async (before: PendingState, referenceText: string, question: string): Promise<ProcessFeedbackResult> => {
    const continuationToken = randomBytes(32).toString('base64url')
    return feedbackQueue.run(async () => {
      const latest = await loadPending(pendingPath)
      if (latest.generation !== before.generation) return Object.freeze({ status: 'incomplete', stage: 'conflict' })
      const entries = {
        ...latest.entries,
        [continuationToken]: { referenceText, createdAt: validNow(now).toISOString() },
      }
      await atomicWriteJson(pendingPath, { schemaVersion: 1, generation: latest.generation + 1, entries })
      return Object.freeze({ status: 'needs_input', question, continuationToken })
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
    await Promise.allSettled([options.observer.close()])
    const idle = Promise.all([
      requestQueue.idle(), contextQueue.idle(), feedbackQueue.idle(), savedQueue.idle(),
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

function mergeFacts(existing: readonly PersonalContextFact[], incoming: readonly PersonalContextFact[]): PersonalContextFact[] {
  const merged = new Map(existing.map(fact => [`${fact.lane}:${fact.statement.toLocaleLowerCase()}`, fact]))
  for (const fact of incoming) merged.set(`${fact.lane}:${fact.statement.toLocaleLowerCase()}`, Object.freeze({ ...fact }))
  return [...merged.values()]
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

function uniqueCandidates(input: readonly XCandidate[]): XCandidate[] {
  const unique = new Map<string, XCandidate>()
  for (const candidate of input) {
    if (!validCandidate(candidate)) throw new PersonalFeedStorageError('source observer returned an invalid candidate')
    if (!unique.has(candidate.stableId)) unique.set(candidate.stableId, Object.freeze({ ...candidate }))
  }
  return [...unique.values()]
}

function validCandidate(value: unknown): value is XCandidate {
  if (!isRecord(value) || typeof value.stableId !== 'string' || !/^x-status:[1-9]\d*$/u.test(value.stableId)
    || typeof value.canonicalUrl !== 'string' || typeof value.body !== 'string' || value.body.trim() === ''
    || typeof value.authorHandle !== 'string' || typeof value.publishedAt !== 'string') return false
  const canonical = canonicalizeUrl(value.canonicalUrl)
  return canonical === value.canonicalUrl && value.stableId === `x-status:${canonical.split('/')[5] ?? ''}`
}

async function loadPending(path: string): Promise<PendingState> {
  const value = await readJson<unknown>(path, EMPTY_PENDING)
  if (!isRecord(value) || value.schemaVersion !== 1 || !Number.isSafeInteger(value.generation) || !isRecord(value.entries)
    || Object.entries(value.entries).some(([token, entry]) => !/^[A-Za-z0-9_-]{43}$/u.test(token)
      || !isRecord(entry) || typeof entry.referenceText !== 'string' || typeof entry.createdAt !== 'string')) {
    throw new PersonalFeedStorageError('pending feedback state is invalid')
  }
  return value as unknown as PendingState
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
