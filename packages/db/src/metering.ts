import { sql } from 'drizzle-orm'
import type { MeterRecord, MeterSink } from '@aesa/llm'
import type { Db } from './client.ts'
import { llmCalls, usageCounters } from './schema/index.ts'
import { withOrg, type OrgTx } from './tenant.ts'

/** The four usage_counters meters every llm_calls row bumps. Plain strings — adding a meter needs no migration. */
export const LLM_METERS = {
  calls: 'llm_calls',
  costMicros: 'llm_cost_micros',
  inputTokens: 'llm_input_tokens',
  outputTokens: 'llm_output_tokens',
} as const

/**
 * The two `usage_counters` meters the SEND path writes (worker `send.execute` writes them; the api's
 * usage endpoint reads them through this same constant, so the literals can never drift between the
 * writer and the reader). Plain strings, like `LLM_METERS` — adding a meter needs no migration.
 *
 * `review_sends` counts every reply that actually went out after an owner review;
 * `ai_handled_conversations` counts each TICKET at most once per calendar month (the
 * `tickets.ai_handled_month` stamp is what makes the second send of the same month a no-op).
 */
export const SEND_METERS = {
  reviewSends: 'review_sends',
  aiHandledConversations: 'ai_handled_conversations',
} as const

const utcDayString = (d: Date): string => d.toISOString().slice(0, 10)

async function bumpMeter(tx: OrgTx, orgId: string, day: string, meter: string, delta: number): Promise<void> {
  await tx.insert(usageCounters).values({ orgId, day, meter, value: delta })
    .onConflictDoUpdate({
      target: [usageCounters.orgId, usageCounters.day, usageCounters.meter],
      set: { value: sql`${usageCounters.value} + ${delta}` },
    })
}

/**
 * Builds the `MeterSink` that turns one `MeterRecord` (from `@aesa/llm`'s `withMetering`) into an
 * `llm_calls` row and the four `usage_counters` bumps. Type-only import from `@aesa/llm` — no
 * runtime edge between the packages.
 *
 * Never throws and never rejects: every failure (a down database, a non-uuid `orgId` — `withOrg`
 * throws a `TypeError` synchronously inside the returned promise for that) goes to `opts.onError`
 * (default `console.error`) so a metering failure never takes down the draft/triage/probe call it
 * is metering.
 */
export function createMeterSink(db: Db, opts?: { now?: () => Date; onError?: (err: unknown) => void }): MeterSink {
  const now = opts?.now ?? (() => new Date())
  const onError = opts?.onError ?? ((err: unknown) => console.error('createMeterSink: record failed', err))

  return {
    async record(rec: MeterRecord): Promise<void> {
      try {
        await withOrg(db, rec.orgId, async (tx) => {
          const [inserted] = await tx.insert(llmCalls).values({
            orgId: rec.orgId,
            runId: rec.runId,
            agentId: rec.agentId,
            role: rec.role,
            provider: rec.provider,
            model: rec.model,
            idempotencyKey: rec.idempotencyKey,
            inputTokens: rec.usage.inputTokens,
            outputTokens: rec.usage.outputTokens,
            cacheReadTokens: rec.usage.cacheReadTokens,
            cacheWriteTokens: rec.usage.cacheWriteTokens,
            apiCalls: rec.usage.apiCalls,
            costMicros: rec.costMicros,
            latencyMs: rec.latencyMs,
            finish: rec.finish,
            parseStrategy: rec.parseStrategy,
            errorCode: rec.errorCode,
          })
            .onConflictDoNothing({ target: llmCalls.idempotencyKey })
            .returning({ id: llmCalls.id })

          if (!inserted) return // already recorded — meters were bumped the first time

          const day = utcDayString(now())
          await bumpMeter(tx, rec.orgId, day, LLM_METERS.calls, 1)
          await bumpMeter(tx, rec.orgId, day, LLM_METERS.costMicros, rec.costMicros)
          await bumpMeter(tx, rec.orgId, day, LLM_METERS.inputTokens, rec.usage.inputTokens + rec.usage.cacheReadTokens + rec.usage.cacheWriteTokens)
          await bumpMeter(tx, rec.orgId, day, LLM_METERS.outputTokens, rec.usage.outputTokens)
        })
      } catch (err) {
        onError(err)
      }
    },
  }
}
