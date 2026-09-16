/**
 * ONE fake Stripe for the Phase 7 E2E, implementing BOTH ports at once: the api's `StripePort`
 * (`apps/api/src/billing/stripe.ts` — Checkout, Portal, cancel, webhook verification) and the
 * worker's `StripeUsagePort` (`apps/worker/src/billing/stripe.ts` — the overage meter event and the
 * licensed quantity). It is the union of `apps/api/test/helpers/fake-stripe.ts` and
 * `./fake-stripe-usage.ts`, kept as one object on purpose: the E2E's whole point is that the api's
 * `startCheckout` and the worker's `billing.report-usage` talk about the SAME customer, and one call
 * log across both halves is what lets a scenario say "and Stripe heard nothing else".
 *
 * Every call is recorded in order, every answer is canned, and `constructEvent` verifies by the
 * crudest rule there is (`signature === 'valid'`). `stripeEvent(type, object, created)` mints the
 * `StripeEvent` envelope `applyStripeEvent` consumes, with a fresh `evt_` id each time — the
 * webhook's exactly-once gate keys on it.
 *
 * `StripePort` is not re-exported by any `@aesa/api` sub-path (only the service's deps name it), so
 * the api-side types are DERIVED from what `@aesa/api/billing` does export, which keeps this helper
 * off the api's `src/` tree the same way `@aesa/api/deps` keeps `e2e-phase6.test.ts` off it.
 */
import { randomUUID } from 'node:crypto'
import type { BillingServiceDeps } from '@aesa/api/billing'
import type { StripeUsagePort } from '../../src/billing/stripe.ts'

export type StripePort = NonNullable<BillingServiceDeps['stripe']>
export type StripeEvent = Awaited<ReturnType<StripePort['constructEvent']>>
export type { StripeUsagePort }

type ApiMethod = keyof StripePort
type UsageMethod = keyof StripeUsagePort
export type StripeMethod = ApiMethod | UsageMethod

export interface StripeCall { method: StripeMethod; params: unknown }

export interface FakeStripe {
  /** The api's half — `BillingServiceDeps.stripe` / `LifecycleDeps.stripe`. */
  port: StripePort
  /** The worker's half — `ReportUsageDeps.stripe`. */
  usagePort: StripeUsagePort
  /** Every call on EITHER port, in order, newest last. */
  calls: StripeCall[]
  /** Method names in here throw instead of answering — the `stripe_unavailable` / report-failed paths. */
  failing: Set<StripeMethod>
  /** `calls` filtered to one method — the shape every assertion wants. */
  callsTo(method: StripeMethod): StripeCall[]
  /** Forgets every recorded call — between scenarios, so one scenario's traffic cannot satisfy the next. */
  reset(): void
}

export function createFakeStripe(): FakeStripe {
  const calls: StripeCall[] = []
  const failing = new Set<StripeMethod>()

  async function enter(method: StripeMethod, params: unknown): Promise<void> {
    calls.push({ method, params })
    // The shape BOTH real ports throw: a plain Error with a scrubbed sentence, never an SDK object.
    if (failing.has(method)) throw new Error(`stripe: ${method} failed: fake failure`)
  }

  let seq = 0
  const port: StripePort = {
    async createCustomer(p) {
      await enter('createCustomer', p)
      return { id: `cus_fake_${++seq}` }
    },
    async createCheckoutSession(p) {
      await enter('createCheckoutSession', p)
      return { url: `https://checkout.stripe.test/c/${++seq}` }
    },
    async createPortalSession(p) {
      await enter('createPortalSession', p)
      return { url: `https://portal.stripe.test/p/${++seq}` }
    },
    async cancelSubscription(subscriptionId) {
      await enter('cancelSubscription', { subscriptionId })
    },
    async constructEvent(rawBody, signature) {
      await enter('constructEvent', { signature })
      if (signature !== 'valid') throw new Error('stripe: signature verification failed')
      return JSON.parse(rawBody) as StripeEvent
    },
  }

  const usagePort: StripeUsagePort = {
    reportOverage: (p) => enter('reportOverage', p),
    setDomainQuantity: (p) => enter('setDomainQuantity', p),
  }

  return {
    port,
    usagePort,
    calls,
    failing,
    callsTo: (method) => calls.filter((c) => c.method === method),
    reset: () => { calls.length = 0 },
  }
}

/** The `StripeEvent` envelope `applyStripeEvent` takes. `created` is Unix SECONDS — the monotonic
 *  guard (`billing_subscriptions.last_stripe_event_created`) compares it, so a scenario that sends
 *  two events passes strictly increasing values. */
export function stripeEvent(type: string, object: unknown, created: number): StripeEvent {
  return { id: `evt_${randomUUID()}`, type, created, data: { object } }
}
