import type { z } from 'zod'

/**
 * Phase 3 drives `cache_control` placement from this: `static` system blocks (product policy,
 * shared instructions) are stable across calls and cache well; `agent` blocks vary per-agent but
 * are stable within a run; `volatile` blocks (the customer's own message, timestamps) never cache.
 * Phase 2 sends every block as plain text regardless of stability — see the Anthropic adapter.
 */
export type Stability = 'static' | 'agent' | 'volatile'

export interface SystemBlock {
  id: string
  text: string
  stability: Stability
}

export type LlmRole = 'triage' | 'draft' | 'guidance_suggest' | 'probe'

export interface ChatMeta {
  orgId: string
  agentId?: string
  runId?: string
  role: LlmRole
  idempotencyKey: string
  /** Phase 6 BYOK routing: which meter (`llm_cost_micros` vs `llm_cost_micros_byok`) the call's
   * cost bumps. Absent (a pre-Phase-6 caller, or a probe/sandbox call with nothing to route)
   * defaults to `'managed'` in `withMetering`. */
  mode?: 'managed' | 'byok'
  /** The `llm_credentials` row this call was made under, when `mode` is `'byok'`. */
  credentialId?: string
}

/** The two structured-output rungs an adapter can be asked for. `json_mode` is Phase 2's
 * forced-tool trick; `native` is the provider's own structured-output feature. */
export type StructuredMode = 'native' | 'json_mode'

/**
 * What a model can do, as the provider that owns it reports — not every model in a provider's
 * lineup supports every feature (e.g. `claude-haiku-4-5` has no `effort`). `structuredOutput`
 * includes `'none'` for a model with neither native structured output nor tool support.
 */
export interface Capabilities {
  structuredOutput: 'native' | 'json_mode' | 'none'
  tools: boolean
  effort: boolean
  /** Minimum cacheable prefix in tokens (null = never cache). opus-5 512, sonnet-5 1024, haiku-4-5 4096. */
  cacheMinTokens: number | null
}

export type Effort = 'low' | 'medium' | 'high'

export interface ChatRequest<T> {
  model: string
  system: SystemBlock[]
  messages: { role: 'user' | 'assistant'; content: string }[]
  /** Present -> the adapter forces structured output and strict-parses the result against
   * `schema`. Absent -> a plain text call; `parsed` is always null.
   * `mode` is the adapter rung the ladder (Task 7) is asking for; absent = the adapter's best. */
  output?: { name: string; schema: z.ZodType<T>; mode?: StructuredMode }
  effort?: Effort
  /** Static blocks always get the 1-hour breakpoint when the prefix clears cacheMinTokens; the
   * per-agent 5-minute breakpoint is opt-in (spec: only above ~12 drafts/hour). */
  cache?: { agentBreakpoint: boolean }
  maxOutputTokens: number
  signal?: AbortSignal
  meta: ChatMeta
}

export interface ChatUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  /** Every cache-write token, both TTLs together — what `llm_calls.cache_write_tokens` records. */
  cacheWriteTokens: number
  /**
   * The TTL split of `cacheWriteTokens`, when the provider reports one (Anthropic's
   * `usage.cache_creation`). One request can write BOTH: the adapter puts a 1-hour breakpoint on the
   * static prefix and an opt-in 5-minute one on the agent block, and a 5m write costs 1.25x the
   * input rate against a 1h write's 2x — so pricing the whole total at one rate over-charges the 5m
   * tokens by ~60%. Absent means the provider gave no breakdown: `computeCostMicros` then prices the
   * unattributed remainder at the TTL its caller configured.
   */
  cacheWrite5mTokens?: number
  cacheWrite1hTokens?: number
  apiCalls: number
}

/**
 * Which rung produced `parsed`. `plain` is Phase 6's rung for a model whose `structuredOutput` is
 * `'none'`: no adapter rung exists, so the ladder asks for JSON in plain text and parses the reply
 * itself. `none` means nothing parsed.
 */
export type ParseStrategy = 'native' | 'json_mode' | 'plain' | 'repair' | 'extract' | 'none'

export interface ChatResult<T> {
  text: string
  parsed: T | null
  parseStrategy: ParseStrategy
  usage: ChatUsage
  finish: 'stop' | 'length' | 'tool_limit' | 'refusal' | 'unknown'
  provider: string
  model: string
  latencyMs: number
  providerRequestId?: string
}

export interface LlmProvider {
  readonly kind: string
  capabilities(model: string): Capabilities
  chat<T>(req: ChatRequest<T>): Promise<ChatResult<T>>
  /**
   * The model ids this endpoint actually serves, when the adapter can ask. Optional: a
   * BYOK endpoint may not implement `/models` at all, and `probeProvider` treats a failure here
   * as informational, never fatal. Every wrapper in this package forwards it when the inner
   * provider has one.
   */
  listModels?(signal?: AbortSignal): Promise<string[]>
}
