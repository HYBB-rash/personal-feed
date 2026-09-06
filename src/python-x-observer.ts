import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { XCandidate, XObservation, XObserver } from './application.ts'

export interface PythonXObserverOptions {
  readonly pythonBin?: string
  readonly observerCliPath?: string
  readonly stateDir?: string
  readonly timeoutMs?: number
}

export function resolveObserverCliPath(): string {
  const moduleDirectory = fileURLToPath(new URL('.', import.meta.url))
  return join(moduleDirectory, '..', 'python', 'x_personal_feed_observer_cli.py')
}

/** Uses an existing X tab through the observer's loopback-only browser endpoint. */
export function createPythonXObserver(rawOptions: PythonXObserverOptions = {}): XObserver {
  const pythonBin = rawOptions.pythonBin ?? 'python3'
  const observerCliPath = rawOptions.observerCliPath ?? resolveObserverCliPath()
  const timeoutMs = rawOptions.timeoutMs ?? 90_000
  if (pythonBin.trim() === '' || observerCliPath.trim() === '' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError('Python X observer options are invalid')
  }
  if (rawOptions.stateDir !== undefined && rawOptions.stateDir.trim() === '') {
    throw new TypeError('Python X observer stateDir is invalid')
  }
  const active = new Set<AbortController>()
  let closed = false

  const observe = async (input: {
    readonly requestId: string
    readonly cutoff: string
    readonly shanghaiDay: string
    readonly signal: AbortSignal
  }): Promise<XObservation> => {
    if (closed || input.signal.aborted) return incomplete('observation_failed')
    const controller = new AbortController()
    active.add(controller)
    const signal = AbortSignal.any([input.signal, controller.signal])
    const payload = JSON.stringify({
      schemaVersion: 1,
      requestId: input.requestId,
      cutoff: input.cutoff,
      shanghaiDay: input.shanghaiDay,
      deadlineEpochMs: Date.now() + timeoutMs,
    })
    try {
      const raw = await run(pythonBin, observerCliPath, payload, timeoutMs, signal, rawOptions.stateDir)
      return parseObservation(raw, input)
    } catch {
      return incomplete('observation_failed')
    } finally {
      active.delete(controller)
    }
  }

  const close = async (): Promise<void> => {
    closed = true
    for (const controller of active) controller.abort(new Error('observer closed'))
  }

  return Object.freeze({ observe, close })
}

function run(
  pythonBin: string,
  observerCliPath: string,
  payload: string,
  timeoutMs: number,
  signal: AbortSignal,
  stateDir: string | undefined,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(pythonBin, [observerCliPath, payload], {
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 2 * 1024 * 1024,
      signal,
      env: childEnvironment(stateDir),
    }, (error, stdout, stderr) => {
      if (error !== null) reject(error)
      else if (stderr !== '' || !stdout.endsWith('\n') || stdout.slice(0, -1).includes('\n')) reject(new Error('observer emitted invalid output'))
      else resolve(stdout.slice(0, -1))
    })
  })
}

function childEnvironment(stateDir: string | undefined): NodeJS.ProcessEnv {
  return {
    ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }),
    ...(process.env.HOME === undefined ? {} : { HOME: process.env.HOME }),
    ...(process.env.XDG_STATE_HOME === undefined ? {} : { XDG_STATE_HOME: process.env.XDG_STATE_HOME }),
    ...(process.env.LANG === undefined ? {} : { LANG: process.env.LANG }),
    ...(process.env.LC_ALL === undefined ? {} : { LC_ALL: process.env.LC_ALL }),
    ...(stateDir === undefined ? {} : { PERSONAL_FEED_STATE_DIR: stateDir }),
  }
}

