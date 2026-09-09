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

export interface ChatRequest<T> {
  model: string
  system: SystemBlock[]
  messages: { role: 'user' | 'assistant'; content: string }[]
  /** Present -> the adapter forces a tool call and strict-parses its input against `schema`.
   * Absent -> a plain text call; `parsed` is always null. */
  output?: { name: string; schema: z.ZodType<T> }
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
  chat<T>(req: ChatRequest<T>): Promise<ChatResult<T>>
}
