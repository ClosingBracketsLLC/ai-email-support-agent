/**
 * `billing.report-usage` (spec §Queue and job model; plan deviations 3, 4 and 7): the nightly pass
 * that turns a workspace's MANAGED-AI usage into money — the overage delta as a Stripe Billing Meter
 * event, the licensed per-domain quantity kept in step, and the local trial/allowance pages that
 * need no Stripe at all.
 *
 * **THREE PHASES PER ORG, because a meter event is network I/O.** A `withOrg`/`withPlatform`
 * transaction never spans a network call (CLAUDE.md), so the pass is `collect → act → record`:
 *
 *   1. **collect** — ONE `withPlatform` transaction: the org list, then a per-org SAVEPOINT lent that
 *      org's identity (`withOrgIdentity`, the `stats.rollup` idiom) reading `readBillingState`,
 *      `countManagedConversations` and `countActiveDomains` and computing what, if anything, to do.
 *      Pure reads; the transaction commits before anything leaves this process.
 *   2. **act** — the Stripe calls, OUTSIDE every transaction. A failure here is an alert and a
 *      dropped action for this org, never a throw: tomorrow's pass recomputes the same delta from
 *      the same watermark.
 *   3. **record** — one `withOrg` per org: the GUARDED writes (each on the exact value phase 1 read),
 *      the audit rows and the notices; then, after that transaction commits, the push enqueues.
 *
 * The write order matters in exactly one way: a row is written only AFTER the call it describes
 * succeeded. `overage_reported` is the watermark that stops a delta being reported twice, so a row
 * updated ahead of a failed meter event would silently lose that overage forever.
 *
 * Every read inside phase 1's SAVEPOINT carries an explicit `orgId` predicate — `withOrgIdentity`
 * does NOT set `app.org_id` or switch role, so nothing here may lean on RLS (see `stats-rollup.ts`).
 */
import { asc, sql } from 'drizzle-orm'
import type PgBoss from 'pg-boss'
import type pino from 'pino'
import type { OverageMode, PlanId } from '@aesa/contracts'
import { overageOf } from '@aesa/core'
import {
  audit, billingSubscriptions, countActiveDomains, countManagedConversations, notifications,
  readBillingState, withOrg, withOrgIdentity, withPlatform, type AuditActor, type Db,
} from '@aesa/db'
import { registerCron } from '@aesa/queue'
import { utcDayString } from '../date-utils.ts'
import { errorMessage } from '../err-message.ts'
import type { StripeUsagePort } from './stripe.ts'

/** Bound on how many workspaces one nightly pass visits — the `stats.rollup` bound, same reasoning. */
export const REPORT_ORGS_PER_RUN = 500

/** How close to `trial_ends_at` the "your trial is ending" page starts appearing. */
export const TRIAL_ENDING_NOTICE_DAYS = 3

const REPORT_ACTOR: AuditActor = 'system:cron:billing.report-usage'

export interface ReportUsageDeps {
  db: Db
  logger: pino.Logger
  /** Null when `STRIPE_SECRET_KEY` is unset: the local half still runs and every org that needed a
   *  Stripe call is counted `skipped`. Required in production on a `cron` replica (`loadConfig`). */
  stripe: StripeUsagePort | null
  /** index.ts wires this to `enqueueNotifyDispatch`. */
  enqueueNotify: (orgId: string, notificationId: string) => Promise<void>
  now?: () => Date
}

export interface ReportUsageResult {
  orgs: number
  /** Meter events successfully created. */
  reported: number
  /** Subscriptions whose licensed quantity was successfully updated. */
  quantitySynced: number
  /** `billing` notifications inserted (trial ending, trial ended, allowance reached). */
  trialNotices: number
  /** Orgs that needed a Stripe call this pass and could not make one (no port configured). */
  skipped: number
}

/** What one org's overage needs, as phase 1 computed it. */
interface OveragePlan {
  customerId: string
  /** The units to report NOW — the total minus whatever this period already reported. Always > 0. */
  delta: number
  /** The period's running total; it becomes `overage_reported` and rides the identifier. */
  total: number
  identifier: string
  /** The audit detail's two other numbers. */
  used: number
  allowance: number
  /** The exact values phase 3's guarded write must still find. */
  fromReported: number
  fromPeriodStart: Date | null
  periodStart: Date
}

