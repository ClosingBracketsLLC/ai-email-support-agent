/**
 * Records one `MeterRecord` per call, success or failure (task brief §metering/with-metering.ts).
 * `sink.record` is awaited inside a try/catch of its own — a throwing sink is swallowed
 * (`console.error`), never allowed to fail the draft/triage/probe call it's metering.
 */
import { LlmError } from '../core/errors.ts'
import type { ChatRequest, ChatResult, ChatUsage, LlmProvider } from '../core/types.ts'
import { computeCostMicros } from '../pricing/cost.ts'
import { findPricing, PRICING_SEED } from '../pricing/seed.ts'
import type { ModelPricing } from '../pricing/types.ts'
import type { MeterRecord, MeterSink } from './types.ts'

const ZERO_USAGE: ChatUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, apiCalls: 0 }

async function safeRecord(sink: MeterSink, rec: MeterRecord): Promise<void> {
  try {
    await sink.record(rec)
  } catch (err) {
    console.error('withMetering: sink.record threw, dropping this record', err)
  }
}

export function withMetering(inner: LlmProvider, sink: MeterSink, opts?: { pricing?: ModelPricing[]; cacheTtl?: '5m' | '1h' }): LlmProvider {
  const pricingSeed = opts?.pricing ?? PRICING_SEED
  const cacheTtl = opts?.cacheTtl ?? '5m'

  return {
    kind: inner.kind,

    capabilities(model: string) {
      return inner.capabilities(model)
    },

    async chat<T>(req: ChatRequest<T>): Promise<ChatResult<T>> {
      const start = performance.now()
      try {
        const result = await inner.chat(req)
        const pricing = findPricing(result.model, pricingSeed)
        await safeRecord(sink, {
          orgId: req.meta.orgId,
          agentId: req.meta.agentId ?? null,
          runId: req.meta.runId ?? null,
          role: req.meta.role,
          provider: result.provider,
          model: result.model,
          idempotencyKey: req.meta.idempotencyKey,
          usage: result.usage,
          costMicros: pricing ? computeCostMicros(result.usage, pricing, cacheTtl) : 0,
          costUnknown: pricing === null,
          latencyMs: result.latencyMs,
          finish: result.finish,
          parseStrategy: result.parseStrategy,
          errorCode: null,
        })
        return result
      } catch (err) {
        const latencyMs = performance.now() - start
        const pricing = findPricing(req.model, pricingSeed)
        await safeRecord(sink, {
          orgId: req.meta.orgId,
          agentId: req.meta.agentId ?? null,
          runId: req.meta.runId ?? null,
          role: req.meta.role,
          provider: inner.kind,
          model: req.model,
          idempotencyKey: req.meta.idempotencyKey,
          usage: { ...ZERO_USAGE },
          costMicros: 0,
          costUnknown: pricing === null,
          latencyMs,
          finish: 'error',
          parseStrategy: 'none',
          errorCode: err instanceof LlmError ? err.code : 'permanent',
        })
        throw err
      }
    },
  }
}
