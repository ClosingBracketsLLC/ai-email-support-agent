/**
 * Anthropic adapter (Phase 2 slice — spec §LLM provider adapter, deviations 4-5). Ports the
 * forced-tool pattern from doge-buddy's `apps/ops/src/support/triage.ts` `createAnthropicTriageCall`:
 * one `messages.create` call, `tool_choice` forcing the single output tool when the caller asks
 * for structured output, and a strict re-parse of the tool's `input` that never throws on a
 * schema violation — the caller (the triage runtime) owns what a failed attempt means.
 *
 * `maxRetries: 0` on the client: retry policy belongs to the job layer (spec §Budgets), not this
 * adapter — a transparent SDK retry here would double-count the job layer's own retry budget and
 * hide rate-limit/5xx signal the caller needs to make its own backoff decision.
 */
import Anthropic from '@anthropic-ai/sdk'
import type { Secret } from '@aesa/crypto'
import { z } from 'zod'
import { LlmError } from '../../core/errors.ts'
import type { ChatRequest, ChatResult, ChatUsage, LlmProvider, ParseStrategy } from '../../core/types.ts'

export interface CreateAnthropicProviderOptions {
  apiKey: Secret
  fetchFn?: typeof fetch
}

/** Strips the API key itself, and a Bearer-header tail carrying one, out of any error message
 * before it can reach a log or bubble up to a caller — the raw key must never appear in either. */
const API_KEY_PATTERN = /sk-[A-Za-z0-9_-]+/g
const BEARER_PATTERN = /Bearer\s+\S+/gi

function scrubSecrets(message: string): string {
  return message.replace(API_KEY_PATTERN, '[redacted]').replace(BEARER_PATTERN, 'Bearer [redacted]')
}

/** "400 whose message mentions context/token length" (task brief) — Anthropic's own wording for
 * an over-long prompt varies ("prompt is too long", "exceeds ... maximum context length", ...),
 * so this matches the concept rather than one exact phrase. */
const CONTEXT_LENGTH_PATTERN = /(context|token).{0,40}length|too long|maximum context/i

function parseRetryAfterMs(header: string | null | undefined): number | undefined {
  if (!header) return undefined
  const seconds = Number(header)
  if (!Number.isFinite(seconds) || seconds < 0) return undefined
  return seconds * 1000
}

/**
 * The SDK collapses every raw `fetch` failure into `Anthropic.APIConnectionError` with the fixed,
 * uninformative message "Connection error." — the actual failure (including anything a lower
 * layer put in ITS message, which could itself embed a secret, e.g. a proxy echoing back the
 * request line) survives only on `err.cause`. Folding it in here, before scrubbing, is what makes
 * this adapter's scrub cover a raw network throw and not just the SDK's own HTTP-error messages.
 */
function withCauseMessage(err: Error): string {
  const cause = err.cause
  if (cause instanceof Error && cause.message && cause.message !== err.message) {
    return `${err.message}: ${cause.message}`
  }
  return err.message
}

/**
 * Maps every error this call can throw onto the shared `LlmError` taxonomy. Order matters: the
 * SDK's error classes form a hierarchy (`APIUserAbortError` and the 4xx classes all extend
 * `APIError`), so the specific classes are checked before the generic fallbacks.
 */
function mapError(err: unknown): LlmError {
  if (err instanceof Anthropic.RateLimitError) {
    const retryAfterMs = parseRetryAfterMs(err.headers.get('retry-after'))
    return new LlmError(scrubSecrets(err.message), 'rate_limit', true, retryAfterMs)
  }
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return new LlmError(scrubSecrets(err.message), 'auth', false)
  }
  if (err instanceof Anthropic.BadRequestError) {
    const code = CONTEXT_LENGTH_PATTERN.test(err.message) ? 'context_too_long' : 'permanent'
    return new LlmError(scrubSecrets(err.message), code, false)
  }
  // A caller-aborted request (req.signal) — treated like the FakeProvider's own abort mapping:
  // transient and retryable, since the caller may simply retry with a fresh signal/deadline.
  if (err instanceof Anthropic.APIUserAbortError) {
    return new LlmError(scrubSecrets(err.message || 'aborted'), 'transient', true)
  }
  if (err instanceof Anthropic.InternalServerError || err instanceof Anthropic.APIConnectionError) {
    return new LlmError(scrubSecrets(withCauseMessage(err)), 'transient', true)
  }
  if (err instanceof Anthropic.APIError) {
    return new LlmError(scrubSecrets(err.message), 'permanent', false)
  }
  const message = err instanceof Error ? err.message : String(err)
  return new LlmError(scrubSecrets(message), 'permanent', false)
}

