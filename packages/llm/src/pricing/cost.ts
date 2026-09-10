import type { ChatUsage } from '../core/types.ts'
import type { ModelPricing } from './types.ts'

/**
 * Integer micro-dollars. `usage.inputTokens` are the UNCACHED tokens (Anthropic reports them
 * separately from `cacheReadTokens`/`cacheWriteTokens`), so this never double-counts a cached
 * token at both the input rate and a cache rate.
 *
 * `tokens * pricePerMtok` is already micro-dollars: cost in USD is `tokens / 1e6 * pricePerMtok`,
 * and a micro-dollar is USD * 1e6, so the two `1e6`s cancel.
 */
export function computeCostMicros(usage: ChatUsage, pricing: ModelPricing, cacheTtl: '5m' | '1h'): number {
  const cacheWritePerMtok = cacheTtl === '1h' ? pricing.cacheWrite1hPerMtok : pricing.cacheWrite5mPerMtok
  const micros =
    usage.inputTokens * pricing.inputPerMtok +
    usage.outputTokens * pricing.outputPerMtok +
    usage.cacheReadTokens * pricing.cacheReadPerMtok +
    usage.cacheWriteTokens * cacheWritePerMtok
  return Math.round(micros)
}
