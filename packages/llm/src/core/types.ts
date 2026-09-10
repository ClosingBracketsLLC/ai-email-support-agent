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
  cacheWriteTokens: number
  apiCalls: number
}

export type ParseStrategy = 'native' | 'json_mode' | 'repair' | 'extract' | 'none'

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
}
