/**
 * `agent_runs` bookkeeping: the append-only event trace, the guarded finish, and the platform-side
 * backstop that aborts runs whose process is gone. The run ROW itself is created by the gate
 * (`caps.ts`) — it is the spend row, so nothing here creates one.
 */
import { and, eq, lt, sql } from 'drizzle-orm'
import type { UsageTotals } from '@aesa/agent'
import { agentRunEvents, agentRuns, type OrgTx, type PlatformTx } from '@aesa/db'

export type RunEventKind = 'prompt' | 'call' | 'guardrail' | 'decision' | 'error'

/**
 * Appends one trace event. `seq` is computed in the INSERT itself (`1 + MAX(seq)` for the run) so
 * the read and the write are one statement and cannot interleave; the `(run_id, seq)` unique index
 * is the backstop if two transactions ever try the same number anyway.
 *
 * `org_id` comes from the transaction's own branded org — an event can only ever belong to the
 * tenant whose RLS scope wrote it.
 */
export async function appendRunEvent(tx: OrgTx, runId: string, kind: RunEventKind, payload: Record<string, unknown>): Promise<void> {
  await tx.insert(agentRunEvents).values({
    orgId: tx.orgId,
    runId,
    kind,
    payload,
    seq: sql`(SELECT COALESCE(MAX(${agentRunEvents.seq}), 0) + 1 FROM ${agentRunEvents} WHERE ${agentRunEvents.runId} = ${runId})`,
  })
}

/**
 * Settles a run: the outcome, the scrubbed error fields and the whole run's usage totals (one run
 * can make several model calls; the accumulator's totals land here once). Guarded on
 * `status = 'running'`, so a retry that reaches a run something else already settled returns false
 * and rewrites nothing.
 */
export async function finishRun(
  tx: OrgTx,
  p: {
    runId: string
    status: 'succeeded' | 'failed' | 'aborted'
    output?: unknown
    errorCode?: string
    errorMessage?: string
    usage: UsageTotals
    now: Date
  },
): Promise<boolean> {
  const rows = await tx
    .update(agentRuns)
    .set({
      status: p.status,
      ...(p.output !== undefined ? { output: p.output } : {}),
      errorCode: p.errorCode ?? null,
      errorMessage: p.errorMessage ?? null,
      inputTokens: p.usage.inputTokens,
      outputTokens: p.usage.outputTokens,
      cacheReadTokens: p.usage.cacheReadTokens,
      cacheWriteTokens: p.usage.cacheWriteTokens,
      apiCalls: p.usage.apiCalls,
      costMicros: p.usage.costMicros,
      finishedAt: p.now,
    })
    .where(and(eq(agentRuns.id, p.runId), eq(agentRuns.status, 'running')))
    .returning({ id: agentRuns.id })
  return rows.length > 0
}

/**
 * The backstop sweep's half of stuck-run recovery (Task 14): every `running` run started before
 * `olderThan` belongs to a process that is gone — its job long since expired — so the row is flipped
 * to `aborted` and reported back for the sweep to audit. Cross-org by construction (`PlatformTx`),
 * and it only flips rows: the sweep owns the audit trail, and a platform transaction has no `OrgTx`
 * to write tenant audit rows through anyway.
 */
export async function markStuckRuns(tx: PlatformTx, olderThan: Date): Promise<{ id: string; orgId: string }[]> {
  return tx
    .update(agentRuns)
    .set({ status: 'aborted', errorCode: 'stuck', finishedAt: sql`now()` })
    .where(and(eq(agentRuns.status, 'running'), lt(agentRuns.startedAt, olderThan)))
    .returning({ id: agentRuns.id, orgId: agentRuns.orgId })
}
