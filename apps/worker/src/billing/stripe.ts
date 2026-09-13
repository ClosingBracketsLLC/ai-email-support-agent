/**
 * The worker's Stripe port — the ONE module in `apps/worker` that imports the SDK, and the twin of
 * `apps/api/src/billing/stripe.ts` (which holds the other half of the surface: Checkout, Portal,
 * cancel and webhook verification). Splitting them is deliberate: this side needs only two write
 * calls, and `billing.report-usage` can therefore be driven end to end by
 * `test/helpers/fake-stripe-usage.ts` with no network and no fixtures.
 *
 * WRITTEN AGAINST `stripe@22.6.2` (pinned exactly in `apps/worker/package.json`), whose bundled API
 * version is `2026-08-26.dahlia` — omitting `apiVersion` PINS that version rather than following the
 * account's default. Signatures verified in `node_modules/stripe` before this file was written:
 *  - `esm/resources/Billing/MeterEvents.d.ts` — `create(params: Billing.MeterEventCreateParams)`
 *    with `event_name: string`, `identifier?: string` and `payload: { [key: string]: string }`
 *    (**every payload value is a STRING**, so `value` is stringified below)
 *  - `esm/resources/Billing/index.d.ts` / `esm/stripe.core.js` — the resource is `stripe.billing.meterEvents`
 *  - `esm/resources/Subscriptions.d.ts` — `update(id: string, params?: SubscriptionUpdateParams)`,
 *    whose `items?: Array<Item>` carries `{ id?: string; quantity?: number }` and whose
 *    `proration_behavior` is `'always_invoice' | 'create_prorations' | 'none'`
 *
 * Every SDK error is caught HERE and rethrown as a plain `Error` with a scrubbed message: a
 * `StripeError` carries `raw`, `headers` and `requestId`, and `headers` on a request error can echo
 * the `Authorization` line back. Nothing above this file ever touches an SDK object (CLAUDE.md,
 * Secrets — "never logged, never returned by an API").
 */
import Stripe from 'stripe'
import type { Secret } from '@aesa/crypto'

export interface StripeUsagePort {
  /**
   * ONE Billing Meter event carrying the overage DELTA since the last report for this period
   * (plan deviation 3). `identifier` is `${orgId}:${periodStartIso}:${overageTotal}` — Stripe
   * enforces uniqueness on it for at least 24 hours, so a retried report of the same total is
   * swallowed on their side while the guarded `overage_reported` write is what makes it idempotent
   * on ours.
   */
  reportOverage(p: { customerId: string; value: number; identifier: string }): Promise<void>
  /** The licensed per-domain item's quantity, synced DAILY (never on every agent add/remove) with
   *  prorations created but not immediately invoiced. */
  setDomainQuantity(p: { subscriptionId: string; itemId: string; quantity: number }): Promise<void>
}

export interface StripeUsageConfig {
  secretKey: Secret
  /** The Billing Meter's `event_name` — `STRIPE_METER_EVENT_NAME`, default `ai_conversation_overage`.
   *  It MUST match the meter the api's `STRIPE_PRICE_OVERAGE` price is attached to. */
  meterEventName: string
}

/** Anything that could carry a live key out of this module — the same rule the api's port follows. */
const SECRETISH = /\b(?:sk|rk|pk|whsec)_[A-Za-z0-9_]+/g
const MAX_MESSAGE = 200

function scrub(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  return raw.replace(SECRETISH, '[redacted]').slice(0, MAX_MESSAGE)
}

/** One boundary for both calls: the SDK's error object never escapes, only a scrubbed sentence. */
async function guard<T>(what: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    throw new Error(`stripe: ${what} failed: ${scrub(err)}`)
  }
}

export function createStripeUsagePort(config: StripeUsageConfig): StripeUsagePort {
  // `typescript: true` only tags the user-agent; `apiVersion` is deliberately omitted so the SDK's
  // own pinned version (see the header) is used rather than the account default.
  const stripe = new Stripe(config.secretKey.expose(), { typescript: true })

  return {
    reportOverage: (p) => guard('reportOverage', async () => {
      await stripe.billing.meterEvents.create({
        event_name: config.meterEventName,
        identifier: p.identifier,
        // Both values are strings: the meter's `customer_mapping.event_payload_key` is
        // `stripe_customer_id` and its `value_settings.event_payload_key` is `value` (runbook).
        payload: { stripe_customer_id: p.customerId, value: String(p.value) },
      })
    }),

    setDomainQuantity: (p) => guard('setDomainQuantity', async () => {
      await stripe.subscriptions.update(p.subscriptionId, {
        items: [{ id: p.itemId, quantity: p.quantity }],
        proration_behavior: 'create_prorations',
      })
    }),
  }
}
