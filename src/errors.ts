export class PersonalFeedInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PersonalFeedInputError'
  }

  readonly code = 'invalid_input'
}

export class PersonalFeedScopeConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PersonalFeedScopeConflictError'
  }
}

export class PersonalFeedStorageError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'PersonalFeedStorageError'
  }

  readonly code = 'storage_failure'
}

export class PersonalFeedClosedError extends Error {
  constructor(message = 'personal-feed is closed') {
    super(message)
    this.name = 'PersonalFeedClosedError'
  }

  readonly code = 'service_closed'
}

/** Compatibility aliases for the neutral state owners extracted from the original package. */
export { PersonalFeedInputError as PersonalFeedScopeInputError }
export { PersonalFeedStorageError as PersonalFeedScopeStoreError }
