/**
 * `readBillingState` is the ONE reader of a workspace's billing lifecycle — the api's billing router,
 * the caps a draft run checks, and the worker's usage rollups all resolve through it, so no two
 * surfaces can disagree about what plan a workspace is on or whether it may still send. The maths
 * themselves (`billingStateOf`, `allowanceOf`, `periodOf`, `isBillingActive`) live in `@aesa/core`,
 * which this package now depends on at runtime (core depends only on contracts + zod, so there is no
 * cycle) — this module is the ONLY place that reads the `billing_subscriptions` row those functions
 * need.
 */
import { and, countDistinct, eq } from 'drizzle-orm'
import {
  BILLING_PRICING, type BillingState, type BillingStatus, type OverageMode, type PlanId,
} from '@aesa/contracts'
import { allowanceOf, billingStateOf, isBillingActive, periodOf, type BillingRowLike } from '@aesa/core'
import { SEND_METERS, sumMeter } from './metering.ts'
import { agents, billingSubscriptions, workspaces } from './schema/index.ts'
import type { OrgTx } from './tenant.ts'

export interface BillingStateRow extends BillingRowLike {
  orgId: string
  stripeCustomerId: string | null
  stripeSubscriptionId: string | null
  stripeDomainItemId: string | null
  stripeOverageItemId: string | null
  overageUnitCents: number
  overageReported: number
  overageReportedPeriodStart: Date | null
  cancelAtPeriodEnd: boolean
  lastStripeEventCreated: number | null
}

export interface BillingStateView extends BillingStateRow {
  state: BillingState
  active: boolean
  allowance: number
  period: { start: Date; end: Date }
  /** True when the org has no `billing_subscriptions` row at all — a workspace that never ran
   *  `ensureBillingRow` (or predates it) reads as a fresh trial rather than throwing. */
  missingRow: boolean
  /** `workspaces.agent_enabled_at` — the trial clock's ORIGIN (`trial_ends_at` is
   *  `trialEndsAtFor(agent_enabled_at)`, one formula), and the day the trial's Managed-AI budget
   *  is summed from (ruling R27). Null until the agent is first switched on, or when the org has
   *  no workspace row. */
  agentEnabledAt: Date | null
}

/** A workspace with no row yet has never had `ensureBillingRow` run for it — every field here
 *  matches that insert's column defaults exactly, so a missing row and a freshly-inserted one are
 *  indistinguishable to every reader. `includedConversationsPerDomain` is `BILLING_PRICING.includedPerDomain`
 *  (the STANDARD per-domain rate, matching the column default) — NOT the trial allowance:
 *  `allowanceOf` (`@aesa/core`) ignores this field entirely on `plan: 'trial'` and returns the flat
 *  `BILLING_PRICING.trialIncludedConversations` constant instead (controller ruling R6). */
function defaultRow(orgId: string): BillingStateRow {
  return {
    orgId,
    plan: 'trial',
    status: 'trialing',
    trialEndsAt: null,
    currentPeriodStart: null,
    currentPeriodEnd: null,
    domainQuantity: 0,
    includedConversationsPerDomain: BILLING_PRICING.includedPerDomain,
    overageMode: 'automatic',
    overageUnitCents: BILLING_PRICING.overageUnitCents,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    stripeDomainItemId: null,
    stripeOverageItemId: null,
    overageReported: 0,
    overageReportedPeriodStart: null,
    cancelAtPeriodEnd: false,
    lastStripeEventCreated: null,
  }
}

/** The ONE reader. A workspace with no row reads as a fresh trial (`missingRow: true`) — never throws. */
export async function readBillingState(tx: OrgTx, now: Date): Promise<BillingStateView> {
  const [found] = await tx.select().from(billingSubscriptions).where(eq(billingSubscriptions.orgId, tx.orgId))
  const row: BillingStateRow = found
    ? {
        orgId: found.orgId,
        plan: found.plan as PlanId,
        status: found.status as BillingStatus,
        trialEndsAt: found.trialEndsAt,
        currentPeriodStart: found.currentPeriodStart,
        currentPeriodEnd: found.currentPeriodEnd,
        domainQuantity: found.domainQuantity,
        includedConversationsPerDomain: found.includedConversationsPerDomain,
        overageMode: found.overageMode as OverageMode,
        overageUnitCents: found.overageUnitCents,
        stripeCustomerId: found.stripeCustomerId,
        stripeSubscriptionId: found.stripeSubscriptionId,
        stripeDomainItemId: found.stripeDomainItemId,
        stripeOverageItemId: found.stripeOverageItemId,
        overageReported: found.overageReported,
        overageReportedPeriodStart: found.overageReportedPeriodStart,
        cancelAtPeriodEnd: found.cancelAtPeriodEnd,
        lastStripeEventCreated: found.lastStripeEventCreated,
      }
    : defaultRow(tx.orgId)
  const [ws] = await tx.select({ agentEnabledAt: workspaces.agentEnabledAt }).from(workspaces).where(eq(workspaces.orgId, tx.orgId))
  const state = billingStateOf(row, now)
  return {
    ...row,
    state,
    active: isBillingActive(state),
    allowance: allowanceOf(row),
    period: periodOf(row, now),
    missingRow: !found,
    agentEnabledAt: ws?.agentEnabledAt ?? null,
  }
}

/** Seeds the org's trial row on first touch; a no-op once it exists. */
export async function ensureBillingRow(tx: OrgTx): Promise<void> {
  await tx.insert(billingSubscriptions).values({ orgId: tx.orgId }).onConflictDoNothing()
}

/** `sum(usage_counters.value)` for `SEND_METERS.aiHandledManaged` over the period's UTC days. */
export async function countManagedConversations(tx: OrgTx, period: { start: Date; end: Date }): Promise<number> {
  const fromDay = period.start.toISOString().slice(0, 10)
  const toDayExclusive = period.end.toISOString().slice(0, 10)
  return sumMeter(tx, SEND_METERS.aiHandledManaged, fromDay, toDayExclusive)
}

/** `count(DISTINCT domain) FROM agents WHERE status = 'active'` — the same predicate `mailboxes.addAddress` caps on. */
export async function countActiveDomains(tx: OrgTx): Promise<number> {
  const [row] = await tx
    .select({ value: countDistinct(agents.domain) })
    .from(agents)
    .where(and(eq(agents.orgId, tx.orgId), eq(agents.status, 'active')))
  return row?.value ?? 0
}
