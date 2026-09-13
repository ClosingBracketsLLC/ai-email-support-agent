/**
 * Stripe's inbound webhook. Two exports, deliberately split: `applyStripeEvent` is the whole
 * decision and knows nothing about Fastify (the Phase 7 E2E replays real event bodies through it,
 * and every case in `test/billing-webhook.test.ts` drives it directly), while
 * `registerStripeWebhook` is the thin HTTP shell that verifies the signature and hands it over.
 *
 * Same trust shape as `webhooks/gmail.ts`: no session, one cryptographic anchor (the
 * `stripe-signature` header over the RAW bytes), and every outcome that is not a signature failure
 * answers 200 — Stripe retries a non-2xx for three days, so "we have seen this, there is nothing to
 * do" must ack, not nack. It is mounted OUTSIDE the `/trpc` CSRF hook (that hook matches
 * `req.url.startsWith('/trpc')`) and outside Better Auth entirely.
 *
 * Three guarantees this file is responsible for:
 *  - EXACTLY-ONCE application: `recordWebhookEvent('stripe', event.id, …)` is the same
 *    `ON CONFLICT DO NOTHING` gate the two mail webhooks use. The envelope stores the type and the
 *    timestamp and NOTHING else — a Stripe object carries the customer's email, name and card brand,
 *    and `webhook_events` is a platform table nobody scrubs.
 *  - MONOTONICITY: Stripe does not order deliveries. `last_stripe_event_created` is the watermark,
 *    checked on the read AND repeated in the UPDATE's WHERE, so an older event that lost a race
 *    between the two still writes nothing.
 *  - the payload is DATA: every object is narrowed by a zod schema here rather than trusted, and a
 *    shape that does not parse is `ignored` with a warn — never a throw, which would make Stripe
 *    redeliver the same unparseable bytes for three days.
 */
import type { FastifyInstance } from 'fastify'
import { and, eq, isNull, or, lte, sql } from 'drizzle-orm'
import { z } from 'zod'
import { audit, billingSubscriptions, ensureBillingRow, notifications, readBillingState } from '@aesa/db'
import { JOB_NAMES } from '@aesa/queue'
import type { ServerDeps } from '../deps.ts'
import type { BillingServiceDeps } from './service.ts'
import type { StripeEvent } from './stripe.ts'

export type StripeApplyOutcome = 'applied' | 'duplicate' | 'stale' | 'unknown_customer' | 'ignored'

// ---------------------------------------------------------------------------
// the payloads, narrowed
// ---------------------------------------------------------------------------

/** One subscription item. The PERIOD lives here, not on the subscription (stripe@22's
 *  `SubscriptionItems.d.ts` carries `current_period_start`/`current_period_end`; `Subscriptions.d.ts`
 *  does not). `price.id` is load-bearing: it is how `selectItems` tells the licensed domain line from
 *  the metered overage line — `Subscription.items` is an `ApiList` with no ordering guarantee. */
const ItemSchema = z.object({
  id: z.string(),
  price: z.object({ id: z.string() }),
  quantity: z.number().int().nonnegative().optional(),
  current_period_start: z.number().int().optional(),
  current_period_end: z.number().int().optional(),
})

const SubscriptionSchema = z.object({
  id: z.string(),
  customer: z.string(),
  status: z.string(),
  cancel_at_period_end: z.boolean().optional(),
  items: z.object({ data: z.array(ItemSchema) }).optional(),
  metadata: z.object({ orgId: z.string().optional() }).partial().optional(),
})
type SubscriptionPayload = z.infer<typeof SubscriptionSchema>

/**
 * A real `checkout.session.completed` carries `subscription` as a bare id string; a session created
 * with expansion carries the whole object. Both are accepted: a string writes the id and leaves the
 * items to the `customer.subscription.updated` that follows within the same second, an object fills
 * everything in at once. Accepting only one of the two would either break in production (object-only)
 * or make the E2E's single event insufficient (string-only).
 */
