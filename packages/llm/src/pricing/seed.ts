import type { ModelPricing } from './types.ts'

/**
 * USD per MTok, seed date 2026-09-09 (task brief, verified against Anthropic's published rates).
 * Cache reads price at 0.1x the input rate; cache writes at 1.25x (5-minute TTL) or 2x (1-hour
 * TTL) the input rate. Each `pattern` is prefix-anchored so a future dated snapshot of the same
 * model (e.g. a hypothetical `claude-opus-5-20270101`) still resolves to this row without a
 * seed update.
 */
export const PRICING_SEED: ModelPricing[] = [
  {
    id: 'claude-opus-5',
    pattern: /^claude-opus-5(-|$)/,
    inputPerMtok: 5,
    outputPerMtok: 25,
    cacheReadPerMtok: 0.5,
    cacheWrite5mPerMtok: 6.25,
    cacheWrite1hPerMtok: 10,
  },
  {
    id: 'claude-sonnet-5',
    pattern: /^claude-sonnet-5(-|$)/,
    inputPerMtok: 2,
    outputPerMtok: 10,
    cacheReadPerMtok: 0.2,
    cacheWrite5mPerMtok: 2.5,
    cacheWrite1hPerMtok: 4,
  },
  {
    id: 'claude-haiku-4-5',
    pattern: /^claude-haiku-4-5(-|$)/,
    inputPerMtok: 1,
    outputPerMtok: 5,
    cacheReadPerMtok: 0.1,
    cacheWrite5mPerMtok: 1.25,
    cacheWrite1hPerMtok: 2,
  },
]

/** Looks up the pricing row for `model`, or `null` when no seeded row's `pattern` matches it. */
export function findPricing(model: string, seed: ModelPricing[] = PRICING_SEED): ModelPricing | null {
  return seed.find((row) => row.pattern.test(model)) ?? null
}
