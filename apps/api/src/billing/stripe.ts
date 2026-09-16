/**
 * The Stripe port — the ONE module in `apps/api` that imports the SDK. Everything above it
 * (`service.ts`, `webhook.ts`, `trpc/routers/billing.ts`) sees only the five methods below, which is
 * what lets the whole billing surface be driven by `test/helpers/fake-stripe.ts` with no network and
 * no fixtures, and what keeps a `stripe` upgrade a one-file change.
 *
 * WRITTEN AGAINST `stripe@22.6.2` (pinned exactly in `apps/api/package.json`), whose bundled API
 * version is `2026-08-26.dahlia` — `esm/apiVersion.d.ts` declares it and `esm/stripe.core.js` uses it
 * as `DEFAULT_API_VERSION`, so omitting `apiVersion` below PINS that version rather than following
 * the account's default. Signatures verified in `node_modules/stripe` before this file was written:
 *  - `esm/Webhooks.d.ts` — `constructEventAsync(payload: string | Uint8Array, header: string | string[] | Uint8Array, secret: string, …) => Promise<Event>`
 *  - `esm/resources/Customers.d.ts` — `create(params?: CustomerCreateParams)` with `email` / `name` /
 *    `metadata`, returning a `Customer` with `id: string`
 *  - `esm/resources/Checkout/Sessions.d.ts` — `create(params?)` with `mode`, `customer`,
 *    `client_reference_id`, `line_items[{ price, quantity }]`, `subscription_data.metadata`,
 *    `metadata`, `success_url`, `cancel_url`; the session's `url` is `string | null`
 *  - `esm/resources/BillingPortal/Sessions.d.ts` — `create({ customer, return_url })`, `url: string`
 *  - `esm/resources/Subscriptions.d.ts` — `cancel(id: string, params?, options?)`; `status` is
 *    `'active' | 'canceled' | 'incomplete' | 'incomplete_expired' | 'past_due' | 'paused' |
 *    'trialing' | 'unpaid'`; there is NO `current_period_start`/`current_period_end` on the
 *    subscription itself — `esm/resources/SubscriptionItems.d.ts` carries both, so the period comes
 *    off `subscription.items.data[i]` (webhook.ts reads `items.data[0]`)
 *  - `esm/resources/Invoices.d.ts` — an invoice's subscription id lives at
 *    `parent.subscription_details.subscription`
 *  - `esm/net/NodeHttpClient.js` — the default transport is Node's own `http`/`https`, never undici
 *    (asserted by `test/error-surface.test.ts`)
 *
 * Every SDK error is caught HERE and rethrown as a plain `Error` with a scrubbed message: a
 * `StripeError` carries `raw`, `headers` and `requestId`, and `headers` on a request error can echo
 * the `Authorization` line back. Nothing above this file ever touches an SDK object (CLAUDE.md,
 * Secrets — "never logged, never returned by an API").
 */
import Stripe from 'stripe'
import type { Secret } from '@aesa/crypto'

/** The slice of a Stripe event the webhook needs. `data.object` stays `unknown` on purpose: every
 *  consumer narrows it with its own zod schema rather than trusting the SDK's optimistic types. */
export interface StripeEvent {
  id: string
  type: string
  /** Unix seconds. The monotonic guard `billing_subscriptions.last_stripe_event_created` compares. */
  created: number
  data: { object: unknown }
}

export interface StripePort {
  createCustomer(p: { email: string | null; name: string; orgId: string }): Promise<{ id: string }>
  createCheckoutSession(p: {
    customerId: string; orgId: string; domainQuantity: number; successUrl: string; cancelUrl: string
  }): Promise<{ url: string }>
  createPortalSession(p: { customerId: string; returnUrl: string }): Promise<{ url: string }>
  cancelSubscription(subscriptionId: string): Promise<void>
  /** Throws on a bad signature — the caller answers 400 and records nothing. */
  constructEvent(rawBody: string, signature: string): Promise<StripeEvent>
}

export interface StripeConfig {
  secretKey: Secret
  webhookSecret: Secret
  /** The licensed per-domain price; its line item's quantity is the billed domain count. */
  priceDomain: string
  /** The metered overage price; one line, no quantity (usage is reported against it). */
  priceOverage: string
}

/** Anything that could carry a live key out of this module. Stripe's own key shapes plus any long
 *  opaque run — the same "cut it to a sentence, drop what looks like a credential" rule
 *  `llm_credentials.last_error` follows. */
const SECRETISH = /\b(?:sk|rk|pk|whsec)_[A-Za-z0-9_]+/g
const MAX_MESSAGE = 200

function scrub(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  return raw.replace(SECRETISH, '[redacted]').slice(0, MAX_MESSAGE)
}

/** One boundary for all five calls: the SDK's error object never escapes, only a scrubbed sentence. */
async function guard<T>(what: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    throw new Error(`stripe: ${what} failed: ${scrub(err)}`)
  }
}

export function createStripePort(config: StripeConfig): StripePort {
  // `typescript: true` only tags the user-agent; `apiVersion` is deliberately omitted so the SDK's
  // own pinned version (see the header) is used rather than the account default. `timeout` is the
  // SDK's per-request clock (its default is 80 s — inside a tRPC request and a Fastify handler,
  // long enough for the owner to have given up and tapped again); `maxNetworkRetries` is made
  // explicit rather than inherited (the SDK's default is 2 — retries are safe here because every
  // create carries the SDK's own idempotency key and `constructEvent` never leaves the process).
  const stripe = new Stripe(config.secretKey.expose(), { typescript: true, timeout: 15_000, maxNetworkRetries: 2 })

  return {
    createCustomer: (p) => guard('createCustomer', async () => {
      const customer = await stripe.customers.create({
        ...(p.email ? { email: p.email } : {}),
        name: p.name,
        metadata: { orgId: p.orgId },
      })
      return { id: customer.id }
    }),

    createCheckoutSession: (p) => guard('createCheckoutSession', async () => {
      const session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        customer: p.customerId,
        client_reference_id: p.orgId,
        line_items: [
          { price: config.priceDomain, quantity: p.domainQuantity },
          { price: config.priceOverage },
        ],
        success_url: p.successUrl,
        cancel_url: p.cancelUrl,
        subscription_data: { metadata: { orgId: p.orgId } },
        metadata: { orgId: p.orgId },
      })
      // `url` is `string | null` (null for an embedded/ui_mode session, which this never creates) —
      // a null here is a misconfiguration, not something to hand the browser.
      if (!session.url) throw new Error('checkout session has no url')
      return { url: session.url }
    }),

    createPortalSession: (p) => guard('createPortalSession', async () => {
      const session = await stripe.billingPortal.sessions.create({ customer: p.customerId, return_url: p.returnUrl })
      return { url: session.url }
    }),

    cancelSubscription: (subscriptionId) => guard('cancelSubscription', async () => {
      await stripe.subscriptions.cancel(subscriptionId)
    }),

    constructEvent: (rawBody, signature) => guard('constructEvent', async () => {
      const event = await stripe.webhooks.constructEventAsync(rawBody, signature, config.webhookSecret.expose())
      return { id: event.id, type: event.type, created: event.created, data: { object: event.data.object } }
    }),
  }
}