const CheckoutSessionSchema = z.object({
  customer: z.string(),
  client_reference_id: z.string().nullish(),
  metadata: z.object({ orgId: z.string().optional() }).partial().nullish(),
  subscription: z.union([z.string(), SubscriptionSchema]).nullish(),
  /** `'paid' | 'unpaid' | 'no_payment_required'` in stripe@22 (`Checkout/Sessions.d.ts`, whose own
   *  doc says "use this value to decide when to fulfill"). `.catch(undefined)` rather than a bare
   *  enum because the SDK's union ends in `OtherString`: a value Stripe adds later must NOT fail the
   *  whole parse and lose a real checkout — it falls through to the same not-yet-paid branch as
   *  `'unpaid'`, which is the safe direction. */
  payment_status: z.enum(['paid', 'unpaid', 'no_payment_required']).optional().catch(undefined),
})

/** An invoice's subscription id is at `parent.subscription_details.subscription` in stripe@22. */
const InvoiceSchema = z.object({
  customer: z.string(),
  parent: z.object({
    subscription_details: z.object({ subscription: z.union([z.string(), z.object({ id: z.string() })]) }).nullish(),
  }).nullish(),
})

/**
 * Stripe's subscription status → the platform's status AND plan. The two subscription-shaped events
 * (`checkout.session.completed`, `customer.subscription.*`) are the ONLY things that establish the
 * plan — an invoice may move the status and nothing else — so the plan rides along here rather than
 * being seeded independently: a live subscription in any state is `standard`, a gone one is back on
 * `trial`.
 *
 * `incomplete` maps to NOTHING, and the null is the point: the customer is mid-SCA or their card was
 * declined at completion, so neither the status nor the plan may move. Landing `active`/`standard`
 * there would hand the workspace the paid product before the first payment succeeded; landing
 * `past_due` would page the owner for a payment that has not failed. The row simply keeps its
 * trial state until the `customer.subscription.updated` that resolves the payment arrives.
 */
function statusOf(stripeStatus: string): { status: 'active' | 'past_due' | 'canceled'; plan: 'trial' | 'standard' } | null {
  switch (stripeStatus) {
    case 'active': case 'trialing': return { status: 'active', plan: 'standard' }
    case 'past_due': case 'unpaid': case 'paused': return { status: 'past_due', plan: 'standard' }
    case 'canceled': case 'incomplete_expired': return { status: 'canceled', plan: 'trial' }
    default: return null   // 'incomplete' and anything Stripe adds later
  }
}

/** The audit action for each handled type — a stable name the audit trail can be searched on,
 *  rather than the raw dotted event type (`billing.checkout.session.completed` reads as nonsense). */
const AUDIT_ACTIONS: Record<string, string> = {
  'checkout.session.completed': 'billing.subscription_activated',
  'customer.subscription.updated': 'billing.subscription_updated',
  'customer.subscription.deleted': 'billing.subscription_canceled',
  'invoice.payment_failed': 'billing.payment_failed',
  'invoice.paid': 'billing.payment_succeeded',
}

/** The columns one event may change. Every field is optional: an event only ever patches what it knows. */
interface BillingPatch {
  plan?: 'trial' | 'standard'
  status?: 'active' | 'past_due' | 'canceled'
  stripeSubscriptionId?: string
  stripeDomainItemId?: string
  stripeOverageItemId?: string
  domainQuantity?: number
  currentPeriodStart?: Date
  currentPeriodEnd?: Date
  cancelAtPeriodEnd?: boolean
}

const unixToDate = (seconds: number | undefined): Date | undefined => (seconds === undefined ? undefined : new Date(seconds * 1000))

/** The two configured price ids, threaded down from `config.stripe`. Null on an api with no
 *  `STRIPE_*` at all, where position is the only thing left to go on. */
export interface PriceIds { domain: string | null; overage: string | null }

