import { randomBytes, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { InteractionOptions, InteractionReply, InteractionStopReason } from './interaction.ts'
import { AsyncQueue } from './async-queue.ts'
import { PersonalFeedClosedError, PersonalFeedInputError, PersonalFeedStorageError } from './errors.ts'
import { appendJsonLine, atomicWriteJson, readJson, readJsonLines } from './persistence.ts'

export interface CallOptions extends InteractionOptions {
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

export type SourceLimitation = 'partial_observation' | 'material_insufficient'
export type FeedLimitation = SourceLimitation | 'judgement_incomplete'

export type XObservation =
  | { readonly status: 'complete'; readonly candidates: readonly XCandidate[] }
  | {
      readonly status: 'incomplete'
      readonly stage: 'source_window'
      readonly reason: 'observation_failed'
    }
  | {
      readonly status: 'incomplete'
      readonly stage: 'source_window'
      readonly reason: SourceLimitation
      readonly candidates?: readonly XCandidate[]
      readonly limitations?: readonly SourceLimitation[]
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
  readonly assessContext: (input: {
    readonly requestText: string
    readonly activeFacts: readonly PersonalContextFact[]
    readonly signal: AbortSignal
  }) => Promise<{ readonly status: 'completed'; readonly sufficient: boolean } | { readonly status: 'incomplete' }>
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
    readonly requestText: string
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
  | { readonly status: 'one_link'; readonly url: string; readonly limitations?: readonly FeedLimitation[] }
  | { readonly status: 'business_empty' }
  | { readonly status: 'incomplete'; readonly stage: 'source_window'; readonly reason?: 'material_insufficient' | 'partial_observation' | 'observation_failed' }
  | { readonly status: 'incomplete'; readonly stage: 'judgement_execution'; readonly reason?: 'exploration_not_ready' }
  | { readonly status: 'incomplete'; readonly stage: 'context_observation' | 'personal_context' | 'conflict' | 'shutdown'; readonly reason?: InteractionStopReason }

export type RequestResult = FeedResult

export type ObserveContextResult =
  | { readonly status: 'applied'; readonly appliedCount: number }
  | { readonly status: 'ignored' }
  | { readonly status: 'already_observed' }
  | { readonly status: 'incomplete'; readonly stage: 'context_observation' | 'conflict'; readonly reason?: InteractionStopReason }

type ContextPreparation = {
  readonly result: ObserveContextResult
  readonly effectiveFacts: readonly PersonalContextFact[]
  readonly sufficient?: boolean
  readonly clarification?: ClarificationInput
}

export type ProcessFeedbackResult =
  | { readonly status: 'pass' | 'completed' | 'discarded' }
  | { readonly status: 'needs_input'; readonly question: string }
  | { readonly status: 'incomplete'; readonly stage: 'feedback_interpretation' | 'feedback_commit' | 'conflict'; readonly reason?: InteractionStopReason }

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
  }, options?: CallOptions) => Promise<ObserveContextResult>
  readonly processFeedback: (input: {
    readonly currentText: string
    readonly referenceText?: string
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
  readonly onFailure?: (event: ApplicationFailureEvent) => void
}

export interface ApplicationFailureEvent {
  readonly event: 'application_failure'
  readonly operation: 'observe_context' | 'process_feedback'
  readonly reason: 'model_incomplete' | 'clarification_invalid' | 'context_changes_invalid'
    | 'sufficiency_invalid' | 'missing_clarification' | 'context_conflict' | 'cancelled' | 'invalid_association'
}

type ContextState = {
  readonly schemaVersion: 1
  readonly generation: number
  readonly facts: readonly PersonalContextFact[]
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
  const savedQueue = new AsyncQueue()
  const shutdown = new AbortController()
  const contextPath = join(options.stateDir, 'personal-context.json')
  const feedbackPath = join(options.stateDir, 'feedback.jsonl')
  const savedPath = join(options.stateDir, 'saved.jsonl')
  let closed = false

  const report = (operation: ApplicationFailureEvent['operation'], reason: ApplicationFailureEvent['reason']): void => {
    try { options.onFailure?.(Object.freeze({ event: 'application_failure', operation, reason })) }
    catch { /* Diagnostics cannot change the result or commit behavior. */ }
  }

  const signalFor = (call?: CallOptions): AbortSignal => {
    if (closed) throw new PersonalFeedClosedError()
    if (call?.signal !== undefined && !(call.signal instanceof AbortSignal)) {
      throw new PersonalFeedInputError('signal must be an AbortSignal')
    }
    return call?.signal === undefined ? shutdown.signal : AbortSignal.any([shutdown.signal, call.signal])
  }

  const ask = async (question: string, signal: AbortSignal, call?: CallOptions): Promise<InteractionReply> => {
    if (signal.aborted) return { action: signal.reason?.name === 'TimeoutError' ? 'timeout' : 'cancel' }
    if (call?.mode !== 'interactive' || call.ask === undefined) return { action: 'unavailable' }
    let abort!: () => void
    const cancelled = new Promise<InteractionReply>(resolve => {
      abort = () => resolve({ action: signal.reason?.name === 'TimeoutError' ? 'timeout' : 'cancel' })
      signal.addEventListener('abort', abort, { once: true })
    })
    try {
      const reply = await Promise.race([Promise.resolve().then(() => call.ask!(question, signal)), cancelled])
      if (signal.aborted) return { action: signal.reason?.name === 'TimeoutError' ? 'timeout' : 'cancel' }
      if (reply.action === 'accept' && !validModelText(reply.text)) return { action: 'unavailable' }
      return reply
    } catch (error) {
      if (error instanceof PersonalFeedInputError) throw error
      return { action: 'unavailable' }
    }
    finally { signal.removeEventListener('abort', abort) }
  }
  const stopReason = (reply: Exclude<InteractionReply, { action: 'accept' }>): InteractionStopReason =>
    ({ unavailable: 'interaction_unavailable', decline: 'interaction_declined', cancel: 'interaction_cancelled', timeout: 'interaction_timeout' })[reply.action] as InteractionStopReason

  const interruptedReason = (signal: AbortSignal): InteractionStopReason | undefined => {
    if (!signal.aborted || shutdown.signal.aborted) return undefined
    return signal.reason?.name === 'TimeoutError' ? 'interaction_timeout' : 'interaction_cancelled'
  }
  const interruptedFeed = (signal: AbortSignal): FeedResult => {
    const reason = interruptedReason(signal)
    return Object.freeze({
      status: 'incomplete',
      stage: 'shutdown',
      ...(reason === undefined ? {} : { reason }),
    })
  }

  const observeContextWithSignal = async (currentText: string, signal: AbortSignal, assessForFeed = false,
    prior?: ClarificationInput): Promise<ContextPreparation> => {
    const incomplete = (stage: 'context_observation' | 'conflict' = 'context_observation',
      reason: ApplicationFailureEvent['reason'] = stage === 'conflict' ? 'context_conflict' : 'model_incomplete'): ContextPreparation => {
      report('observe_context', reason)
      return Object.freeze({
      result: Object.freeze({ status: 'incomplete', stage }), effectiveFacts: [],
      })
    }
    const before = await contextQueue.run(async () => loadContext(contextPath))
    const interruptedContext = (): ContextPreparation => {
      report('observe_context', 'cancelled')
      const reason = interruptedReason(signal)
      return Object.freeze({
        result: Object.freeze({ status: 'incomplete', stage: 'context_observation', ...(reason === undefined ? {} : { reason }) }),
        effectiveFacts: [],
      })
    }
    if (signal.aborted) return interruptedContext()
    let interpreted: Awaited<ReturnType<PersonalFeedModel['observeContext']>>
    try {
      interpreted = await options.model.observeContext({
        currentText, activeFacts: before.facts, signal, ...(assessForFeed ? { assessForFeed: true } : {}),
        ...(prior === undefined ? {} : { clarification: prior }),
      })
      if (signal.aborted) return interruptedContext()
      if (interpreted.status !== 'applied' && interpreted.status !== 'ignored') return incomplete()
      if (!validRemaining(interpreted.remaining, prior !== undefined)
        || interpreted.resolvedReferenceText !== undefined && !validModelText(interpreted.resolvedReferenceText)) {
        return incomplete('context_observation', 'clarification_invalid')
      }
    } catch { return incomplete() }
    const sufficient = interpreted.sufficient
    if (assessForFeed && typeof sufficient !== 'boolean') return incomplete('context_observation', 'sufficiency_invalid')
    const applied = interpreted.status === 'applied'
      ? applyContextChanges(before.facts, interpreted.changes)
      : { facts: before.facts, appliedCount: 0 }
    if (applied === undefined) return incomplete('context_observation', 'context_changes_invalid')
    const effectiveFacts = Object.freeze(applied.facts.filter(fact => fact.lane !== 'existing_knowledge' || fact.epistemic === 'asserted'))
    const ready = sufficient === true && contextIsSufficient(effectiveFacts)
    // Missing categories are observable facts, not model-inferred knowledge.
    // Semantic gaps still require the model's specific question.
    const remaining = assessForFeed && !ready
      ? interpreted.remaining ?? missingContextQuestion(effectiveFacts)
      : assessForFeed ? undefined : interpreted.remaining
    if (assessForFeed && !ready && remaining == null) return incomplete('context_observation', 'missing_clarification')
    return contextQueue.run(async () => {
      const latest = await loadContext(contextPath)
      if (latest.generation !== before.generation) return incomplete('conflict')
      if (signal.aborted) return interruptedContext()
      const next: ContextState = { schemaVersion: 1, generation: latest.generation + 1, facts: applied.facts }
      await atomicWriteJson(contextPath, next)
      const clarification = remaining == null ? undefined : { originalText: prior?.originalText ?? currentText, ...((prior?.referenceText ?? interpreted.resolvedReferenceText) === undefined ? {} : { referenceText: prior?.referenceText ?? interpreted.resolvedReferenceText }), ...remaining }
      return Object.freeze({
        result: interpreted.status === 'ignored'
          ? Object.freeze({ status: 'ignored' as const })
          : Object.freeze({ status: 'applied' as const, appliedCount: applied.appliedCount }),
        effectiveFacts,
        ...(clarification === undefined ? {} : { clarification }),
        ...(assessForFeed && typeof sufficient === 'boolean' ? { sufficient } : {}),
      })
    })
  }

  const prepareInteractive = async (currentText: string, signal: AbortSignal, assessForFeed: boolean, call?: CallOptions): Promise<ContextPreparation> => {
    let prior: ClarificationInput | undefined
    let appliedCount = 0
    for (;;) {
      const prepared = await observeContextWithSignal(currentText, signal, assessForFeed, prior)
      if (prepared.result.status === 'applied') appliedCount += prepared.result.appliedCount
      if (prepared.result.status === 'incomplete') return prepared
      if (prepared.clarification === undefined) return appliedCount > 0 ? { ...prepared, result: { status: 'applied', appliedCount } } : prepared
      const reply = await ask(prepared.clarification.question, signal, call)
      if (reply.action !== 'accept') return { ...prepared, result: { status: 'incomplete', stage: 'context_observation', reason: stopReason(reply) } }
      currentText = reply.text
      prior = prepared.clarification
    }
  }

  const observeContext = async (input: { readonly currentText: string }, call?: CallOptions): Promise<ObserveContextResult> => {
    validateExact(input, ['currentText'])
    const currentText = validateText(input.currentText, 'currentText')
    return (await prepareInteractive(currentText, signalFor(call), false, call)).result
  }

  const request = async (input: { readonly currentText: string }, call?: CallOptions): Promise<RequestResult> => {
    validateExact(input, ['currentText'])
    const currentText = validateText(input.currentText, 'currentText')
    const signal = signalFor(call)
    if (signal.aborted) return interruptedFeed(signal)
    const personalContext = (await contextQueue.run(() => loadContext(contextPath))).facts
      .filter(fact => fact.lane !== 'existing_knowledge' || fact.epistemic === 'asserted')
    return requestQueue.run(() => runPreparedFeed(currentText, personalContext, signal))
  }

  // Both entry points select from the same accepted snapshot, without reinterpreting text.
  const runPreparedFeed = async (requestText: string, personalContext: readonly PersonalContextFact[], signal: AbortSignal): Promise<FeedResult> => {
    if (signal.aborted) return interruptedFeed(signal)
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
      return Object.freeze({ status: 'incomplete', stage: 'source_window', reason: 'observation_failed' })
    }
    if (signal.aborted) return interruptedFeed(signal)
    if (observedWindow.status === 'incomplete' && observedWindow.reason === 'observation_failed') {
      return Object.freeze({ status: 'incomplete', stage: 'source_window', reason: observedWindow.reason })
    }
    let sourceLimitations: readonly SourceLimitation[] = Object.freeze([])
    if (observedWindow.status === 'incomplete') {
      const parsedLimitations = distinctSourceLimitations(observedWindow.limitations)
      if (parsedLimitations === undefined || observedWindow.candidates === undefined) {
        return Object.freeze({ status: 'incomplete', stage: 'source_window', reason: observedWindow.reason })
      }
      sourceLimitations = parsedLimitations
    }
    const candidates = uniqueCandidates(observedWindow.status === 'complete' ? observedWindow.candidates : observedWindow.candidates!)
    if (candidates === undefined) return Object.freeze({ status: 'incomplete', stage: 'source_window', reason: 'material_insufficient' })
    const limitations: FeedLimitation[] = [...sourceLimitations]
    for (const candidate of candidates) {
      let judgment: Awaited<ReturnType<PersonalFeedModel['judgeCandidate']>>
      try {
        judgment = await options.model.judgeCandidate({
          requestText,
          personalContext,
          candidate,
          cutoff,
          shanghaiDay: shanghaiDay(cutoff),
          signal,
        })
      } catch {
        if (signal.aborted) return interruptedFeed(signal)
        if (!limitations.includes('judgement_incomplete')) limitations.push('judgement_incomplete')
        continue
      }
      if (signal.aborted) return interruptedFeed(signal)
      if (judgment.status === 'incomplete') {
        if (!limitations.includes('judgement_incomplete')) limitations.push('judgement_incomplete')
        continue
      }
      if (judgment.status === 'qualified') return Object.freeze({ status: 'one_link', url: candidate.canonicalUrl,
        ...(limitations.length === 0 ? {} : { limitations: Object.freeze(limitations) }) })
    }
    if (limitations.includes('judgement_incomplete')) return Object.freeze({ status: 'incomplete', stage: 'judgement_execution' })
    if (sourceLimitations.length > 0) return Object.freeze({ status: 'incomplete', stage: 'source_window', reason: sourceLimitations[0]! })
    return Object.freeze({ status: 'incomplete', stage: 'judgement_execution', reason: 'exploration_not_ready' })
  }

  const feedbackStep = async (currentText: string, referenceText: string | undefined, signal: AbortSignal,
    prior?: ClarificationInput): Promise<{ result: ProcessFeedbackResult; clarification?: ClarificationInput }> => {
    const incomplete = (stage: 'feedback_interpretation' | 'conflict' = 'feedback_interpretation',
      reason: ApplicationFailureEvent['reason'] = stage === 'conflict' ? 'context_conflict' : 'model_incomplete'): { result: ProcessFeedbackResult } => {
      report('process_feedback', reason)
      return { result: { status: 'incomplete', stage } }
    }
    const before = await contextQueue.run(async () => loadContext(contextPath))
    const interruptedFeedback = (): { result: ProcessFeedbackResult } => {
      report('process_feedback', 'cancelled')
      const reason = interruptedReason(signal)
      return { result: { status: 'incomplete', stage: 'feedback_interpretation', ...(reason === undefined ? {} : { reason }) } }
    }
    if (signal.aborted) return interruptedFeedback()
    let interpreted: Awaited<ReturnType<PersonalFeedModel['interpretFeedback']>>
    try {
      const resolvedReference = prior === undefined ? referenceText : prior.referenceText
      interpreted = await options.model.interpretFeedback({
        currentText, activeFacts: before.facts,
        ...(resolvedReference === undefined ? {} : { referenceText: resolvedReference }),
        ...(prior === undefined ? {} : { clarification: prior }), signal,
      })
      if (signal.aborted) return interruptedFeedback()
      if (!['pass', 'discarded', 'needs_input', 'completed'].includes(interpreted.status)) return incomplete()
      if (!validRemaining(interpreted.remaining, prior !== undefined)
        || interpreted.resolvedReferenceText !== undefined && !validModelText(interpreted.resolvedReferenceText)
        || interpreted.status === 'needs_input' && interpreted.remaining == null
        || interpreted.status === 'completed' && (
          !validModelText(interpreted.targetText) || !['like', 'dislike'].includes(interpreted.sentiment)
          || interpreted.sentiment === 'dislike' && !validModelText(interpreted.reason))) return incomplete('feedback_interpretation', 'clarification_invalid')
    } catch { return incomplete() }
    const applied = interpreted.changes === undefined ? { facts: before.facts, appliedCount: 0 }
      : applyContextChanges(before.facts, interpreted.changes)
    if (applied === undefined) return incomplete('feedback_interpretation', 'context_changes_invalid')
    return contextQueue.run(async () => {
      const latest = await loadContext(contextPath)
      if (latest.generation !== before.generation) return incomplete('conflict')
      if (signal.aborted) return interruptedFeedback()
      if (interpreted.changes !== undefined) await atomicWriteJson(contextPath, {
        schemaVersion: 1, generation: latest.generation + 1, facts: applied.facts,
      })
      if (interpreted.status === 'completed') {
        await loadFeedbackEvents(feedbackPath)
        await appendJsonLine(feedbackPath, {
          schemaVersion: 1, id: randomUUID(), sentiment: interpreted.sentiment,
          targetText: interpreted.targetText, createdAt: validNow(now).toISOString(),
        } satisfies FeedbackEvent)
      }
      const remaining = interpreted.remaining
      const clarification = remaining == null ? undefined : { originalText: prior?.originalText ?? currentText,
        ...((prior?.referenceText ?? referenceText ?? interpreted.resolvedReferenceText) === undefined ? {} : { referenceText: prior?.referenceText ?? referenceText ?? interpreted.resolvedReferenceText }), ...remaining }
      const result: ProcessFeedbackResult = interpreted.status === 'needs_input'
        ? { status: 'needs_input', question: interpreted.remaining.question }
        : { status: interpreted.status as 'pass' | 'completed' | 'discarded' }
      return { result, ...(clarification === undefined ? {} : { clarification }) }
    })
  }

  const processFeedback = async (input: { readonly currentText: string; readonly referenceText?: string }, call?: CallOptions): Promise<ProcessFeedbackResult> => {
    validateExact(input, ['currentText', 'referenceText'], ['currentText'])
    let currentText = validateText(input.currentText, 'currentText')
    const referenceText = optionalText(input.referenceText, 'referenceText')
    const signal = signalFor(call)
    let prior: ClarificationInput | undefined
    for (;;) {
      const step = await feedbackStep(currentText, referenceText, signal, prior)
      if (step.result.status === 'incomplete' || step.result.status === 'completed' || step.result.status === 'discarded' || step.clarification === undefined) return step.result
      const reply = await ask(step.clarification.question, signal, call)
      if (reply.action !== 'accept') return { status: 'incomplete', stage: 'feedback_interpretation', reason: stopReason(reply) }
      currentText = reply.text
      prior = step.clarification
    }
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
      if (signal.aborted) throw new PersonalFeedClosedError('operation was cancelled')
      const events = await loadSavedEvents(savedPath)
      if (signal.aborted) throw new PersonalFeedClosedError('operation was cancelled')
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
      if (signal.aborted) throw new PersonalFeedClosedError('operation was cancelled')
      const events = await loadSavedEvents(savedPath)
      if (signal.aborted) throw new PersonalFeedClosedError('operation was cancelled')
      const folded = [...foldSaved(events).values()]
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
      requestQueue.idle(), contextQueue.idle(), savedQueue.idle(),
    ]).then(() => undefined)
    let deadline: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([idle, new Promise<void>(resolve => { deadline = setTimeout(resolve, shutdownTimeoutMs) })])
    } finally { clearTimeout(deadline) }
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

