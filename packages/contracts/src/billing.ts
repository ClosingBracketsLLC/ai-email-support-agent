import { z } from 'zod'

export const PLAN_IDS = ['trial', 'standard'] as const
export type PlanId = (typeof PLAN_IDS)[number]

/** The stored Stripe-driven status. `trial_expired` is DERIVED (see BILLING_STATES), never stored. */
export const BILLING_STATUSES = ['trialing', 'active', 'past_due', 'canceled'] as const
export type BillingStatus = (typeof BILLING_STATUSES)[number]

/** What the owner sees and what decide() keys off: the status plus the derived trial expiry. */
export const BILLING_STATES = ['trialing', 'trial_expired', 'active', 'past_due', 'canceled'] as const
export type BillingState = (typeof BILLING_STATES)[number]

export const OVERAGE_MODES = ['automatic', 'blocked'] as const
export type OverageMode = (typeof OVERAGE_MODES)[number]

/** The numbers the product renders and the plan tiers reference — ONE source (spec §Usage / pricing; defaults to validate). */
export const BILLING_PRICING = {
  perDomainCents: 4999,
  includedPerDomain: 300,
  overageUnitCents: 12,
  trialDays: 14,
  /** Flat per trial, not per domain (plan deviation 5). */
  trialIncludedConversations: 50,
  /** Total Managed-AI spend a trial may cost the platform, USD (spec §Budgets "trial budget"). */
  trialLlmUsdBudget: 10,
} as const

export interface BillingView {
  plan: PlanId
  state: BillingState
  trialEndsAt: Date | null
  domainQuantity: number
  allowance: number
  used: number
  overageUnits: number
  periodStart: Date
  periodEnd: Date
  overageMode: OverageMode
  overageUnitCents: number
  perDomainCents: number
  hasStripeCustomer: boolean
  hasSubscription: boolean
  cancelAtPeriodEnd: boolean
  /** The api has STRIPE_* configured; false in dev without keys — the screen hides Subscribe. */
  configured: boolean
}

export const SetOverageModeInput = z.object({ mode: z.enum(OVERAGE_MODES) })
export type SetOverageModeInput = z.infer<typeof SetOverageModeInput>

export const BILLING_ERROR_MESSAGES = {
  not_configured: 'Billing is not set up on this server yet.',
  no_customer: 'Subscribe first, then manage billing.',
  already_subscribed: 'This workspace already has a subscription — use Manage billing.',
  /** A Checkout completed but its payment has not settled (ruling R10's deferred state): the row
   *  holds a subscription id on the trial plan, and a second Checkout would be a second subscription. */
  checkout_pending: 'Stripe is still confirming your payment. Check back in a few minutes.',
  stripe_unavailable: 'Stripe did not answer. Try again in a minute.',
  connection_limit: 'Your plan allows no more mailbox connections. Upgrade or disconnect one.',
} as const
export type BillingErrorKey = keyof typeof BILLING_ERROR_MESSAGES