/** What one org's licensed quantity needs. */
interface QuantityPlan {
  subscriptionId: string
  itemId: string
  quantity: number
  /** The stored value phase 3's guarded write must still find. */
  from: number
}

/** One page to insert in phase 3. `dedupeKey` is what makes each of the three "once" rules hold. */
interface NoticePlan {
  dedupeKey: string
  title: string
  body: string
}

interface OrgPlan {
  orgId: string
  overage: OveragePlan | null
  quantity: QuantityPlan | null
  notices: NoticePlan[]
  /** Set by phase 2 once the meter event landed; only then may phase 3 move the watermark. */
  overageDone: boolean
  quantityDone: boolean
}

/** Phase 1's per-org read. Pure: no writes, no network, and every query explicitly org-scoped. */
async function planForOrg(
  tx: Parameters<typeof withOrgIdentity>[0], orgId: string, now: Date,
): Promise<OrgPlan> {
  const org = withOrgIdentity(tx, orgId)
  const billing = await readBillingState(org, now)
  const used = await countManagedConversations(org, billing.period)
  const activeDomains = await countActiveDomains(org)

  return {
    orgId,
    overage: planOverage(orgId, billing, used),
    quantity: planQuantity(billing, activeDomains),
    notices: planNotices(orgId, billing, used, now),
    overageDone: false,
    quantityDone: false,
  }
}

/** The subset of `readBillingState`'s view this file's pure planners read. */
type BillingFacts = Awaited<ReturnType<typeof readBillingState>>

/**
 * Deviation 3. ONLY overage units are reported, and only the DELTA since this period's last report.
 * Three things must all hold for a workspace to be billed at all: a paid plan, `automatic` overage
 * (a `blocked` workspace stops sending instead of accruing) and a Stripe customer to bill.
 *
 * The watermark is period-scoped: `overage_reported` only counts when `overage_reported_period_start`
 * IS the current period, so a new period starts from zero without any reset write of its own.
 */
function planOverage(orgId: string, billing: BillingFacts, used: number): OveragePlan | null {
  const plan: PlanId = billing.plan
  const mode: OverageMode = billing.overageMode
  if (plan === 'trial' || mode !== 'automatic' || billing.stripeCustomerId === null) return null

  const total = overageOf(used, billing.allowance)
  const samePeriod = billing.overageReportedPeriodStart !== null
    && billing.overageReportedPeriodStart.getTime() === billing.period.start.getTime()
  const alreadyReported = samePeriod ? billing.overageReported : 0
  const delta = total - alreadyReported
  if (delta <= 0) return null

  const periodStartIso = billing.period.start.toISOString()
  return {
    customerId: billing.stripeCustomerId,
    delta,
    total,
    // Stripe enforces uniqueness on this for at least 24 hours, so a retry of the SAME total is
    // swallowed on their side while the guarded write below is what makes it idempotent on ours.
    identifier: `${orgId}:${periodStartIso}:${total}`,
    used,
    allowance: billing.allowance,
    fromReported: billing.overageReported,
    fromPeriodStart: billing.overageReportedPeriodStart,
    periodStart: billing.period.start,
  }
}

/** Deviation 4: the licensed item's quantity is synced DAILY, not on every agent add or remove. */
function planQuantity(billing: BillingFacts, activeDomains: number): QuantityPlan | null {
  if (billing.stripeSubscriptionId === null || billing.stripeDomainItemId === null) return null
  if (activeDomains === billing.domainQuantity) return null
  return {
    subscriptionId: billing.stripeSubscriptionId,
    itemId: billing.stripeDomainItemId,
    quantity: activeDomains,
    from: billing.domainQuantity,
  }
}

