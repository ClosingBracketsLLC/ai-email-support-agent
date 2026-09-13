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

/** trial → the flat trial allowance (`row.includedConversationsPerDomain` is a flat PER-WORKSPACE
 *  number on the trial plan, not a per-domain rate — plan deviation 5 — so domain count never enters
 *  it); standard → `includedConversationsPerDomain` × max(1, domains), so a workspace with zero
 *  connected domains still gets one domain's worth. */
export function allowanceOf(row: BillingRowLike): number {
  if (row.plan === 'trial') return row.includedConversationsPerDomain
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