/**
 * Which item is the licensed domain line and which is the metered overage line, BY PRICE. Stripe's
 * `Subscription.items` is an `ApiList` with no documented ordering, and reading it positionally
 * fails silently in two ways at once if it ever comes back overage-first: the two item ids are
 * stored swapped, and `domainQuantity` stops updating entirely (a metered item carries no
 * `quantity`, so the guard below simply skips it) — a billed domain count frozen at whatever it was.
 *
 * Position survives only as a FALLBACK for when NEITHER configured price matches: a subscription
 * created against a price id that has since been retired or rotated must stay readable. That
 * fallback is logged (`fellBackToPosition`) because it means the deploy's `STRIPE_PRICE_*` no longer
 * describe this customer's subscription. A PARTIAL match deliberately leaves the unmatched side
 * untouched rather than guessing — the column keeps the id it already had.
 */
function selectItems(sub: SubscriptionPayload, prices: PriceIds): {
  domain: z.infer<typeof ItemSchema> | undefined
  overage: z.infer<typeof ItemSchema> | undefined
  fellBackToPosition: boolean
} {
  const items = sub.items?.data ?? []
  const domain = prices.domain === null ? undefined : items.find((i) => i.price.id === prices.domain)
  const overage = prices.overage === null ? undefined : items.find((i) => i.price.id === prices.overage)
  if (domain !== undefined || overage !== undefined) return { domain, overage, fellBackToPosition: false }
  // Nothing matched. Only interesting enough to log when prices were configured AND there was
  // something to match against — an unconfigured api (or an empty item list) has no other option.
  const configured = prices.domain !== null || prices.overage !== null
  return { domain: items[0], overage: items[1], fellBackToPosition: configured && items.length > 0 }
}

/** The item ids, the billed quantity and the period, taken off a subscription object's items. The
 *  DOMAIN line (the licensed one) carries the quantity and the period; the overage line is the
 *  metered price, which has no quantity of its own. */
function patchFromSubscription(sub: SubscriptionPayload, prices: PriceIds): BillingPatch & { fellBackToPosition: boolean } {
  const patch: BillingPatch = { stripeSubscriptionId: sub.id }
  if (sub.cancel_at_period_end !== undefined) patch.cancelAtPeriodEnd = sub.cancel_at_period_end
  const { domain, overage, fellBackToPosition } = selectItems(sub, prices)
  if (domain) {
    patch.stripeDomainItemId = domain.id
    if (domain.quantity !== undefined) patch.domainQuantity = domain.quantity
    const start = unixToDate(domain.current_period_start)
    const end = unixToDate(domain.current_period_end)
    if (start) patch.currentPeriodStart = start
    if (end) patch.currentPeriodEnd = end
  }
  if (overage) patch.stripeOverageItemId = overage.id
  return { ...patch, fellBackToPosition }
}

interface Parsed {
  /** Which family this event belongs to. `invoice` events are the only ones whose subscription id is
   *  re-checked against the row before anything is written (see `applyStripeEvent`). */
  kind: 'checkout' | 'subscription' | 'invoice'
  customerId: string
  /** Only `checkout.session.completed` may claim an org it was not resolved to — see `resolveOrg`. */
  claimedOrgId: string | null
  patch: BillingPatch
  /** True when `selectItems` could not match either configured price and read the items positionally. */
  fellBackToPosition: boolean
  /** Set on a `checkout.session.completed` whose payment has NOT settled: the Stripe ids are
   *  recorded but the plan and status are left alone. Carries the session's `payment_status` for
   *  the log line. */
  deferredFulfilment: { paymentStatus: string | null } | null
  auditDetail: Record<string, unknown>
}