/** The three local pages. None of them needs Stripe, so all three run on an unconfigured deployment. */
function planNotices(orgId: string, billing: BillingFacts, used: number, now: Date): NoticePlan[] {
  const out: NoticePlan[] = []
  const day = utcDayString(now)

  if (billing.state === 'trialing' && billing.trialEndsAt !== null) {
    const daysLeft = Math.ceil((billing.trialEndsAt.getTime() - now.getTime()) / 86_400_000)
    if (daysLeft > 0 && daysLeft <= TRIAL_ENDING_NOTICE_DAYS) {
      // Per DAY, on purpose: the last few days of a trial are exactly when a daily nudge is wanted.
      out.push({
        dedupeKey: `billing:trial_ending:${orgId}:${day}`,
        title: daysLeft === 1 ? 'Your trial ends tomorrow' : `Your trial ends in ${daysLeft} days`,
        body: 'Subscribe to keep the agent drafting and sending after the trial.',
      })
    }
  }

  // `trial_expired` is DERIVED, never stored (`billingStateOf`), so this fires from the moment the
  // clock passes `trial_ends_at`. ONE page ever — the trial only ends once.
  if (billing.state === 'trial_expired') {
    out.push({
      dedupeKey: `billing:trial_ended:${orgId}`,
      title: 'Your trial has ended',
      body: 'The agent keeps drafting, but nothing sends automatically until you subscribe.',
    })
  }

  // Once per PERIOD: the counter resets with the period, and so should the page.
  if (billing.overageMode === 'blocked' && used >= billing.allowance) {
    out.push({
      dedupeKey: `billing:allowance:${orgId}:${billing.period.start.toISOString()}`,
      title: 'Included conversations used up',
      body: `This workspace has used all ${billing.allowance} included conversations this period. Autopilot is paused until the next period or you allow overage.`,
    })
  }

  return out
}

/** Phase 3: the guarded writes, the audit rows and the notices — ONE transaction per org. */
async function recordForOrg(deps: ReportUsageDeps, plan: OrgPlan): Promise<string[]> {
  return withOrg(deps.db, plan.orgId, async (tx) => {
    const pending: string[] = []

    if (plan.overageDone && plan.overage) {
      const o = plan.overage
      // Guarded on BOTH watermark columns exactly as phase 1 read them: a concurrent pass (or a
      // webhook that moved the period) loses, and its own next run recomputes from what it finds.
      const rows = await tx
        .update(billingSubscriptions)
        .set({ overageReported: o.total, overageReportedPeriodStart: o.periodStart })
        .where(sql`${billingSubscriptions.orgId} = ${plan.orgId}
          AND ${billingSubscriptions.overageReported} = ${o.fromReported}
          AND ${billingSubscriptions.overageReportedPeriodStart} IS NOT DISTINCT FROM ${o.fromPeriodStart}`)
        .returning({ orgId: billingSubscriptions.orgId })
      if (rows.length > 0) {
        await audit(tx, {
          actor: REPORT_ACTOR, action: 'billing.overage_reported', entityType: 'billing_subscription', entityId: plan.orgId,
          detail: { used: o.used, allowance: o.allowance, delta: o.delta, total: o.total, identifier: o.identifier },
        })
      } else {
        deps.logger.warn({ orgId: plan.orgId }, 'billing.report-usage: the overage watermark moved under us; leaving it')
      }
    }

    if (plan.quantityDone && plan.quantity) {
      const q = plan.quantity
      const rows = await tx
        .update(billingSubscriptions)
        .set({ domainQuantity: q.quantity })
        .where(sql`${billingSubscriptions.orgId} = ${plan.orgId} AND ${billingSubscriptions.domainQuantity} = ${q.from}`)
        .returning({ orgId: billingSubscriptions.orgId })
      if (rows.length > 0) {
        await audit(tx, {
          actor: REPORT_ACTOR, action: 'billing.domain_quantity_synced', entityType: 'billing_subscription', entityId: plan.orgId,
          detail: { from: q.from, to: q.quantity },
        })
      }
    }

    for (const notice of plan.notices) {
      const [row] = await tx
        .insert(notifications)
        .values({ orgId: plan.orgId, kind: 'billing', title: notice.title, body: notice.body, dedupeKey: notice.dedupeKey, payload: {} })
        .onConflictDoNothing({ target: notifications.dedupeKey })
        .returning({ id: notifications.id })
      if (row) pending.push(row.id)
    }

    return pending
  })
}

