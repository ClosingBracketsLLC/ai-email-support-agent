import type { LlmErrorCode } from '../core/errors.ts'
import type { ChatResult, ChatUsage, LlmRole, ParseStrategy } from '../core/types.ts'

/** One row per LLM API call — mirrors `llm_calls` (packages/db/src/schema/runs.ts) field for
 * field. `agentId`/`runId` are null when absent from the request's `meta` (a probe/sandbox call
 * has neither). */
export interface MeterRecord {
  orgId: string
  agentId: string | null
  runId: string | null
  role: LlmRole
  provider: string
  model: string
  idempotencyKey: string
  usage: ChatUsage
  costMicros: number
  costUnknown: boolean
  latencyMs: number
  finish: ChatResult<unknown>['finish'] | 'error'
  parseStrategy: ParseStrategy
  errorCode: LlmErrorCode | null
  /** Phase 6 BYOK routing, from `req.meta.mode` (default `'managed'`) — which meter the sink's
   * cost bump goes to. */
  mode: 'managed' | 'byok'
  /** The `llm_credentials` row this call was made under, from `req.meta.credentialId`; null for
   * a managed call. */
  credentialId: string | null
}

/** Implementations never throw — `withMetering` guards the call anyway (never trust it blindly). */
export interface MeterSink {
  record(rec: MeterRecord): Promise<void>
}