function missingContextQuestion(facts: readonly PersonalContextFact[]): RemainingClarification | undefined {
  const missingInterest = !facts.some(fact => fact.lane === 'long_term_interest' && fact.stance === 'include')
  const missingKnowledge = !facts.some(fact => fact.lane === 'existing_knowledge' && fact.epistemic === 'asserted')
  if (missingInterest && missingKnowledge) return {
    question: '你的长期关注是什么？关于这些方向，你已经了解哪些内容，或有哪些明确的已有认识？',
    unresolvedScope: 'Missing explicit long-term interests and confirmed knowledge boundaries for those interests.',
  }
  if (missingInterest) return {
    question: '你的长期关注是什么？已有认识会保留，请说明你希望持续了解的方向。',
    unresolvedScope: 'Missing explicit long-term interests; retain already confirmed knowledge.',
  }
  if (missingKnowledge) return {
    question: '关于你已经说明的长期关注，你有哪些已有认识、了解过的内容，或明确的新手知识边界？',
    unresolvedScope: 'Missing confirmed knowledge boundaries relevant to the saved long-term interests; do not ask to restate those interests.',
  }
  return undefined
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

function distinctSourceLimitations(value: unknown): readonly SourceLimitation[] | undefined {
  if (!Array.isArray(value) || value.length === 0
    || value.some(item => item !== 'partial_observation' && item !== 'material_insufficient')) return undefined
  return Object.freeze([...new Set(value)] as SourceLimitation[])
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
