/**
 * Maps every error an OpenAI-compatible call can throw onto the shared `LlmError` taxonomy —
 * the same order, and the same scrub, as the Anthropic adapter's `mapError`. Order matters: the
 * SDK's error classes form a hierarchy (`APIUserAbortError`, `APIConnectionError` and the 4xx
 * classes all extend `APIError`), so the specific classes are checked before the generic
 * fallbacks. Verified against the installed `openai` 7.15.0 (`core/error.d.ts`), where each of
 * these is both a named export and a static on the `OpenAI` class.
 */
import OpenAI from 'openai'
import { LlmError } from '../../core/errors.ts'
import { CONTEXT_LENGTH_PATTERN, parseRetryAfterMs, scrubSecrets, withCauseMessage } from '../../core/shared.ts'

export function mapError(err: unknown): LlmError {
  if (err instanceof OpenAI.RateLimitError) {
    const retryAfterMs = parseRetryAfterMs(err.headers?.get('retry-after'))
    return new LlmError(scrubSecrets(err.message), 'rate_limit', true, retryAfterMs)
  }
  if (err instanceof OpenAI.AuthenticationError || err instanceof OpenAI.PermissionDeniedError) {
    return new LlmError(scrubSecrets(err.message), 'auth', false)
  }
  if (err instanceof OpenAI.BadRequestError) {
    const code = CONTEXT_LENGTH_PATTERN.test(err.message) ? 'context_too_long' : 'permanent'
    return new LlmError(scrubSecrets(err.message), code, false)
  }
  // A caller-aborted request (req.signal) — transient and retryable, since the caller may simply
  // retry with a fresh signal/deadline.
  if (err instanceof OpenAI.APIUserAbortError) {
    return new LlmError(scrubSecrets(err.message || 'aborted'), 'transient', true)
  }
  if (err instanceof OpenAI.InternalServerError || err instanceof OpenAI.APIConnectionError) {
    return new LlmError(scrubSecrets(withCauseMessage(err)), 'transient', true)
  }
  if (err instanceof OpenAI.APIError) {
    return new LlmError(scrubSecrets(err.message), 'permanent', false)
  }
  const message = err instanceof Error ? err.message : String(err)
  return new LlmError(scrubSecrets(message), 'permanent', false)
}
