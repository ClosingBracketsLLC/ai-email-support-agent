/**
 * Anthropic adapter (Phase 2 slice — spec §LLM provider adapter, deviations 4-5; extended Phase 3
 * — spec §LLM provider adapter cache/effort/structured-output). Ports the forced-tool pattern
 * from doge-buddy's `apps/ops/src/support/triage.ts` `createAnthropicTriageCall`: one
 * `messages.create` call, `tool_choice` forcing the single output tool when the caller asks for
 * structured output, and a strict re-parse of the tool's `input` that never throws on a schema
 * violation — the caller (the triage runtime) owns what a failed attempt means. Phase 3 adds a
 * second, native structured-output rung (`output.mode: 'native'`), `effort`, and stability-driven
 * `cache_control` placement on `system` blocks.
 *
 * `maxRetries: 0` on the client: retry policy belongs to the job layer (spec §Budgets), not this
 * adapter — a transparent SDK retry here would double-count the job layer's own retry budget and
 * hide rate-limit/5xx signal the caller needs to make its own backoff decision.
 *
 * Native structured output: `client.messages.parse()` throws a plain `AnthropicError` (not an
 * `APIError`) when the response text violates the schema, rather than returning
 * `parsed_output: null` — verified empirically against a stubbed `fetchFn` on the installed SDK
 * (0.124.0) before writing this. That contradicts this package's "never throw on a schema
 * violation" contract, so the native path below uses `messages.create()` with
 * `output_config.format` (built from `zodOutputFormat` for the envelope's JSON Schema) and parses
 * the returned text block itself with `envelope.safeParse`, exactly like the forced-tool path
 * already re-parses `tool_use.input` — one no-throw contract for both structured-output rungs.
 */
import Anthropic from '@anthropic-ai/sdk'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import type { Secret } from '@aesa/crypto'
import { z } from 'zod'
import { LlmError } from '../../core/errors.ts'
import { estimateTokens } from '../../core/tokens.ts'
import type { Capabilities, ChatRequest, ChatResult, ChatUsage, LlmProvider, ParseStrategy, Stability, StructuredMode } from '../../core/types.ts'
import { ANTHROPIC_MODELS, UNKNOWN_ANTHROPIC_MODEL } from './models.ts'

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

function capabilitiesFor(model: string): Capabilities {
  return ANTHROPIC_MODELS[model] ?? UNKNOWN_ANTHROPIC_MODEL
}

/** Both structured-output rungs (the forced tool and native `output_config.format`) ask for this
 * shape, never the caller's schema directly — the API rejects a top-level `oneOf`/`anyOf` without
 * `type: 'object'`, which a discriminated-union caller schema produces. Unwrapped again in
 * `buildResult` below. */
function envelopeSchema<T>(schema: z.ZodType<T>): z.ZodType<{ decision: T }> {
  return z.object({ decision: schema })
}

/** zod 4's `z.toJSONSchema` emits a `$schema` meta key; this adapter strips it before it reaches
 * the request body. No live Anthropic credentials were available to confirm empirically whether
 * the API rejects `$schema` on `input_schema` — stripping is the defensive default either way,
 * since `$schema` describes the schema document itself, not the tool's parameter shape, and
 * carries no information Claude needs to fill in `tool_use.input`. Verified via the fetchFn-stub
 * test that the emitted request body never carries it. */
function toJsonObjectSchema(schema: z.ZodType<unknown>): Record<string, unknown> {
  const jsonSchema = z.toJSONSchema(schema) as Record<string, unknown> & { type: 'object' }
  const { $schema, ...rest } = jsonSchema
  void $schema
  return rest
}

const STABILITY_RANK: Record<Stability, number> = { static: 0, agent: 1, volatile: 2 }

/**
 * Renders the ordered `system` text blocks and places `cache_control` per the stability rules
 * (task brief §Adapter behaviour): the LAST `static` block gets the 1h breakpoint once the
 * combined static prefix clears the model's cache minimum (a silent no-op otherwise — the intent
 * is explicit either way); the LAST `agent` block gets the opt-in 5m breakpoint only when the
 * caller asks for it; `volatile` blocks never carry one. Throws `LlmError('permanent')` when a
 * block violates the required static -> agent -> volatile order, since a breakpoint placed after
 * volatile (per-request) text would never hit on a repeat call.
 */
function buildSystemBlocks(system: ChatRequest<unknown>['system'], capabilities: Capabilities, agentBreakpoint: boolean): Anthropic.TextBlockParam[] {
  let maxRank = -1
  for (const block of system) {
    const rank = STABILITY_RANK[block.stability]
    if (rank < maxRank) {
      throw new LlmError('system blocks must be ordered static → agent → volatile', 'permanent', false)
    }
    maxRank = rank
  }

  const lastStaticIndex = system.findLastIndex((b) => b.stability === 'static')
  const lastAgentIndex = system.findLastIndex((b) => b.stability === 'agent')
  const staticText = system
    .filter((b) => b.stability === 'static')
    .map((b) => b.text)
    .join('')
  const canCacheStatic = capabilities.cacheMinTokens !== null && estimateTokens(staticText) >= capabilities.cacheMinTokens

  return system.map((block, index) => {
    const param: Anthropic.TextBlockParam = { type: 'text', text: block.text }
    if (block.stability === 'static' && index === lastStaticIndex && canCacheStatic) {
      param.cache_control = { type: 'ephemeral', ttl: '1h' }
    } else if (block.stability === 'agent' && index === lastAgentIndex && agentBreakpoint) {
      param.cache_control = { type: 'ephemeral' }
    }
    return param
  })
}