/** Returns null when this event is not one we act on, or when its object does not match the shape. */
function parseEvent(event: StripeEvent, prices: PriceIds): Parsed | null {
  switch (event.type) {
    case 'checkout.session.completed': {
      const parsed = CheckoutSessionSchema.safeParse(event.data.object)
      if (!parsed.success) return null
      const s = parsed.data
      const patch: BillingPatch = {}
      let fellBackToPosition = false
      let deferredFulfilment: { paymentStatus: string | null } | null = null

      if (s.subscription && typeof s.subscription !== 'string') {
        // The EXPANDED variant. The subscription's own status decides, not the session's arrival:
        // `incomplete` (SCA still pending, or the card declined at completion) maps to null, and
        // then neither the status nor the plan moves at all — the ids and the period are facts
        // worth recording, but the workspace does not get the paid product until a payment
        // actually succeeds.
        const fromSub = patchFromSubscription(s.subscription, prices)
        fellBackToPosition = fromSub.fellBackToPosition
        Object.assign(patch, fromSub)
        const mapped = statusOf(s.subscription.status)
        if (mapped) Object.assign(patch, mapped)
      } else {
        // The BARE-ID variant — and the only one a real event takes: a webhook payload does not
        // honour an `expand` passed at session creation, so `createCheckoutSession` cannot ask for
        // the subscription object and every completion this platform produces arrives here.
        //
        // There is therefore no subscription status to read, and the session's ARRIVAL is not
        // fulfilment: a subscription can initialise `incomplete`. `payment_status` is the signal
        // Stripe provides for exactly this decision. The ids are recorded either way — they are
        // facts, and the row needs them for the guard below — but the plan and the status move only
        // once the money has settled. A deferred one is carried to `standard` by the matching
        // `invoice.paid` (see `applyStripeEvent`), or expired by `incomplete_expired`.
        if (typeof s.subscription === 'string') patch.stripeSubscriptionId = s.subscription
        const settled = s.payment_status === 'paid' || s.payment_status === 'no_payment_required'
        if (settled) {
          patch.plan = 'standard'
          patch.status = 'active'
        } else {
          deferredFulfilment = { paymentStatus: s.payment_status ?? null }
        }
      }

      return {
        kind: 'checkout',
        customerId: s.customer,
        claimedOrgId: s.metadata?.orgId ?? s.client_reference_id ?? null,
        patch,
        fellBackToPosition,
        deferredFulfilment,
        auditDetail: { subscriptionId: patch.stripeSubscriptionId ?? null },
      }
    }
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const parsed = SubscriptionSchema.safeParse(event.data.object)
      if (!parsed.success) return null
      const sub = parsed.data
      const { fellBackToPosition, ...patch } = patchFromSubscription(sub, prices)
      if (event.type === 'customer.subscription.deleted') {
        // A gone subscription is a workspace back on the trial plan with nothing scheduled — the
        // `cancel_at_period_end` flag the UI renders as "ends on …" would be a lie from here on.
        patch.status = 'canceled'
        patch.plan = 'trial'
        patch.cancelAtPeriodEnd = false
      } else {
        const mapped = statusOf(sub.status)
        if (mapped) Object.assign(patch, mapped)
      }
      return {
        kind: 'subscription', customerId: sub.customer, claimedOrgId: null, patch, fellBackToPosition,
        deferredFulfilment: null,
        auditDetail: { subscriptionId: sub.id, stripeStatus: sub.status },
      }
    }
    case 'invoice.payment_failed':
    case 'invoice.paid': {
      const parsed = InvoiceSchema.safeParse(event.data.object)
      if (!parsed.success) return null
      const inv = parsed.data
      const raw = inv.parent?.subscription_details?.subscription
      const subscriptionId = typeof raw === 'string' ? raw : raw?.id
      // An invoice moves the STATUS here. `invoice.paid` may ALSO establish the plan, but only
      // under the subscription-match guard in `applyStripeEvent` — which cannot be evaluated
      // without the row, so it is not decided at this layer. An unguarded `plan: 'standard'` would
      // let a one-off charge, or a dunning payment on an old invoice, promote a trial workspace.
      const patch: BillingPatch = event.type === 'invoice.paid'
        ? { status: 'active' }
        : { status: 'past_due' }
      if (subscriptionId) patch.stripeSubscriptionId = subscriptionId
      return {
        kind: 'invoice', customerId: inv.customer, claimedOrgId: null, patch, fellBackToPosition: false,
        deferredFulfilment: null,
        auditDetail: { subscriptionId: subscriptionId ?? null },
      }
    }
    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// the notification
// ---------------------------------------------------------------------------

const PAST_DUE_TITLE = 'Payment failed'
const PAST_DUE_BODY = 'Autopilot is paused until the card is updated. Replies still come to you for review.'

const utcDay = (d: Date): string => d.toISOString().slice(0, 10)

// ---------------------------------------------------------------------------
// applyStripeEvent
// ---------------------------------------------------------------------------

export async function applyStripeEvent(deps: BillingServiceDeps, event: StripeEvent): Promise<StripeApplyOutcome> {
  // Type and timestamp ONLY — never the object (customer email, card brand, address).
  const isNew = await deps.api.recordWebhookEvent('stripe', event.id, { type: event.type, created: event.created })
  if (!isNew) return 'duplicate'

  const parsed = parseEvent(event, { domain: deps.priceDomain, overage: deps.priceOverage })
  if (!parsed) {
    // A type we do not act on is routine; a type we DO act on whose object did not parse is a
    // shape change worth a line. Both ack.
    if (event.type in AUDIT_ACTIONS) deps.logger.warn({ eventId: event.id, type: event.type }, 'stripe.unparseable_payload')
    return 'ignored'
  }

  const resolved = await deps.api.resolveStripeCustomer(parsed.customerId)
  const orgId = resolved?.orgId ?? parsed.claimedOrgId
  if (!orgId) {
    // Not a bug we can fix from here: a customer this platform has never stored means a webhook
    // endpoint pointed at the wrong account, or a workspace whose row was purged with the Stripe
    // customer still live. Both need a human.
    deps.logger.error(
      { alert: true, kind: 'stripe_unknown_customer', eventId: event.id, type: event.type, customerId: parsed.customerId },
      'stripe webhook: unknown customer',
    )
    return 'unknown_customer'
  }

  if (parsed.fellBackToPosition) {
    // The deploy's STRIPE_PRICE_* no longer describe this customer's subscription (a rotated or
    // retired price). The items were read positionally, which is a guess — worth knowing about
    // before it becomes a swapped item id.
    deps.logger.warn(
      { eventId: event.id, type: event.type, orgId, priceDomain: deps.priceDomain, priceOverage: deps.priceOverage },
      'stripe.items_read_positionally',
    )
  }

  const now = deps.now?.() ?? new Date()
  const outcome = await deps.api.withOrg<{
    result: StripeApplyOutcome
    notificationId?: string
    /** Set when this event named a subscription other than the one the row already carries. */
    displacedSubscriptionId?: string
  }>(orgId, async (tx) => {
    await ensureBillingRow(tx)
    const state = await readBillingState(tx, now)

    // A claimed org (only `checkout.session.completed` can claim one) may be adopted ONLY when its
    // row has no customer yet, or already names this one. Otherwise a forged `client_reference_id`
    // could re-point a live workspace's billing at somebody else's customer.
    if (!resolved && state.stripeCustomerId !== null && state.stripeCustomerId !== parsed.customerId) {
      return { result: 'unknown_customer' }
    }

    if (state.lastStripeEventCreated !== null && event.created < state.lastStripeEventCreated) {
      return { result: 'stale' }
    }

    // An INVOICE only speaks for the subscription it belongs to. A dunning-recovery payment on an
    // old open invoice, or any unrelated one-off charge on the same customer, carries a genuinely
    // newer `created` — so the monotonic guard above lets it through, and without this it would
    // resurrect a canceled workspace to `active`. A null id on the row is the legitimate race where
    // `invoice.paid` beats `checkout.session.completed`, and still applies.
    const invoiceSubscriptionId = parsed.patch.stripeSubscriptionId
    if (parsed.kind === 'invoice' && invoiceSubscriptionId !== undefined
        && state.stripeSubscriptionId !== null && invoiceSubscriptionId !== state.stripeSubscriptionId) {
      return { result: 'ignored' }
    }

    // `invoice.paid` for the row's OWN subscription is what carries a deferred Checkout (see the
    // bare-id branch of `parseEvent`) from "ids recorded, still on trial" to the paid plan: the
    // money has arrived for the subscription this workspace actually holds. It is deliberately
    // narrower than the status move above — the row's id must be set AND equal, so the legitimate
    // `invoice.paid`-beats-`checkout.session.completed` race (null id) moves the status only, and
    // a workspace is never promoted by an invoice whose subscription we cannot vouch for.
    const invoicePromotesPlan = event.type === 'invoice.paid'
      && invoiceSubscriptionId !== undefined
      && state.stripeSubscriptionId !== null
      && invoiceSubscriptionId === state.stripeSubscriptionId

    // A subscription id different from the one on the row means this customer now has TWO live
    // subscriptions — two Checkout sessions started before either completed, typically. The newer
    // one is taken (last-write-wins, as everywhere else here, and Stripe treats the newer as
    // current), but the older one keeps billing the customer while being invisible to the platform,
    // so an operator has to be told which id to cancel. Collected here, alerted after the commit.
    const displaced = parsed.kind !== 'invoice'
      && parsed.patch.stripeSubscriptionId !== undefined
      && state.stripeSubscriptionId !== null
      && parsed.patch.stripeSubscriptionId !== state.stripeSubscriptionId
      ? state.stripeSubscriptionId
      : undefined

    const patch = {
      ...parsed.patch,
      ...(invoicePromotesPlan ? { plan: 'standard' as const } : {}),
      stripeCustomerId: parsed.customerId,
      lastStripeEventCreated: event.created,
    }
    const written = await tx.update(billingSubscriptions)
      .set(patch)
      .where(and(
        eq(billingSubscriptions.orgId, orgId),
        // The watermark again, inside the write: another delivery may have landed between the read
        // above and here, and the newer one must win. Zero rows is a soft outcome, never an error.
        or(isNull(billingSubscriptions.lastStripeEventCreated), lte(billingSubscriptions.lastStripeEventCreated, sql`${event.created}::bigint`)),
      ))
      .returning({ orgId: billingSubscriptions.orgId })
    if (written.length === 0) return { result: 'stale' }

    await audit(tx, {
      actor: 'system:stripe.webhook',
      action: AUDIT_ACTIONS[event.type] ?? 'billing.event',
      entityType: 'billing_subscription',
      entityId: orgId,
      detail: { eventId: event.id, type: event.type, ...parsed.auditDetail },
    })

    // Only a TRANSITION into past_due pages: an event that merely restates the state the row is
    // already in (Stripe emits several per failed invoice) must not.
    let notificationId: string | undefined
    if (patch.status === 'past_due' && state.status !== 'past_due') {
      const [row] = await tx.insert(notifications)
        .values({
          orgId, kind: 'billing', title: PAST_DUE_TITLE, body: PAST_DUE_BODY,
          dedupeKey: `billing:past_due:${orgId}:${utcDay(now)}`,
          payload: { state: 'past_due' },
        })
        .onConflictDoNothing({ target: notifications.dedupeKey })
        .returning({ id: notifications.id })
      notificationId = row?.id
    }
    return {
      result: 'applied',
      ...(notificationId ? { notificationId } : {}),
      ...(displaced ? { displacedSubscriptionId: displaced } : {}),
    }
  })

  // The claim was refused inside the transaction (the org's row already names a different Stripe
  // customer). Same alert as the unresolved case above — this one is more interesting, not less: a
  // `client_reference_id` pointing at a workspace that is already somebody else's customer is
  // either a replayed session or a forged one.
  if (outcome.result === 'unknown_customer') {
    deps.logger.error(
      { alert: true, kind: 'stripe_unknown_customer', eventId: event.id, type: event.type, customerId: parsed.customerId, claimedOrgId: parsed.claimedOrgId },
      'stripe webhook: claimed workspace already belongs to another customer',
    )
  }

  if (outcome.result === 'applied' && parsed.deferredFulfilment) {
    // Not a fault — a subscription that initialises unpaid is an ordinary SCA/decline outcome — but
    // the workspace is now holding Stripe ids on the trial plan, and that state should be legible
    // when someone asks why a customer who "subscribed" still has trial caps.
    deps.logger.info(
      {
        eventId: event.id, orgId, subscriptionId: parsed.patch.stripeSubscriptionId ?? null,
        paymentStatus: parsed.deferredFulfilment.paymentStatus,
      },
      'stripe.checkout_completed_unpaid',
    )
  }

  if (outcome.result === 'ignored' && parsed.kind === 'invoice') {
    deps.logger.warn(
      { eventId: event.id, type: event.type, orgId, invoiceSubscriptionId: parsed.patch.stripeSubscriptionId },
      'stripe.invoice_for_another_subscription',
    )
  }

  if (outcome.displacedSubscriptionId) {
    deps.logger.error(
      {
        alert: true, kind: 'stripe_double_subscription', eventId: event.id, type: event.type, orgId,
        previousSubscriptionId: outcome.displacedSubscriptionId,
        incomingSubscriptionId: parsed.patch.stripeSubscriptionId,
      },
      'stripe webhook: workspace has a second live subscription; cancel the previous one',
    )
  }

  // Post-commit, like every other notification path in the api.
  if (outcome.notificationId) {
    const jobId = await deps.enqueue(JOB_NAMES.notifyDispatch, { orgId, notificationId: outcome.notificationId }, { entityId: outcome.notificationId })
    if (jobId === null) deps.logger.warn({ orgId, notificationId: outcome.notificationId }, 'notify.dispatch enqueue returned no job id; the digest will collapse it')
  }
  return outcome.result
}

// ---------------------------------------------------------------------------
// the route
// ---------------------------------------------------------------------------

/** `ServerDeps` → the service's own deps. The same slice `trpc/routers/billing.ts` builds. */
const serviceDeps = (deps: ServerDeps): BillingServiceDeps => ({
  api: deps.api, enqueue: deps.enqueue, logger: deps.logger,
  stripe: deps.stripe, appWebOrigin: deps.config.appWebOrigin,
  priceDomain: deps.config.stripe?.priceDomain ?? null,
  priceOverage: deps.config.stripe?.priceOverage ?? null,
})

export function registerStripeWebhook(routes: FastifyInstance, deps: ServerDeps): void {
  routes.register(async (scoped) => {
    // Stripe verifies the RAW bytes; the app-wide parser (server.ts) hands every route parsed JSON,
    // and a body that has been through JSON.parse/JSON.stringify verifies against nothing. This
    // encapsulated context swaps the parser for one that keeps the string — for this route only, the
    // same trick server.ts plays for @fastify/formbody around the review pages.
    scoped.removeContentTypeParser('application/json')
    scoped.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => { done(null, body) })

    scoped.post('/webhooks/stripe', async (req, reply) => {
      if (!deps.stripe) return reply.code(404).send({ statusCode: 404, error: 'Not Found' })

      const sig = req.headers['stripe-signature']
      if (typeof sig !== 'string' || typeof req.body !== 'string') {
        return reply.code(400).send({ statusCode: 400, error: 'Bad Request' })
      }

      let event: StripeEvent
      try {
        event = await deps.stripe.constructEvent(req.body, sig)
      } catch (err) {
        // The only 4xx this route ever answers, and the only branch that records nothing: anybody can
        // POST here, so an unverifiable body is not evidence of a Stripe problem — but a SUSTAINED
        // run of them is either a rotated webhook secret or someone probing, and both want a human.
        req.log.error({ alert: true, kind: 'stripe_webhook_rejected', err }, 'stripe webhook: signature rejected')
        return reply.code(400).send({ statusCode: 400, error: 'Bad Request' })
      }

      const outcome = await applyStripeEvent(serviceDeps(deps), event)
      return reply.code(200).send({ outcome })
    })
  })
}
