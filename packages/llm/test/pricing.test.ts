import { describe, expect, it } from 'vitest'
import { computeCostMicros } from '../src/pricing/cost.ts'
import { findPricing, PRICING_SEED } from '../src/pricing/seed.ts'

describe('PRICING_SEED / findPricing', () => {
  it('finds the seeded pricing row for a known model id', () => {
    const pricing = findPricing('claude-opus-5')
    expect(pricing).not.toBeNull()
    expect(pricing?.id).toBe('claude-opus-5')
    expect(pricing).toMatchObject({
      inputPerMtok: 5,
      outputPerMtok: 25,
      cacheReadPerMtok: 0.5,
      cacheWrite5mPerMtok: 6.25,
      cacheWrite1hPerMtok: 10,
    })
  })

  it('finds sonnet-5 and haiku-4-5 rows too', () => {
    expect(findPricing('claude-sonnet-5')).toMatchObject({
      inputPerMtok: 2,
      outputPerMtok: 10,
      cacheReadPerMtok: 0.2,
      cacheWrite5mPerMtok: 2.5,
      cacheWrite1hPerMtok: 4,
    })
    expect(findPricing('claude-haiku-4-5')).toMatchObject({
      inputPerMtok: 1,
      outputPerMtok: 5,
      cacheReadPerMtok: 0.1,
      cacheWrite5mPerMtok: 1.25,
      cacheWrite1hPerMtok: 2,
    })
  })

  it('returns null for an unknown model', () => {
    expect(findPricing('claude-nonexistent-9')).toBeNull()
  })

  it('accepts an explicit seed override', () => {
    const custom = [{ ...PRICING_SEED[0]!, id: 'custom-model', pattern: /^custom-model$/ }]
    expect(findPricing('custom-model', custom)?.id).toBe('custom-model')
    expect(findPricing('claude-opus-5', custom)).toBeNull()
  })
})

describe('computeCostMicros', () => {
  it('sums input, output, cache-read and cache-write (1h) micro-dollars for opus-5', () => {
    const opus5 = findPricing('claude-opus-5')!
    const micros = computeCostMicros(
      { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 4000, cacheWriteTokens: 2000, apiCalls: 1 },
      opus5,
      '1h',
    )
    expect(micros).toBe(39_500)
  })

  it('uses the 5m cache-write rate when asked for the 5m ttl', () => {
    const opus5 = findPricing('claude-opus-5')!
    const micros = computeCostMicros(
      { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 2000, apiCalls: 1 },
      opus5,
      '5m',
    )
    // 2000 tokens * 6.25 micros/token (1.25x input) = 12_500
    expect(micros).toBe(12_500)
  })

  it('returns an integer even when a fractional rate would produce one', () => {
    const haiku = findPricing('claude-haiku-4-5')!
    const micros = computeCostMicros(
      { inputTokens: 0, outputTokens: 0, cacheReadTokens: 3, cacheWriteTokens: 0, apiCalls: 1 },
      haiku,
      '5m',
    )
    // 3 tokens * 0.1 micros/token = 0.3 -> rounds to 0, an integer (ledger 69: pin the value, not
    // just its integer-ness — `Math.round` and `Math.ceil` are both integer-valued, only one is right).
    expect(micros).toBe(0)
    expect(Number.isInteger(micros)).toBe(true)
  })

  // -- I1 (final-B): a 5-minute cache write must not be billed at the 1-hour rate --

  it('prices each cache-write TTL bucket at its own rate, whatever the configured fallback ttl is', () => {
    const opus5 = findPricing('claude-opus-5')!
    const micros = computeCostMicros(
      {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 3000,
        cacheWrite5mTokens: 2000,
        cacheWrite1hTokens: 1000,
        apiCalls: 1,
      },
      opus5,
      // The managed provider configures '1h'; the 5m bucket must still price at 6.25, not 10.
      '1h',
    )
    // 2000 * 6.25 (1.25x input) + 1000 * 10 (2x input) = 12_500 + 10_000
    expect(micros).toBe(22_500)
  })

  it('resolves each BYOK seed row, and gpt-5-mini BEFORE gpt-5 (whose pattern would swallow it)', () => {
    expect(findPricing('gpt-5-mini')!.id).toBe('gpt-5-mini')
    expect(findPricing('gpt-5-mini-2026-01-01')!.id).toBe('gpt-5-mini')
    expect(findPricing('gpt-5')!.id).toBe('gpt-5')
    expect(findPricing('deepseek-reasoner')!.id).toBe('deepseek-reasoner')
    expect(findPricing('llama-3.3-70b-versatile')!.id).toBe('llama-3.3-70b-versatile')
    // The dot in a llama id is escaped, so it matches a literal '.' and not any character.
    expect(findPricing('llama-3x3-70b-versatile')).toBeNull()
  })

  it('prices cache-write tokens the provider did not attribute to a TTL at the configured ttl', () => {
    const opus5 = findPricing('claude-opus-5')!
    const base = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, apiCalls: 1 }

    // No split reported at all -> the whole total falls back to the configured ttl.
    expect(computeCostMicros({ ...base, cacheWriteTokens: 2000 }, opus5, '1h')).toBe(20_000)
    expect(computeCostMicros({ ...base, cacheWriteTokens: 2000 }, opus5, '5m')).toBe(12_500)

    // A partial split -> the attributed tokens price by bucket, the remainder by the fallback.
    const partial = computeCostMicros(
      { ...base, cacheWriteTokens: 3000, cacheWrite5mTokens: 2000, cacheWrite1hTokens: 0 },
      opus5,
      '1h',
    )
    // 2000 * 6.25 + 1000 unattributed * 10 = 12_500 + 10_000
    expect(partial).toBe(22_500)
  })
})
