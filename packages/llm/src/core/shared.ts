/**
 * Helpers both adapters need, lifted verbatim out of the Anthropic adapter when Phase 6 added the
 * OpenAI-compatible one. They must stay ONE implementation: a scrub that covers only Anthropic's
 * key prefix, or a context-length probe that only matches Anthropic's wording, would let a BYOK
 * provider's key reach a log or mis-classify its 400s.
 */
import { z } from 'zod'

/**
 * Strips an API key, and a Bearer-header tail carrying one, out of any error message before it can
 * reach a log or bubble up to a caller. The key pattern covers every provider this package can
 * talk to: OpenAI/DeepSeek/OpenRouter (`sk-`, `sk-or-`), Groq (`gsk_`) and Anthropic (`sk-ant-`).
 * `sk-` already prefixes `sk-ant-`/`sk-or-`, so those alternatives are belt-and-braces — a future
 * prefix that does NOT start with `sk-` is what the alternation is really there for.
 */
const API_KEY_PATTERN = /(sk-|gsk_|sk-or-|sk-ant-)[A-Za-z0-9_-]{6,}/g
const BEARER_PATTERN = /Bearer\s+\S+/gi

export function scrubSecrets(message: string): string {
  return message.replace(API_KEY_PATTERN, '[redacted]').replace(BEARER_PATTERN, 'Bearer [redacted]')
}

/** "400 whose message mentions context/token length" — each provider words an over-long prompt
 * differently ("prompt is too long", "maximum context length is 128000 tokens", ...), so this
 * matches the concept rather than one exact phrase. */
export const CONTEXT_LENGTH_PATTERN = /(context|token).{0,40}length|too long|maximum context/i

export function parseRetryAfterMs(header: string | null | undefined): number | undefined {
  if (!header) return undefined
  const seconds = Number(header)
  if (!Number.isFinite(seconds) || seconds < 0) return undefined
  return seconds * 1000
}

/**
 * The SDKs collapse a raw `fetch` failure into a connection error with a fixed, uninformative
 * message ("Connection error."); the actual failure — including anything a lower layer put in ITS
 * message, which could itself embed a secret, e.g. a proxy echoing back the request line —
 * survives only on `err.cause`. Folding it in here, BEFORE scrubbing, is what makes an adapter's
 * scrub cover a raw network throw and not just the SDK's own HTTP-error messages.
 */
export function withCauseMessage(err: Error): string {
  const cause = err.cause
  if (cause instanceof Error && cause.message && cause.message !== err.message) {
    return `${err.message}: ${cause.message}`
  }
  return err.message
}

/** Every structured-output rung asks for this shape, never the caller's schema directly — the
 * APIs reject a top-level `oneOf`/`anyOf` without `type: 'object'`, which a discriminated-union
 * caller schema produces. The adapters unwrap `.decision` again when they parse the reply. */
export function envelopeSchema<T>(schema: z.ZodType<T>): z.ZodType<{ decision: T }> {
  return z.object({ decision: schema })
}

/** zod 4's `z.toJSONSchema` emits a `$schema` meta key; it describes the schema DOCUMENT, not the
 * output shape, and carries nothing a model needs — stripped before it reaches a request body. */
export function toJsonObjectSchema(schema: z.ZodType<unknown>): Record<string, unknown> {
  const jsonSchema = z.toJSONSchema(schema) as Record<string, unknown> & { type: 'object' }
  const { $schema, ...rest } = jsonSchema
  void $schema
  return rest
}
