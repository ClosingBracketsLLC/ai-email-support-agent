/**
 * `llm.probe`'s one model exchange (spec §Capabilities are probed, not assumed).
 */
import type { ProbeResultView } from '@aesa/contracts'
import { z } from 'zod'
import { LlmError } from './errors.ts'
import { scrubSecrets } from './shared.ts'
import type { ChatMeta, LlmProvider } from './types.ts'

/** Deliberately two trivial fields: the probe is testing whether the ENDPOINT honours a
 * structured-output rung, not whether the model is clever. */
const ProbeSchema = z.object({ answer: z.enum(['yes', 'no']), n: z.number().int() })

export const PROBE_MAX_OUTPUT_TOKENS = 64
export const PROBE_TIMEOUT_MS = 20_000

export interface ProbeMeta {
  orgId: string
  mode: 'byok' | 'managed'
  credentialId?: string
  /** Every call this probe makes suffixes this (`:chat`, `:structured:<rung>`), so one probe's
   * `llm_calls` rows are distinct from each other AND from the next probe of the same credential. */
  idempotencyPrefix: string
}

/**
 * Spec §Capabilities are probed, not assumed: the models list (when the adapter has one — a failure
 * here is informational), one tiny chat, then the 2-field structured probe at `native` and, failing
 * that, `json_mode` — driven against the RAW adapter (never the ladder) so the answer says which
 * rung the endpoint itself honours. Every call is metered under role `probe` when the caller wraps
 * the provider in `withMetering`. `ok` is "the chat step worked"; `structured: 'none'` is a
 * downgrade, not a failure.
 */
export async function probeProvider(
  provider: LlmProvider,
  model: string,
  meta: ProbeMeta,
  signal?: AbortSignal,
): Promise<ProbeResultView> {
  const start = performance.now()
  const probedAt = new Date().toISOString()
  const base: Omit<ChatMeta, 'idempotencyKey'> = {
    orgId: meta.orgId,
    role: 'probe',
    mode: meta.mode,
    ...(meta.credentialId === undefined ? {} : { credentialId: meta.credentialId }),
  }
  // The whole probe shares ONE budget: a caller's own signal never lengthens it, and an endpoint
  // that hangs on the models list cannot leave the screen spinning past PROBE_TIMEOUT_MS.
  const budget = AbortSignal.timeout(PROBE_TIMEOUT_MS)
  const sig = signal ? AbortSignal.any([signal, budget]) : budget

  let models: string[] | null = null
  if (provider.listModels) {
    try {
      models = await provider.listModels(sig)
    } catch {
      // Informational only: plenty of OpenAI-compatible servers serve no /models at all.
      models = null
    }
  }

  try {
    await provider.chat({
      model,
      system: [],
      messages: [{ role: 'user', content: 'Reply with the single word OK.' }],
      maxOutputTokens: 8,
      signal: sig,
      meta: { ...base, idempotencyKey: `${meta.idempotencyPrefix}:chat` },
    })
  } catch (err) {
    // An `LlmError` was already scrubbed by whichever adapter's `mapError` produced it; anything
    // else is an arbitrary throw whose message this stringifies verbatim — and this message is
    // PERSISTED (`llm_credentials.last_probe`, which the api returns and Settings → AI renders) and
    // passed to `markCredentialDead`, so it must pass the same scrub every adapter message does.
    const e = err instanceof LlmError ? err : new LlmError(scrubSecrets(String(err)), 'permanent', false)
    return {
      ok: false,
      probedAt,
      models,
      chat: 'failed',
      structured: null,
      latencyMs: Math.round(performance.now() - start),
      error: { code: e.code, message: e.message.slice(0, 200) },
    }
  }

  const ask = (mode: 'native' | 'json_mode') =>
    provider.chat({
      model,
      system: [{ id: 'probe', text: 'You answer a yes/no question and echo a number.', stability: 'static' }],
      messages: [{ role: 'user', content: 'Is water wet? Also give the number 7.' }],
      output: { name: 'probe', schema: ProbeSchema, mode },
      maxOutputTokens: PROBE_MAX_OUTPUT_TOKENS,
      signal: sig,
      meta: { ...base, idempotencyKey: `${meta.idempotencyPrefix}:structured:${mode}` },
    })

  let structured: 'native' | 'json_mode' | 'none' = 'none'
  /**
   * Spec §LLM provider adapter: an OpenAI-compatible or local server's `json_schema` support is
   * "treated as json_mode UNLESS PROBE PASSES", and "presets are overridden by the stored probe
   * result". So for every one of those kinds the native rung is ALWAYS attempted, whatever the
   * preset guessed — the preset is a guess about someone else's endpoint, and this is the one call
   * that can replace it with a fact. A server without `json_schema` 400s on the attempt, which the
   * catch below turns into a failed rung and the json_mode rung then answers; that one wasted call,
   * once per probe, is the price of DISCOVERING the capability instead of assuming it forever.
   *
   * Anthropic is the exception, and keeps the capability-gated order: its table is a fact about the
   * models this platform ships against, not a guess, so a model it calls json_mode-only never spends
   * a call proving `native` fails.
   */
  const rungs: ('native' | 'json_mode')[] =
    provider.kind !== 'anthropic' || provider.capabilities(model).structuredOutput === 'native'
      ? ['native', 'json_mode']
      : ['json_mode']
  for (const mode of rungs) {
    try {
      const r = await ask(mode)
      if (r.parsed !== null) {
        structured = mode
        break
      }
    } catch {
      // A throwing rung is a failed rung — an endpoint that 400s on `response_format` is exactly
      // what this probe exists to discover, and it must not fail the whole probe.
    }
  }

  return { ok: true, probedAt, models, chat: 'ok', structured, latencyMs: Math.round(performance.now() - start), error: null }
}
