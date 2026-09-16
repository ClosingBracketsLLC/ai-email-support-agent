import { sql } from 'drizzle-orm'
import { bigint, boolean, check, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { BILLING_PRICING } from '@aesa/contracts'
import { createdAt, tenantPolicies, updatedAt } from './helpers.ts'

/**
 * One row per workspace (deviation 1) — Stripe's subscription lifecycle plus the platform's own
 * trial clock and overage-reporting watermark. `org_id` IS the primary key AND the RLS column: a
 * workspace has at most one subscription, so there is no separate id to key retrieval on, and no
 * separate index is needed for the tenant-scoped read (the primary key already serves it).
 */
export const billingSubscriptions = pgTable('billing_subscriptions', {
  orgId: uuid('org_id').primaryKey(),
  plan: text('plan').notNull().default('trial'),                       // PlanId (CHECK)
  status: text('status').notNull().default('trialing'),                // BillingStatus (CHECK)
  stripeCustomerId: text('stripe_customer_id'),                        // UNIQUE (partial, 0023) — the webhook's lookup key
  stripeSubscriptionId: text('stripe_subscription_id'),                // UNIQUE (partial, 0023)
  stripeDomainItemId: text('stripe_domain_item_id'),                   // the licensed item whose quantity is the domain count
  stripeOverageItemId: text('stripe_overage_item_id'),
  domainQuantity: integer('domain_quantity').notNull().default(0),
  // The two price-table defaults come from `BILLING_PRICING` (the ONE source, `@aesa/contracts`) so
  // they cannot drift from what `allowanceOf` and the api quote. drizzle-kit inlines the value, so a
  // change there becomes a generated migration `db:check` pins rather than a silent divergence.
  includedConversationsPerDomain: integer('included_conversations_per_domain').notNull().default(BILLING_PRICING.includedPerDomain),
  overageMode: text('overage_mode').notNull().default('automatic'),    // OverageMode (CHECK)
  overageUnitCents: integer('overage_unit_cents').notNull().default(BILLING_PRICING.overageUnitCents),
  trialEndsAt: timestamp('trial_ends_at', { withTimezone: true }),
  currentPeriodStart: timestamp('current_period_start', { withTimezone: true }),
  currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
  cancelAtPeriodEnd: boolean('cancel_at_period_end').notNull().default(false),
  /** Overage units already reported to Stripe for `overage_reported_period_start` (deviation 3). */
  overageReported: integer('overage_reported').notNull().default(0),
  overageReportedPeriodStart: timestamp('overage_reported_period_start', { withTimezone: true }),
  /** Stripe `event.created` of the newest event applied — an older event arriving later is a no-op. */
  lastStripeEventCreated: bigint('last_stripe_event_created', { mode: 'number' }),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [
  check('billing_subscriptions_plan_check', sql`${t.plan} IN ('trial','standard')`),
  check('billing_subscriptions_status_check', sql`${t.status} IN ('trialing','active','past_due','canceled')`),
  check('billing_subscriptions_overage_mode_check', sql`${t.overageMode} IN ('automatic','blocked')`),
  ...tenantPolicies(t.orgId, 'billing_subscriptions'),
])
