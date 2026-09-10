/**
 * The draft gate: the per-ticket and per-org caps, and the `agent_runs` row that IS the spend row.
 * Ported from doge-buddy's advisory-locked cap re-check (`apps/ops/src/jobs/support-agent-run.ts`,
 * step 4) with its two-round fix history intact:
 *
 *  - The spend row is written BEFORE the model call, inside the same lock that authorized it: a
 *    process that dies mid-run still counts. Over-counting a call that never billed is the safe
 *    direction; under-counting is how a daily cap gets blown through.
 *  - `readCapsUnlocked` exists so the job can refuse a capped ticket BEFORE it claims (and so
 *    stamps nothing). That was fix round 2 upstream: with the caps checked only after the claim, a
 *    day whose org cap was exhausted still stamped `last_agent_run_at` on every ticket, and one
 *    stuck window later the claim's stuck branch charged each of them a failure — every triaged
 *    ticket falsely escalated `agent_failed` with the agent never having run once. The unlocked
 *    read keeps the common case away from the claim entirely; this locked gate is what keeps the
 *    caps correct under a genuine two-worker race, and when it refuses after a claim the caller
 *    unwinds the stamp (`unwindClaimStamp`) rather than leaving it standing.
 *
 * The lock is per org — `pg_advisory_xact_lock(hashtext('draft-gate:' || orgId))` — so one busy
 * tenant's gate never serializes another's, and it is an *xact* lock: it is released by the commit
 * or rollback of the caller's transaction, never leaked.
 */
import { and, count, eq, gt, gte, sql } from 'drizzle-orm'
import { INVARIANTS, resolveSetting, type SettingKey } from '@aesa/core'
import { agentRuns, usageCounters, type OrgTx } from '@aesa/db'
import { utcDayString } from '../date-utils.ts'

/** The `usage_counters` meter the org-wide daily draft cap is measured against. */
export const DRAFT_METER = 'draft_runs'
/** How many draft runs one org may have in flight at once. A fairness bound, not a cap: refused runs come back. */
export const PER_ORG_DRAFT_CONCURRENCY = 2

export type GateOutcome =
  | { outcome: 'proceed'; runId: string }
  | { outcome: 'ticket_capped'; runsToday: number }
  | { outcome: 'org_busy' }
  | { outcome: 'org_draft_capped' }
  | { outcome: 'org_spend_capped'; costMicrosToday: number }

/** Start of `d`'s UTC day — the boundary every daily count here is measured from. */
export function utcMidnight(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
}

const usdCapToMicros = (usd: number): number => Math.round(usd * 1_000_000)

async function meterValue(tx: OrgTx, day: string, meter: string): Promise<number> {
  const [row] = await tx
    .select({ value: usageCounters.value })
    .from(usageCounters)
    .where(and(eq(usageCounters.day, day), eq(usageCounters.meter, meter)))
  return row?.value ?? 0
}

async function draftRunsForTicketToday(tx: OrgTx, ticketId: string, midnight: Date): Promise<number> {
  const [row] = await tx
    .select({ value: count() })
    .from(agentRuns)
    .where(and(eq(agentRuns.kind, 'draft'), eq(agentRuns.ticketId, ticketId), gte(agentRuns.startedAt, midnight)))
  return row?.value ?? 0
}

export interface GateParams {
  orgId: string
  /** null for a run with no ticket (a sandbox probe); the per-ticket cap is then not applicable. */
  ticketId: string | null
  agentId: string | null
  kind: 'draft' | 'sandbox'
  provider: string
  model: string
  input: Record<string, unknown>
  settings: Partial<Record<SettingKey, unknown>>
  now: Date
}

