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
 *  does not) — `items.data[0]` is the licensed domain line, which is the one we bill the period on. */
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
})

/** An invoice's subscription id is at `parent.subscription_details.subscription` in stripe@22. */
const InvoiceSchema = z.object({
  customer: z.string(),
  parent: z.object({
    subscription_details: z.object({ subscription: z.union([z.string(), z.object({ id: z.string() })]) }).nullish(),
  }).nullish(),
})

/** Stripe's subscription status → the platform's four. `incomplete` maps to nothing: the customer is
 *  mid-3DS, and writing `past_due` there would page the owner for a payment that has not failed. */
function statusOf(stripeStatus: string): { status: 'active' | 'past_due' | 'canceled'; plan?: 'trial' } | null {
  switch (stripeStatus) {
    case 'active': case 'trialing': return { status: 'active' }
    case 'past_due': case 'unpaid': case 'paused': return { status: 'past_due' }
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

/** The item ids, the billed quantity and the period, taken off a subscription object's items. The
 *  DOMAIN line (`items.data[0]`, the licensed one) is the quantity and the period; the second line is
 *  the metered overage price, which has no quantity of its own. */
function patchFromSubscription(sub: SubscriptionPayload): BillingPatch {
  const patch: BillingPatch = { stripeSubscriptionId: sub.id }
  if (sub.cancel_at_period_end !== undefined) patch.cancelAtPeriodEnd = sub.cancel_at_period_end
  const items = sub.items?.data ?? []
  const domain = items[0]
  const overage = items[1]
  if (domain) {
    patch.stripeDomainItemId = domain.id
    if (domain.quantity !== undefined) patch.domainQuantity = domain.quantity
    const start = unixToDate(domain.current_period_start)
    const end = unixToDate(domain.current_period_end)
    if (start) patch.currentPeriodStart = start
    if (end) patch.currentPeriodEnd = end
  }
  if (overage) patch.stripeOverageItemId = overage.id
  return patch
}

interface Parsed {
  customerId: string
  /** Only `checkout.session.completed` may claim an org it was not resolved to — see `resolveOrg`. */
  claimedOrgId: string | null
  patch: BillingPatch
  auditDetail: Record<string, unknown>
}

/** Returns null when this event is not one we act on, or when its object does not match the shape. */
function parseEvent(event: StripeEvent): Parsed | null {
  switch (event.type) {
    case 'checkout.session.completed': {
      const parsed = CheckoutSessionSchema.safeParse(event.data.object)
      if (!parsed.success) return null
      const s = parsed.data
      const patch: BillingPatch = { plan: 'standard', status: 'active' }
      if (typeof s.subscription === 'string') patch.stripeSubscriptionId = s.subscription
      else if (s.subscription) {
        Object.assign(patch, patchFromSubscription(s.subscription))
        // The session's own completion is the activation; the subscription's status only narrows it.
        const mapped = statusOf(s.subscription.status)
        if (mapped) Object.assign(patch, mapped)
      }
      return {
        customerId: s.customer,
        claimedOrgId: s.metadata?.orgId ?? s.client_reference_id ?? null,
        patch,
        auditDetail: { subscriptionId: patch.stripeSubscriptionId ?? null },
      }
    }
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const parsed = SubscriptionSchema.safeParse(event.data.object)
      if (!parsed.success) return null
      const sub = parsed.data
      const patch = patchFromSubscription(sub)
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
      return { customerId: sub.customer, claimedOrgId: null, patch, auditDetail: { subscriptionId: sub.id, stripeStatus: sub.status } }
    }
    case 'invoice.payment_failed':
    case 'invoice.paid': {
      const parsed = InvoiceSchema.safeParse(event.data.object)
      if (!parsed.success) return null
      const inv = parsed.data
      const raw = inv.parent?.subscription_details?.subscription
      const subscriptionId = typeof raw === 'string' ? raw : raw?.id
      const patch: BillingPatch = event.type === 'invoice.paid'
        ? { status: 'active', plan: 'standard' }
        : { status: 'past_due' }
      if (subscriptionId) patch.stripeSubscriptionId = subscriptionId
      return { customerId: inv.customer, claimedOrgId: null, patch, auditDetail: { subscriptionId: subscriptionId ?? null } }
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

  const parsed = parseEvent(event)
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

  const now = deps.now?.() ?? new Date()
  const outcome = await deps.api.withOrg<{ result: StripeApplyOutcome; notificationId?: string }>(orgId, async (tx) => {
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

    const patch = { ...parsed.patch, stripeCustomerId: parsed.customerId, lastStripeEventCreated: event.created }
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
    return { result: 'applied', ...(notificationId ? { notificationId } : {}) }
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
