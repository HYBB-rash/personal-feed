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
    if (closed || input.signal.aborted) return Object.freeze({ status: 'incomplete', stage: 'source_window' })
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
      return Object.freeze({ status: 'incomplete', stage: 'source_window' })
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
    || value.cutoff !== request.cutoff || value.shanghaiDay !== request.shanghaiDay) {
    return Object.freeze({ status: 'incomplete', stage: 'source_window' })
  }
  if (value.kind !== 'complete' || !Array.isArray(value.surfaces)) {
    return Object.freeze({ status: 'incomplete', stage: 'source_window' })
  }
  const candidates: XCandidate[] = []
  for (const face of value.surfaces) {
    if (!isRecord(face) || !isSurface(face.surface) || !Array.isArray(face.occurrences)) {
      return Object.freeze({ status: 'incomplete', stage: 'source_window' })
    }
    for (const occurrence of face.occurrences) {
      if (!isRecord(occurrence) || typeof occurrence.sourceUrl !== 'string'
        || typeof occurrence.authorHandle !== 'string' || typeof occurrence.publishedAt !== 'string'
        || !isRecord(occurrence.body) || occurrence.body.kind !== 'sufficient' || typeof occurrence.body.text !== 'string') continue
      const identifier = /^https:\/\/x\.com\/[a-z0-9_]{1,15}\/status\/([1-9]\d*)$/u.exec(occurrence.sourceUrl)?.[1]
      if (identifier === undefined) return Object.freeze({ status: 'incomplete', stage: 'source_window' })
      candidates.push(Object.freeze({
        stableId: `x-status:${identifier}`,
        canonicalUrl: occurrence.sourceUrl,
        body: occurrence.body.text,
        authorHandle: occurrence.authorHandle,
        publishedAt: occurrence.publishedAt,
        surface: face.surface,
      }))
    }
  }
  return Object.freeze({ status: 'complete', candidates: Object.freeze(candidates) })
}

function isSurface(value: unknown): value is 'for_you' | 'following' | 'explore' {
  return value === 'for_you' || value === 'following' || value === 'explore'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
