/**
 * `auth`/`context_too_long`/`content_filtered`/`permanent` are never retryable by construction —
 * retrying the same request against the same model cannot fix a bad key, an oversized prompt, a
 * filtered response, or a malformed request. `rate_limit` and `transient` are retryable; the job
 * layer (spec §Budgets), not this package, owns backoff and the retry budget itself.
 */
export type LlmErrorCode = 'auth' | 'rate_limit' | 'context_too_long' | 'content_filtered' | 'transient' | 'permanent'

export class LlmError extends Error {
  constructor(
    message: string,
    readonly code: LlmErrorCode,
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
  ) {
    super(message)
    this.name = 'LlmError'
  }
}