/** `mode` absent -> the adapter's best rung for this model (native when the model supports it,
 * the forced-tool json_mode fallback otherwise). */
function resolveStructuredMode(requested: StructuredMode | undefined, capabilities: Capabilities): StructuredMode {
  if (requested) return requested
  return capabilities.structuredOutput === 'native' ? 'native' : 'json_mode'
}

function buildResult<T>(req: ChatRequest<T>, mode: StructuredMode | undefined, response: Anthropic.Message, latencyMs: number): ChatResult<T> {
  // `usage.cache_creation` (SDK 0.124's `CacheCreation`) breaks the cache-write total down by TTL:
  // this request can carry a 1h breakpoint on the static prefix AND a 5m one on the agent block, and
  // the two price differently (2x vs 1.25x input). It is nullable, so the split is passed on only
  // when the provider actually reported it — `computeCostMicros` prices an unattributed total at the
  // TTL its caller configured rather than guessing here.
  const cacheCreation = response.usage.cache_creation
  const cacheWriteSplit =
    cacheCreation === null || cacheCreation === undefined
      ? null
      : { cacheWrite5mTokens: cacheCreation.ephemeral_5m_input_tokens, cacheWrite1hTokens: cacheCreation.ephemeral_1h_input_tokens }
  const usage: ChatUsage = {
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens:
      response.usage.cache_creation_input_tokens ??
      (cacheWriteSplit ? cacheWriteSplit.cacheWrite5mTokens + cacheWriteSplit.cacheWrite1hTokens : 0),
    ...(cacheWriteSplit ?? {}),
    apiCalls: 1,
  }

  const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text')
  const text = textBlock?.text ?? ''

  let parsed: T | null = null
  let parseStrategy: ParseStrategy = 'none'

  if (req.output && mode === 'native') {
    // A schema-violating or non-JSON text block is a failed ATTEMPT, not a thrown error — same
    // no-throw contract as the json_mode branch below, just reached via JSON.parse + safeParse
    // instead of a strict `.parse()` (see the module doc comment for why `messages.parse()`
    // itself isn't used here).
    if (textBlock) {
      try {
        const json: unknown = JSON.parse(textBlock.text)
        const outcome = envelopeSchema(req.output.schema).safeParse(json)
        if (outcome.success) {
          parsed = outcome.data.decision
          parseStrategy = 'native'
        }
      } catch {
        // Not valid JSON at all — parsed stays null.
      }
    }
  } else if (req.output) {
    const toolUse = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
    if (toolUse) {
      const outcome = envelopeSchema(req.output.schema).safeParse(toolUse.input)
      if (outcome.success) {
        parsed = outcome.data.decision
        parseStrategy = 'json_mode'
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

    capabilities(model: string): Capabilities {
      return capabilitiesFor(model)
    },

    async chat<T>(req: ChatRequest<T>): Promise<ChatResult<T>> {
      const capabilities = capabilitiesFor(req.model)
      const system = buildSystemBlocks(req.system, capabilities, req.cache?.agentBreakpoint === true)
      const messages: Anthropic.MessageParam[] = req.messages.map((m) => ({ role: m.role, content: m.content }))

      const mode: StructuredMode | undefined = req.output ? resolveStructuredMode(req.output.mode, capabilities) : undefined

      const tools: Anthropic.Tool[] | undefined =
        req.output && mode === 'json_mode'
          ? [
              {
                name: req.output.name,
                description: 'Record the structured result.',
                input_schema: toJsonObjectSchema(envelopeSchema(req.output.schema)) as Anthropic.Tool['input_schema'],
              },
            ]
          : undefined
      const toolChoice: Anthropic.ToolChoice | undefined =
        req.output && mode === 'json_mode' ? { type: 'tool', name: req.output.name } : undefined

      const outputFormat = req.output && mode === 'native' ? zodOutputFormat(envelopeSchema(req.output.schema)) : undefined
      const effort = req.effort && capabilities.effort ? req.effort : undefined
      const outputConfig: Anthropic.OutputConfig | undefined =
        effort !== undefined || outputFormat !== undefined
          ? {
              ...(effort !== undefined ? { effort } : {}),
              ...(outputFormat !== undefined ? { format: outputFormat } : {}),
            }
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
            ...(outputConfig ? { output_config: outputConfig } : {}),
          },
          { signal: req.signal },
        )
      } catch (err) {
        throw mapError(err)
      }
      // `llm_calls.latency_ms` is an integer column — performance.now() - start is a float, so it
      // must be rounded here, not left for the sink to reject.
      const latencyMs = Math.round(performance.now() - start)

      return buildResult(req, mode, response, latencyMs)
    },
  }
}
