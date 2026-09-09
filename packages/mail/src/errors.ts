export class MailApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly reason?: string,
  ) {
    super(message)
    this.name = 'MailApiError'
  }
}

/** The provider's sync cursor (Gmail historyId / Graph delta token) is no longer valid — the
 * caller must fall back to a full resync. */
export class CursorExpiredError extends Error {
  constructor(message: string = 'Sync cursor is no longer valid') {
    super(message)
    this.name = 'CursorExpiredError'
  }
}

export class MessageGoneError extends Error {
  constructor(message: string = 'Message no longer exists') {
    super(message)
    this.name = 'MessageGoneError'
  }
}

export class ProviderRateLimitError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs: number | null,
  ) {
    super(message)
    this.name = 'ProviderRateLimitError'
  }
}

/** refresh/exchange rejected — reauth_required. */
export class ProviderAuthError extends Error {
  constructor(message: string = 'Provider authorization was rejected') {
    super(message)
    this.name = 'ProviderAuthError'
  }
}

export const isCursorExpired = (e: unknown): e is CursorExpiredError => e instanceof CursorExpiredError

export const isMessageGone = (e: unknown): e is MessageGoneError => e instanceof MessageGoneError
