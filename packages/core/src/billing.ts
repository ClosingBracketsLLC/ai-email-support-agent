import { BILLING_PRICING, type BillingState, type BillingStatus, type OverageMode, type PlanId } from '@aesa/contracts'

/** The subset of a `billing_subscriptions` row the pure billing maths needs. */
export interface BillingRowLike {
  plan: PlanId
  status: BillingStatus
  trialEndsAt: Date | null
  currentPeriodStart: Date | null
  currentPeriodEnd: Date | null
  domainQuantity: number
  includedConversationsPerDomain: number
  overageMode: OverageMode
}

/** The status plus the derived trial expiry — the ONE place `trialing` past `trialEndsAt` reads as
 *  `trial_expired` without ever being written back; `trial_expired` is never stored (spec's trial
 *  policy: no card required, the clock alone decides). Every other status passes through unchanged
 *  regardless of `trialEndsAt`. */
export function billingStateOf(row: BillingRowLike, now: Date): BillingState {
  if (row.status === 'trialing' && row.trialEndsAt !== null && row.trialEndsAt <= now) return 'trial_expired'
  return row.status
}

export const isBillingActive = (state: BillingState): boolean => state === 'trialing' || state === 'active'

/** trial → `BILLING_PRICING.trialIncludedConversations`, a flat PER-WORKSPACE constant (plan
 *  deviation 5) — NOT `row.includedConversationsPerDomain`, which on a trial row is simply what the
 *  workspace will get once it subscribes (the column default, 300) and must never be read here;
 *  standard → `includedConversationsPerDomain` × max(1, domains), so a workspace with zero connected
 *  domains still gets one domain's worth. (Controller ruling R6: a row-backed trial and a missing
 *  trial row must read the identical allowance — the field only ever applies to the standard plan.) */
export function allowanceOf(row: BillingRowLike): number {
  if (row.plan === 'trial') return BILLING_PRICING.trialIncludedConversations
  return row.includedConversationsPerDomain * Math.max(1, row.domainQuantity)
}

/** The Stripe period when the row has one; otherwise the UTC calendar month containing `now` (a
 *  trial, or a standard row before its first Stripe period lands). */
export function periodOf(row: BillingRowLike, now: Date): { start: Date; end: Date } {
  if (row.currentPeriodStart !== null && row.currentPeriodEnd !== null) {
    return { start: row.currentPeriodStart, end: row.currentPeriodEnd }
  }
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
  return { start, end }
}

export const overageOf = (used: number, allowance: number): number => Math.max(0, used - allowance)

/** Managed AI only (BYOK never blocks — it is the tenant's own spend); a trial hard-stops at the
 *  allowance regardless of overage mode, while a standard workspace stops only in `blocked` mode
 *  (`automatic` lets metered overage accrue instead). */
export function isAllowanceExhausted(p: { mode: 'managed' | 'byok'; plan: PlanId; overageMode: OverageMode; used: number; allowance: number }): boolean {
  return p.mode === 'managed' && p.used >= p.allowance && (p.plan === 'trial' || p.overageMode === 'blocked')
}

/** The trial clock's one formula: `agent_enabled_at` + `BILLING_PRICING.trialDays`. */
export function trialEndsAtFor(agentEnabledAt: Date): Date {
  return new Date(agentEnabledAt.getTime() + BILLING_PRICING.trialDays * 86_400_000)
}

/**
 * `tickets.ai_handled_month`'s value for a billing period: the period START's UTC date
 * (`'YYYY-MM-DD'`). The conversation meters count a ticket at most once per BILLING PERIOD — the
 * Stripe anniversary period on a paid plan, the calendar month on a trial (`periodOf`) — so the
 * dedupe stamp must be keyed on the same period the allowance and the overage are counted over
 * (ruling R26). Before the Phase 7 fix wave the stamp was the calendar month (`'YYYY-MM'`), which
 * billed a thread replied on Jan 31 and Feb 1 inside a Jan 15–Feb 15 period as two conversations.
 */
export function handledPeriodStamp(periodStart: Date): string {
  return periodStart.toISOString().slice(0, 10)
}

/**
 * Every stored value that means "already counted in this period": the period stamp itself and, for
 * a period that starts on the 1st, the legacy seven-character calendar-month form it replaced — so
 * a ticket already stamped `'2026-09'` when the wave deploys is not counted a second time by a
 * September send that now writes `'2026-09-01'`. The compatibility shim is deliberately narrow: a
 * mid-month period start has no legacy equivalent.
 */
export function handledPeriodStamps(periodStart: Date): string[] {
  const stamp = handledPeriodStamp(periodStart)
  return stamp.endsWith('-01') ? [stamp, stamp.slice(0, 7)] : [stamp]
}

/** Whether a ticket's stored stamp already counts it in the period starting at `periodStart`. */
export function isHandledInPeriod(stored: string | null, periodStart: Date): boolean {
  return stored !== null && handledPeriodStamps(periodStart).includes(stored)
}
