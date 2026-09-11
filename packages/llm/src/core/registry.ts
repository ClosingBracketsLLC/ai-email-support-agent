/**
 * The managed Anthropic provider (task brief §core/registry.ts): the raw adapter, metered
 * (innermost — so every rung's API call becomes its own `llm_calls` row), rate-limited by a
 * shared per-model pool, and climbing the structured-output ladder (outermost).
 */
import type { Secret } from '@aesa/crypto'
import { createAnthropicProvider } from '../adapters/anthropic/index.ts'
import type { MeterSink } from '../metering/types.ts'
import { withMetering } from '../metering/with-metering.ts'
import type { ModelPricing } from '../pricing/types.ts'
import { createLlmLimiter, withLimiter, type LlmLimiter } from './limiter.ts'
import { withStructuredLadder } from './structured.ts'
import type { LlmProvider } from './types.ts'

export interface ManagedProviderOptions {
  apiKey: Secret
  sink: MeterSink
  /** Shared across every `createManagedProvider` call that should draw from the same pool —
   * omit to get a fresh `MANAGED_MAX_CONCURRENT_PER_MODEL` pool of this call's own. */
  limiter?: LlmLimiter
  fetchFn?: typeof fetch
  pricing?: ModelPricing[]
}

/** Sized to our own Anthropic tier, not any one org's — this is the shared managed pool, keyed
 * `managed:${provider}:${model}` by `withLimiter`'s default. */
export const MANAGED_MAX_CONCURRENT_PER_MODEL = 4

export function createManagedProvider(opts: ManagedProviderOptions): LlmProvider {
  const raw = createAnthropicProvider({ apiKey: opts.apiKey, fetchFn: opts.fetchFn })
  const metered = withMetering(raw, opts.sink, { pricing: opts.pricing, cacheTtl: '1h' })
  const limiter = opts.limiter ?? createLlmLimiter({ maxConcurrentPerKey: MANAGED_MAX_CONCURRENT_PER_MODEL })
  const limited = withLimiter(metered, limiter)
  return withStructuredLadder(limited)
}