export async function runBillingReportUsage(deps: ReportUsageDeps): Promise<ReportUsageResult> {
  const now = deps.now?.() ?? new Date()
  const result: ReportUsageResult = { orgs: 0, reported: 0, quantitySynced: 0, trialNotices: 0, skipped: 0 }

  // --- Phase 1: collect. ONE platform transaction, pure reads, committed before any network call.
  const plans: OrgPlan[] = []
  await withPlatform(deps.db, 'cron:billing.report-usage', async (tx) => {
    const orgRows = await tx
      .selectDistinct({ orgId: billingSubscriptions.orgId })
      .from(billingSubscriptions)
      .orderBy(asc(billingSubscriptions.orgId))
      .limit(REPORT_ORGS_PER_RUN)

    for (const { orgId } of orgRows) {
      try {
        // One SAVEPOINT per org, exactly like `stats.rollup`: a defensive throw inside one org's
        // reads rolls that org back and leaves the pass running for everyone else.
        plans.push(await tx.transaction((tx2) => planForOrg(tx2, orgId, now)))
      } catch (err) {
        deps.logger.warn({ orgId, error: errorMessage(err) }, 'billing_report_usage_org_read_failed')
      }
    }
  })
  result.orgs = plans.length

  // --- Phase 2: act. Stripe, outside every transaction. A failure is an alert and a dropped action.
  let warnedUnconfigured = false
  for (const plan of plans) {
    const needsStripe = plan.overage !== null || plan.quantity !== null
    if (!needsStripe) continue
    if (!deps.stripe) {
      result.skipped += 1
      if (!warnedUnconfigured) {
        warnedUnconfigured = true
        deps.logger.warn(
          { reason: 'stripe_not_configured' },
          'billing.report-usage: STRIPE_SECRET_KEY is unset; overage and quantity are not reported on this replica',
        )
      }
      continue
    }
    if (plan.overage) {
      try {
        await deps.stripe.reportOverage({
          customerId: plan.overage.customerId, value: plan.overage.delta, identifier: plan.overage.identifier,
        })
        plan.overageDone = true
        result.reported += 1
      } catch (err) {
        // Task 11 replaces this with `alert('stripe_report_failed', { orgId })`.
        deps.logger.error(
          { alert: true, kind: 'stripe_report_failed', orgId: plan.orgId, op: 'reportOverage', error: errorMessage(err) },
          'billing.report-usage: reporting overage to Stripe failed; the watermark is left where it was',
        )
      }
    }
    if (plan.quantity) {
      try {
        await deps.stripe.setDomainQuantity({
          subscriptionId: plan.quantity.subscriptionId, itemId: plan.quantity.itemId, quantity: plan.quantity.quantity,
        })
        plan.quantityDone = true
        result.quantitySynced += 1
      } catch (err) {
        deps.logger.error(
          { alert: true, kind: 'stripe_report_failed', orgId: plan.orgId, op: 'setDomainQuantity', error: errorMessage(err) },
          'billing.report-usage: syncing the licensed domain quantity to Stripe failed',
        )
      }
    }
  }

  // --- Phase 3: record. One transaction per org, then the pushes AFTER it commits.
  for (const plan of plans) {
    if (!plan.overageDone && !plan.quantityDone && plan.notices.length === 0) continue
    let pending: string[] = []
    try {
      pending = await recordForOrg(deps, plan)
    } catch (err) {
      deps.logger.warn({ orgId: plan.orgId, error: errorMessage(err) }, 'billing_report_usage_org_write_failed')
      continue
    }
    result.trialNotices += pending.length
    for (const notificationId of pending) {
      try {
        await deps.enqueueNotify(plan.orgId, notificationId)
      } catch (err) {
        deps.logger.warn({ orgId: plan.orgId, notificationId, error: errorMessage(err) }, 'billing_report_usage_notify_enqueue_failed')
      }
    }
  }

  return result
}

export async function registerBillingReportUsage(boss: PgBoss, deps: ReportUsageDeps): Promise<void> {
  await registerCron(
    boss,
    'billing.report-usage',
    // 00:20 UTC: after midnight (so a period that rolled over is already the new one everywhere) and
    // clear of `sweeps.daily` and `stats.rollup`.
    '20 0 * * *',
    async () => {
      const result = await runBillingReportUsage(deps)
      deps.logger.info(result, 'billing.report-usage complete')
    },
    { policy: 'singleton', singletonKey: 'billing.report-usage', retryLimit: 0, expireInSeconds: 1800 },
  )
}
