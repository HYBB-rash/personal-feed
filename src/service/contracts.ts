import type { PersonalFeedApplication } from '../application.ts'

/** Channel-neutral boundary implemented by the Personal Feed domain layer. */
export type PersonalFeedApplicationPort = Pick<
  PersonalFeedApplication,
  'request' | 'observeContext' | 'processFeedback' | 'recordFeedback' | 'listSaved'
>

export interface PersonalFeedServiceConfig {
  readonly host: string
  readonly port: number
  readonly mcpToken: string
  readonly stateDir: string
  readonly observerCliPath: string
  readonly toolTimeoutMs: number
  readonly shutdownGraceMs?: number
  readonly model: {
    readonly baseURL: string
    readonly model: string
    readonly apiKey: string
    readonly timeoutMs: number
  }
}

export interface SafeLogEvent {
  readonly operation: string
  readonly requestId: string
  readonly result: 'success' | 'error'
  readonly resultCategory: string
  readonly durationMs: number
}

export type SafeLogger = (event: SafeLogEvent) => void