function parseObservation(raw: string, request: {
  readonly requestId: string
  readonly cutoff: string
  readonly shanghaiDay: string
}): XObservation {
  const value: unknown = JSON.parse(raw)
  if (!isRecord(value) || value.schemaVersion !== 1 || value.requestId !== request.requestId
    || value.cutoff !== request.cutoff || value.shanghaiDay !== request.shanghaiDay
    || !Array.isArray(value.surfaces)) {
    return incomplete('observation_failed')
  }
  if (!validSurfaces(value.surfaces, value.kind)) return incomplete('observation_failed')
  if (value.kind === 'incomplete') {
    const partial = value.surfaces.some(face => face.kind === 'partial' || face.kind === 'complete' || face.kind === 'natural_zero')
    return incomplete(partial ? 'partial_observation' : 'observation_failed')
  }

  const candidates: XCandidate[] = []
  let insufficient = false
  for (const face of value.surfaces) {
    if (face.kind === 'natural_zero') continue
    for (const rawOccurrence of face.occurrences ?? []) {
      const occurrence = rawOccurrence as Record<string, unknown>
      const body = occurrence.body as Record<string, unknown>
      if (body.kind === 'insufficient') {
        insufficient = true
        continue
      }
      const identifier = /^https:\/\/x\.com\/[a-z0-9_]{1,15}\/status\/([1-9]\d*)$/u.exec(occurrence.sourceUrl as string)?.[1]
      candidates.push(Object.freeze({
        stableId: `x-status:${identifier}`,
        canonicalUrl: occurrence.sourceUrl as string,
        body: body.text as string,
        authorHandle: occurrence.authorHandle as string,
        publishedAt: occurrence.publishedAt as string,
        surface: face.surface,
      }))
    }
  }
  return insufficient ? incomplete('material_insufficient') : Object.freeze({ status: 'complete', candidates: Object.freeze(candidates) })
}

type ParsedSurface = Record<string, unknown> & {
  readonly surface: 'for_you' | 'following' | 'explore'
  readonly surfaceOrdinal: number
  readonly kind: string
  readonly occurrences?: readonly unknown[]
}

function validSurfaces(value: readonly unknown[], overallKind: unknown): value is readonly ParsedSurface[] {
  if (value.length !== 3 || (overallKind !== 'complete' && overallKind !== 'incomplete')) return false
  for (const [index, rawFace] of value.entries()) {
    if (!isRecord(rawFace) || !isSurface(rawFace.surface) || rawFace.surface !== ['for_you', 'following', 'explore'][index]
      || rawFace.surfaceOrdinal !== index || !Number.isSafeInteger(rawFace.surfaceOrdinal) || typeof rawFace.kind !== 'string') return false
    if (overallKind === 'incomplete') {
      if ('occurrences' in rawFace || !['complete', 'natural_zero', 'partial', 'failed', 'unknown'].includes(rawFace.kind)) return false
      continue
    }
    if (!Array.isArray(rawFace.occurrences)) return false
    if (rawFace.kind !== 'complete' && rawFace.kind !== 'natural_zero') return false
    if (rawFace.kind === 'natural_zero' && rawFace.occurrences.length !== 0) return false
    if (rawFace.kind === 'complete' && rawFace.occurrences.length === 0) return false
    for (const [occurrenceIndex, rawOccurrence] of rawFace.occurrences.entries()) {
      if (!validOccurrence(rawOccurrence, occurrenceIndex)) return false
    }
  }
  return true
}

function validOccurrence(value: unknown, index: number): value is Record<string, unknown> {
  if (!isRecord(value) || value.occurrenceOrdinal !== index || !Number.isSafeInteger(value.occurrenceOrdinal)
    || typeof value.publishedAt !== 'string'
    || typeof value.sourceUrl !== 'string' || typeof value.authorHandle !== 'string'
    || !isRecord(value.body)) return false
  const match = /^https:\/\/x\.com\/([a-z0-9_]{1,15})\/status\/([1-9]\d*)$/u.exec(value.sourceUrl)
  if (match === null) return false
  if (value.body.kind === 'sufficient') {
    return typeof value.body.text === 'string' && value.body.text.trim() !== ''
  }
  return value.body.kind === 'insufficient' && typeof value.body.reason === 'string' && value.body.reason.trim() !== ''
}

function incomplete(reason: 'material_insufficient' | 'partial_observation' | 'observation_failed'): XObservation {
  return Object.freeze({ status: 'incomplete', stage: 'source_window', reason })
}

function isSurface(value: unknown): value is 'for_you' | 'following' | 'explore' {
  return value === 'for_you' || value === 'following' || value === 'explore'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
