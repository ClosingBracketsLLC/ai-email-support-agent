import type { ModelPricing } from './types.ts'

/**
 * USD per MTok, seed date 2026-09-09 for the Anthropic rows (verified against Anthropic's published
 * rates) and 2026-09-12 for the BYOK rows. Anthropic cache reads price at 0.1x the input rate;
 * cache writes at 1.25x (5-minute TTL) or 2x (1-hour TTL) the input rate. Each `pattern` is
 * prefix-anchored so a future dated snapshot of the same model (e.g. a hypothetical
 * `claude-opus-5-20270101`) still resolves to this row without a seed update.
 *
 * These rows MUST stay identical to `packages/db/migrations/0020_provider_hardening.sql`'s
 * `model_pricing` INSERT: this array is the code-seeded fallback `withMetering` prices against
 * when no database rows were loaded, and a drift between the two would price the same call two
 * ways depending on which path ran. A BYOK row prices the OWNER's spend for their dashboard, never
 * a platform bill — cache-write rates are 0 for every provider with no placeable breakpoint.
 *
 * Order matters: `findPricing` takes the FIRST matching pattern, so `gpt-5-mini` has to precede
 * `gpt-5`, whose `^gpt-5(-|$)` would otherwise swallow it.
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
  {
    id: 'gpt-5-mini',
    pattern: /^gpt-5-mini(-|$)/,
    inputPerMtok: 0.25,
    outputPerMtok: 2,
    cacheReadPerMtok: 0.025,
    cacheWrite5mPerMtok: 0,
    cacheWrite1hPerMtok: 0,
  },
  {
    id: 'gpt-5',
    pattern: /^gpt-5(-|$)/,
    inputPerMtok: 1.25,
    outputPerMtok: 10,
    cacheReadPerMtok: 0.125,
    cacheWrite5mPerMtok: 0,
    cacheWrite1hPerMtok: 0,
  },
  {
    id: 'deepseek-chat',
    pattern: /^deepseek-chat(-|$)/,
    inputPerMtok: 0.27,
    outputPerMtok: 1.1,
    cacheReadPerMtok: 0.07,
    cacheWrite5mPerMtok: 0,
    cacheWrite1hPerMtok: 0,
  },
  {
    id: 'deepseek-reasoner',
    pattern: /^deepseek-reasoner(-|$)/,
    inputPerMtok: 0.55,
    outputPerMtok: 2.19,
    cacheReadPerMtok: 0.14,
    cacheWrite5mPerMtok: 0,
    cacheWrite1hPerMtok: 0,
  },
  {
    id: 'llama-3.3-70b-versatile',
    pattern: /^llama-3\.3-70b-versatile(-|$)/,
    inputPerMtok: 0.59,
    outputPerMtok: 0.79,
    cacheReadPerMtok: 0,
    cacheWrite5mPerMtok: 0,
    cacheWrite1hPerMtok: 0,
  },
  {
    id: 'llama-3.1-8b-instant',
    pattern: /^llama-3\.1-8b-instant(-|$)/,
    inputPerMtok: 0.05,
    outputPerMtok: 0.08,
    cacheReadPerMtok: 0,
    cacheWrite5mPerMtok: 0,
    cacheWrite1hPerMtok: 0,
  },
]

/** Looks up the pricing row for `model`, or `null` when no seeded row's `pattern` matches it. */
export function findPricing(model: string, seed: ModelPricing[] = PRICING_SEED): ModelPricing | null {
  return seed.find((row) => row.pattern.test(model)) ?? null
}
