/** Per-call policy supplied by the calling program, never inferred by a model. */
export type InteractionMode = 'background' | 'interactive'

export type InteractionReply =
  | { readonly action: 'accept'; readonly text: string }
  | { readonly action: 'decline' | 'cancel' | 'unavailable' | 'timeout' }

export type InteractionStopReason =
  | 'interaction_unavailable'
  | 'interaction_declined'
  | 'interaction_cancelled'
  | 'interaction_timeout'

/** Only raw user answers cross this boundary; protocol identities stay outside. */
export interface InteractionOptions {
  readonly mode?: InteractionMode
  readonly ask?: (question: string, signal: AbortSignal) => Promise<InteractionReply>
}
