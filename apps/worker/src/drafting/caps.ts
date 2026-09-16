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
import { INVARIANTS, PLANS, resolveSetting } from '@aesa/core'
import { agentRuns, LLM_METERS, sumMeter, usageCounters, type BillingStateView, type OrgTx, type SettingSources } from '@aesa/db'
import { utcDayString } from '../date-utils.ts'

/** The `usage_counters` meter the org-wide daily draft cap is measured against. */
export const DRAFT_METER = 'draft_runs'
/** How many draft runs one org may have in flight at once. A fairness bound, not a cap: refused runs come back. */
export const PER_ORG_DRAFT_CONCURRENCY = 2

/** WHICH budget an `org_spend_capped` refusal spent: the org's DAILY USD cap, or — on a trial
 *  workspace only — the plan's TOTAL Managed-AI budget over the whole trial. The owner-facing page
 *  differs ("starts again after midnight UTC" vs "subscribe to keep drafting"), so the caller needs
 *  to know which one it met. */
export type SpendCapScope = 'daily' | 'trial'

export type GateOutcome =
  | { outcome: 'proceed'; runId: string }
  | { outcome: 'ticket_capped'; runsToday: number }
  | { outcome: 'org_busy' }
  | { outcome: 'org_draft_capped' }
  | { outcome: 'org_spend_capped'; scope: SpendCapScope; costMicros: number }

/** `sumMeter`'s inclusive lower bound when the trial has no clock of its own yet (the agent was
 *  never switched on — a sandbox probe can still spend): "since this workspace began". A literal
 *  rather than the org's creation date: `usage_counters` rows only exist from the first metered
 *  call onward, so any earlier day is the same sum. */
const TRIAL_BUDGET_EPOCH_DAY = '1970-01-01'

/**
 * Ruling R27: the trial's total Managed-AI budget applies ONLY to a genuine, unexpired trial — the
 * derived billing STATE, never the plan. A cancelled workspace is back on `plan = 'trial'` (plan
 * deviation 8) and an expired trial keeps its `trialing` row, but both are already review-only
 * through `subscription_inactive` and bounded by the daily cap; summing a paying workspace's
 * whole history against $10 the day it cancelled stopped its drafting outright, against the
 * spec's "drafts continue".
 */
export const trialBudgetApplies = (billing: Pick<BillingStateView, 'state'>): boolean => billing.state === 'trialing'

/** The day the trial budget is summed FROM (ruling R27): the trial's own clock —
 *  `workspaces.agent_enabled_at` — so spend that predates the trial (the sandbox, an earlier
 *  enable on a workspace 0025 later re-clocked) is not the trial's; the epoch only when null. */
export function trialBudgetFromDay(billing: Pick<BillingStateView, 'agentEnabledAt'>): string {
  return billing.agentEnabledAt ? utcDayString(billing.agentEnabledAt) : TRIAL_BUDGET_EPOCH_DAY
}

/** Start of `d`'s UTC day — the boundary every daily count here is measured from. */
export function utcMidnight(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
}

/** A USD cap as `usage_counters.llm_cost_micros` counts it. Exported because `ticket.draft`'s
 *  pre-claim check compares the same two numbers and used to carry its own copy of this line. */
export const usdCapToMicros = (usd: number): number => Math.round(usd * 1_000_000)

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
  /** The org's own `org_settings` rows AND its PLAN's defaults (`loadSettingSources`, `@aesa/db`) —
   *  a trial workspace's caps are the trial tier's unless an owner overrode them. Its `billing`
   *  view (the derived state and the trial clock) is what decides whether branch 4b's total trial
   *  budget applies at all, and from which day it is summed. */
  settings: SettingSources
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
 *   4. usage_counters llm_cost_micros ≥ autonomy.daily_llm_usd_cap × 1e6 → org_spend_capped/daily
 *  4b. a genuine trial only (`trialBudgetApplies`): the SAME meter summed from the trial's own
 *      clock (`trialBudgetFromDay`) ≥ PLANS.trial.llmUsdBudget × 1e6 → org_spend_capped/trial
 *   5. otherwise: insert the `agent_runs` row (status `running`) and bump `draft_runs`.
 *
 * Step 4 and step 4b both read `LLM_METERS.costMicros` and never `costMicrosByok`: the daily cap and
 * the trial budget are the PLATFORM's money (CLAUDE.md Metering), and a tenant's own BYOK spend must
 * never trip either of them.
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
  if (draftsToday >= resolveSetting('autonomy.daily_draft_cap', p.settings)) return { outcome: 'org_draft_capped' }

  const costMicrosToday = await meterValue(tx, day, LLM_METERS.costMicros)
  if (costMicrosToday >= usdCapToMicros(resolveSetting('autonomy.daily_llm_usd_cap', p.settings))) {
    return { outcome: 'org_spend_capped', scope: 'daily', costMicros: costMicrosToday }
  }

  // 4b, Phase 7: the trial's TOTAL Managed-AI budget (spec §Budgets) — a second, cumulative ceiling
  // that only a genuine, unexpired trial has (ruling R27). Evaluated AFTER the daily cap so a
  // workspace that is over both reports the one that resets on its own, and skipped entirely on a
  // paid plan (`llmUsdBudget: null`), an expired trial and a cancelled workspace.
  if (trialBudgetApplies(p.settings.billing)) {
    const budget = PLANS.trial.llmUsdBudget
    const total = await sumMeter(tx, LLM_METERS.costMicros, trialBudgetFromDay(p.settings.billing))
    if (total >= usdCapToMicros(budget)) return { outcome: 'org_spend_capped', scope: 'trial', costMicros: total }
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
  p: { orgId: string; ticketId: string; settings: SettingSources; now: Date },
): Promise<UnlockedCaps> {
  const day = utcDayString(p.now)
  return {
    ticketRunsToday: await draftRunsForTicketToday(tx, p.ticketId, utcMidnight(p.now)),
    orgCostMicrosToday: await meterValue(tx, day, LLM_METERS.costMicros),
    orgDraftsToday: await meterValue(tx, day, DRAFT_METER),
    // Read for EVERY state, not only a live trial: this is the unlocked mirror of branch 4b, and a
    // caller comparing it against a budget its own billing state says does not apply is the
    // caller's business. One indexed aggregate over one org's counters — the same table the two
    // reads above touch — from the same day the locked gate sums from.
    orgTrialCostMicros: await sumMeter(tx, LLM_METERS.costMicros, trialBudgetFromDay(p.settings.billing)),
  }
}

/** What the pre-claim read hands `ticket.draft`'s own cap checks — one field per locked-gate branch. */
export interface UnlockedCaps {
  ticketRunsToday: number
  orgCostMicrosToday: number
  orgDraftsToday: number
  /** `llm_cost_micros` summed from the trial's own clock (`trialBudgetFromDay`) — branch 4b's input. */
  orgTrialCostMicros: number
}