function mapFinish(stopReason: Anthropic.Message['stop_reason']): ChatResult<unknown>['finish'] {
  switch (stopReason) {
    case 'end_turn':
    case 'tool_use':
      return 'stop'
    case 'max_tokens':
      return 'length'
    case 'refusal':
      return 'refusal'
    default:
      return 'unknown'
  }
}

/** zod 4's `z.toJSONSchema` emits a `$schema` meta key; this adapter strips it before it reaches
 * the request body. No live Anthropic credentials were available to confirm empirically whether
 * the API rejects `$schema` on `input_schema` — stripping is the defensive default either way,
 * since `$schema` describes the schema document itself, not the tool's parameter shape, and
 * carries no information Claude needs to fill in `tool_use.input`. Verified via the fetchFn-stub
 * test that the emitted request body never carries it. */
function toInputSchema(schema: z.ZodType<unknown>): Anthropic.Tool['input_schema'] {
  const jsonSchema = z.toJSONSchema(schema) as Record<string, unknown> & { type: 'object' }
  const { $schema, ...rest } = jsonSchema
  void $schema
  return rest as Anthropic.Tool['input_schema']
}

function buildResult<T>(req: ChatRequest<T>, response: Anthropic.Message, latencyMs: number): ChatResult<T> {
  const usage: ChatUsage = {
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
    apiCalls: 1,
  }

  const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text')
  const text = textBlock?.text ?? ''

  let parsed: T | null = null
  let parseStrategy: ParseStrategy = 'none'

  if (req.output) {
    const toolUse = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
    if (toolUse) {
      try {
        parsed = req.output.schema.parse(toolUse.input)
        parseStrategy = 'native'
      } catch (err) {
        // A schema-violating tool call is a failed ATTEMPT, not a thrown error — the caller (the
        // triage runtime) decides what to do with `parsed: null` (retry, escalate, ...).
        if (!(err instanceof z.ZodError)) throw err
      }
    }
  }

  return {
    text,
    parsed,
    parseStrategy,
    usage,
    finish: mapFinish(response.stop_reason),
    provider: 'anthropic',
    model: response.model,
    latencyMs,
    providerRequestId: response.id,
  }
}

export function createAnthropicProvider(opts: CreateAnthropicProviderOptions): LlmProvider {
  const client = new Anthropic({
    apiKey: opts.apiKey.expose(),
    maxRetries: 0,
    ...(opts.fetchFn ? { fetch: opts.fetchFn } : {}),
  })

  return {
    kind: 'anthropic',

    async chat<T>(req: ChatRequest<T>): Promise<ChatResult<T>> {
      const system = req.system.map((b) => b.text).join('\n\n')
      const messages: Anthropic.MessageParam[] = req.messages.map((m) => ({ role: m.role, content: m.content }))

      const tools: Anthropic.Tool[] | undefined = req.output
        ? [
            {
              name: req.output.name,
              description: 'Record the structured result.',
              input_schema: toInputSchema(req.output.schema),
            },
          ]
        : undefined
      const toolChoice: Anthropic.ToolChoice | undefined = req.output
        ? { type: 'tool', name: req.output.name }
        : undefined

      const start = performance.now()
      let response: Anthropic.Message
      try {
        response = await client.messages.create(
          {
            model: req.model,
            max_tokens: req.maxOutputTokens,
            ...(system.length > 0 ? { system } : {}),
            messages,
            ...(tools ? { tools, tool_choice: toolChoice } : {}),
          },
          { signal: req.signal },
        )
      } catch (err) {
        throw mapError(err)
      }
      const latencyMs = performance.now() - start

      return buildResult(req, response, latencyMs)
    },
  }
}