/**
 * ONE transaction under the org's advisory lock. The order is the spec's observable order and is
 * load-bearing — a ticket that is BOTH per-ticket-capped and in a capped org must read
 * `ticket_capped`, because that is the outcome the caller escalates on (an org-cap refusal instead
 * leaves the ticket untouched and selectable again after UTC midnight):
 *
 *   1. per-ticket daily runs  ≥ AGENT_MAX_RUNS_PER_TICKET_PER_DAY → ticket_capped
 *   2. live running draft runs ≥ PER_ORG_DRAFT_CONCURRENCY        → org_busy
 *   3. usage_counters draft_runs      ≥ autonomy.daily_draft_cap  → org_draft_capped
 *   4. usage_counters llm_cost_micros ≥ autonomy.daily_llm_usd_cap × 1e6 → org_spend_capped
 *   5. otherwise: insert the `agent_runs` row (status `running`) and bump `draft_runs`.
 *
 * Step 2 only counts runs younger than `DRAFT_JOB_EXPIRE_SECONDS`: a `running` row older than the
 * job's own expiry belongs to a process that is already gone (the backstop sweep's `markStuckRuns`
 * will abort it), and letting those hold the concurrency slot would wedge the org until the sweep ran.
 */
export async function gateAndRecordRun(tx: OrgTx, p: GateParams): Promise<GateOutcome> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`draft-gate:${p.orgId}`}))`)

  const midnight = utcMidnight(p.now)
  const day = utcDayString(p.now)

  if (p.ticketId !== null) {
    const runsToday = await draftRunsForTicketToday(tx, p.ticketId, midnight)
    if (runsToday >= INVARIANTS.AGENT_MAX_RUNS_PER_TICKET_PER_DAY) return { outcome: 'ticket_capped', runsToday }
  }

  const liveSince = new Date(p.now.getTime() - INVARIANTS.DRAFT_JOB_EXPIRE_SECONDS * 1000)
  const [runningRow] = await tx
    .select({ value: count() })
    .from(agentRuns)
    .where(and(eq(agentRuns.kind, 'draft'), eq(agentRuns.status, 'running'), gt(agentRuns.startedAt, liveSince)))
  if ((runningRow?.value ?? 0) >= PER_ORG_DRAFT_CONCURRENCY) return { outcome: 'org_busy' }

  const draftsToday = await meterValue(tx, day, DRAFT_METER)
  if (draftsToday >= resolveSetting('autonomy.daily_draft_cap', { org: p.settings })) return { outcome: 'org_draft_capped' }

  const costMicrosToday = await meterValue(tx, day, 'llm_cost_micros')
  if (costMicrosToday >= usdCapToMicros(resolveSetting('autonomy.daily_llm_usd_cap', { org: p.settings }))) {
    return { outcome: 'org_spend_capped', costMicrosToday }
  }

  // The run row IS the spend row, and it goes in under the same lock as the counts that authorized
  // it — written before the model call, so it counts even if the process dies mid-run.
  const [run] = await tx
    .insert(agentRuns)
    .values({
      orgId: p.orgId, kind: p.kind, ticketId: p.ticketId, agentId: p.agentId,
      provider: p.provider, model: p.model, status: 'running', input: p.input, startedAt: p.now,
    })
    .returning({ id: agentRuns.id })
  await tx
    .insert(usageCounters)
    .values({ orgId: p.orgId, day, meter: DRAFT_METER, value: 1 })
    .onConflictDoUpdate({ target: [usageCounters.orgId, usageCounters.day, usageCounters.meter], set: { value: sql`${usageCounters.value} + 1` } })

  return { outcome: 'proceed', runId: run!.id }
}

/**
 * The unlocked, read-only counts for the job's PRE-claim checks. Plain SELECTs: no lock, no insert,
 * and above all no stamp — a capped ticket must never be touched before it is refused (see this
 * file's header). The caller compares them against its own resolved settings; `settings` rides
 * along so the pre-claim call site passes exactly the object it will hand `gateAndRecordRun`, and
 * `orgId` because RLS, not a WHERE clause, is what scopes these reads.
 */
export async function readCapsUnlocked(
  tx: OrgTx,
  p: { orgId: string; ticketId: string; settings: Partial<Record<SettingKey, unknown>>; now: Date },
): Promise<{ ticketRunsToday: number; orgCostMicrosToday: number; orgDraftsToday: number }> {
  const day = utcDayString(p.now)
  return {
    ticketRunsToday: await draftRunsForTicketToday(tx, p.ticketId, utcMidnight(p.now)),
    orgCostMicrosToday: await meterValue(tx, day, 'llm_cost_micros'),
    orgDraftsToday: await meterValue(tx, day, DRAFT_METER),
  }
}
