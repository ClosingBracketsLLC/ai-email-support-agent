/**
 * The two compositions this package ships: the managed Anthropic provider, and Phase 6's BYOK
 * provider over whichever adapter an org's credential names. Both stack the same way — the raw
 * adapter, metered (innermost, so every rung's API call becomes its own `llm_calls` row),
 * rate-limited, and climbing the structured-output ladder (outermost).
 */
import { createPinnedFetch, type Secret } from '@aesa/crypto'
import type { LlmProviderId } from '@aesa/contracts'
import { createAnthropicProvider } from '../adapters/anthropic/index.ts'
import { createOpenAiCompatibleProvider } from '../adapters/openai-compatible/index.ts'
import type { MeterSink } from '../metering/types.ts'
import { withMetering } from '../metering/with-metering.ts'
import type { ModelPricing } from '../pricing/types.ts'
import { createLlmLimiter, withLimiter, type LlmLimiter } from './limiter.ts'
import { withStructuredLadder } from './structured.ts'
import type { Capabilities, ChatMeta, LlmProvider } from './types.ts'

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

/** A BYOK key is ONE org's own rate limit, and a small one — two in flight is enough to keep a
 * draft and a triage moving without tripping a free-tier ceiling the owner never sees us hit. */
export const BYOK_MAX_CONCURRENT_PER_CREDENTIAL = 2

/** Stamps `mode`/`credentialId` onto every request's meta. Wrapped OUTSIDE metering, so the
 * `llm_calls` row `withMetering` writes already carries them. */
export function withMeta(inner: LlmProvider, patch: Pick<ChatMeta, 'mode' | 'credentialId'>): LlmProvider {
  return {
    kind: inner.kind,
    capabilities: (model: string) => inner.capabilities(model),
    ...(inner.listModels ? { listModels: (signal?: AbortSignal) => inner.listModels!(signal) } : {}),
    chat: (req) => inner.chat({ ...req, meta: { ...req.meta, ...patch } }),
  }
}

export interface ByokProviderOptions {
  provider: LlmProviderId
  apiKey: Secret
  /** The validated https base URL for `custom`; a preset's own URL otherwise. */
  baseUrl: string
  orgId: string
  credentialId: string
  sink: MeterSink
  /** Shared across every BYOK provider on the process; keyed `byok:${orgId}:${credentialId}` so a
   * stalled tenant never starves another. */
  limiter: LlmLimiter
  /** Omit it and the SSRF-pinned transport below is used — see `createByokProvider`. */
  fetchFn?: typeof fetch
  pricing?: ModelPricing[]
  /** The stored probe verdict: `'none'` forces the plain rung regardless of the preset. */
  structuredOverride?: 'native' | 'json_mode' | 'none' | null
  /** `raw: true` returns the bare adapter with metering only (the probe drives the rungs itself). */
  raw?: boolean
}

/**
 * One org's own key, composed the same way the managed provider is. The probe's stored verdict
 * REPLACES what the preset claimed, in BOTH directions (spec §LLM provider adapter: "presets are
 * overridden by the stored probe result"): `native` RAISES a model the preset only guessed at
 * json_mode — an endpoint that has been SEEN to honour `json_schema` should be asked for it — and
 * `json_mode`/`none` narrow, because an endpoint SEEN to reject `response_format` must not be asked
 * again on every draft. A preset already at `none` stays there: there is nothing below it to raise
 * from that the probe could have proven.
 *
 * The override reaches the OpenAI-COMPATIBLE adapter only: for those presets the capability table
 * is a guess about someone else's endpoint, whereas the Anthropic adapter's table is a fact about
 * models we ship against, and a BYOK Anthropic key talks to the same API the managed one does.
 */
export function createByokProvider(o: ByokProviderOptions): LlmProvider {
  const verdict = o.structuredOverride
  const override = verdict
    ? (_model: string, preset: Capabilities): Capabilities => ({
        ...preset,
        structuredOutput: verdict === 'native' ? 'native' : preset.structuredOutput === 'none' ? 'none' : verdict,
      })
    : undefined
  // A BYOK base URL is customer-supplied, so the SSRF pin is the DEFAULT transport on BOTH branches,
  // never something each caller has to remember to pass: `validateOutboundUrl` + a re-resolve on every
  // call + no redirects. `allowNonstandardPort` because a self-hosted OpenAI-compatible endpoint often
  // lives on :8000/:11434; the 120 s budget is the ceiling a slow local model is allowed to take.
  const fetchFn = o.fetchFn ?? createPinnedFetch({ allowNonstandardPort: true, timeoutMs: 120_000 })
  const adapter: LlmProvider =
    o.provider === 'anthropic'
      ? createAnthropicProvider({ apiKey: o.apiKey, fetchFn })
      : createOpenAiCompatibleProvider({
          kind: o.provider,
          apiKey: o.apiKey,
          baseUrl: o.baseUrl,
          fetchFn,
          ...(override ? { capabilitiesOverride: override } : {}),
        })
  // `cacheTtl: '5m'` — none of the BYOK providers exposes a TTL choice, and the OpenAI-compatible
  // adapter reports no cache-write tokens at all, so the fallback rate is never reached for them.
  const metered = withMetering(adapter, o.sink, { ...(o.pricing ? { pricing: o.pricing } : {}), cacheTtl: '5m' })
  const stamped = withMeta(metered, { mode: 'byok', credentialId: o.credentialId })
  if (o.raw) return stamped
  const limited = withLimiter(stamped, o.limiter, () => `byok:${o.orgId}:${o.credentialId}`)
  return withStructuredLadder(limited)
}
