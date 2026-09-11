import type { ChatUsage } from '../core/types.ts'
import type { ModelPricing } from './types.ts'

/**
 * Integer micro-dollars. `usage.inputTokens` are the UNCACHED tokens (Anthropic reports them
 * separately from `cacheReadTokens`/`cacheWriteTokens`), so this never double-counts a cached
 * token at both the input rate and a cache rate.
 *
 * `tokens * pricePerMtok` is already micro-dollars: cost in USD is `tokens / 1e6 * pricePerMtok`,
 * and a micro-dollar is USD * 1e6, so the two `1e6`s cancel.
 *
 * Cache writes are priced per TTL, not per call: one request writes a 1-hour entry for the static
 * prefix (2x input) and, when the agent breakpoint is on, a 5-minute one for the agent block
 * (1.25x). `cacheTtl` is only the FALLBACK for tokens the provider did not attribute to a bucket —
 * pricing an attributed 5m write at the caller's declared 1h rate over-charges it by ~60%, and that
 * number is what `llm_calls.cost_micros` -> `usage_counters` -> the per-org daily spend cap all rest
 * on.
 */
export function computeCostMicros(usage: ChatUsage, pricing: ModelPricing, cacheTtl: '5m' | '1h'): number {
  const fallbackWritePerMtok = cacheTtl === '1h' ? pricing.cacheWrite1hPerMtok : pricing.cacheWrite5mPerMtok
  const write5m = usage.cacheWrite5mTokens ?? 0
  const write1h = usage.cacheWrite1hTokens ?? 0
  // Never negative: a total below the reported split (it should not happen) prices as fully attributed.
  const writeUnattributed = Math.max(0, usage.cacheWriteTokens - write5m - write1h)
  const micros =
    usage.inputTokens * pricing.inputPerMtok +
    usage.outputTokens * pricing.outputPerMtok +
    usage.cacheReadTokens * pricing.cacheReadPerMtok +
    write5m * pricing.cacheWrite5mPerMtok +
    write1h * pricing.cacheWrite1hPerMtok +
    writeUnattributed * fallbackWritePerMtok
  return Math.round(micros)
}
