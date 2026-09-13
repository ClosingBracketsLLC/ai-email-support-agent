/**
 * POST /webhooks/stripe and the `applyStripeEvent` it wraps. Two halves, deliberately:
 *  - `applyStripeEvent` driven DIRECTLY (no Fastify at all) — it is what the Phase 7 E2E replays, and
 *    what every dedupe/staleness/status-map case here asserts against rows;
 *  - the route over real HTTP, for the three things only Fastify can prove: a bad signature is a 400
 *    that records nothing, the route 404s when `deps.stripe` is null, and — the reason the route has
 *    its own encapsulated parser at all — the body reaches `constructEvent` as the EXACT raw string.
 *
 * That last one is not cosmetic: Stripe's signature covers the bytes, so a body that has been through
 * `JSON.parse`/`JSON.stringify` verifies against nothing. The assertion compares the fake's recorded
 * `rawBodies[0]` with the literal string the test posted, whitespace included.
 */
import { randomUUID } from 'node:crypto'
import { createTRPCClient, httpBatchLink } from '@trpc/client'
import { and, eq } from 'drizzle-orm'
import superjson from 'superjson'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { auditLog, billingSubscriptions, notifications, webhookEvents } from '@aesa/db'
import { withPlatform } from '@aesa/db'
import { JOB_NAMES } from '@aesa/queue'
import { applyStripeEvent } from '../src/billing/webhook.ts'
import type { BillingServiceDeps } from '../src/billing/service.ts'
import type { StripeEvent } from '../src/billing/stripe.ts'
import type { EnqueueFn } from '../src/deps.ts'
import { createAppLogger } from '../src/logging.ts'
import type { AppRouter } from '../src/trpc/router.ts'
import { WEB, createTestApi, listen, signInWithOtp } from './helpers/app.ts'
import { createFakeStripe, type FakeStripe } from './helpers/fake-stripe.ts'

const client = (base: string, cookie?: string) => createTRPCClient<AppRouter>({
  links: [httpBatchLink({ url: `${base}/trpc`, transformer: superjson, headers: () => ({ origin: WEB, ...(cookie ? { cookie } : {}) }) })],
})

interface Recorded { name: string; data: Record<string, unknown>; opts: { entityId: string } }

/** Unix seconds — what `event.created` and the item periods are in. */
const T0 = 1_800_000_000

/** The deploy's configured price ids — what `selectItems` matches subscription items against. The
 *  fixtures below default to these, so the by-price path is the one normally exercised. */
const PRICE_DOMAIN = 'price_domain_cfg'
const PRICE_OVERAGE = 'price_overage_cfg'

const subscriptionObject = (p: {
  id: string; customer: string; status: string; quantity?: number
  domainItemId?: string; overageItemId?: string; priceDomain?: string; priceOverage?: string
  periodStart?: number; periodEnd?: number; cancelAtPeriodEnd?: boolean; orgId?: string
  /** Stripe's `items` is an `ApiList` with no ordering guarantee — this flips the order so a test
   *  can prove the reader identifies items BY PRICE and not by position. */
  overageFirst?: boolean
}) => {
  const domain = {
    id: p.domainItemId ?? 'si_domain_1',
    price: { id: p.priceDomain ?? PRICE_DOMAIN },
    quantity: p.quantity ?? 2,
    current_period_start: p.periodStart ?? T0,
    current_period_end: p.periodEnd ?? T0 + 2_592_000,
  }
  const overage = {
    id: p.overageItemId ?? 'si_overage_1',
    price: { id: p.priceOverage ?? PRICE_OVERAGE },
    current_period_start: p.periodStart ?? T0,
    current_period_end: p.periodEnd ?? T0 + 2_592_000,
  }
  return {
    id: p.id,
    customer: p.customer,
    status: p.status,
    cancel_at_period_end: p.cancelAtPeriodEnd ?? false,
    ...(p.orgId ? { metadata: { orgId: p.orgId } } : {}),
    items: { data: p.overageFirst ? [overage, domain] : [domain, overage] },
  }
}

const event = (type: string, object: unknown, opts: { id?: string; created?: number } = {}): StripeEvent => ({
  id: opts.id ?? `evt_${randomUUID()}`,
  type,
  created: opts.created ?? T0,
  data: { object },
})

describe('stripe webhook', () => {
  let t: Awaited<ReturnType<typeof createTestApi>>
  let base: string
  let fake: FakeStripe
  let deps: BillingServiceDeps
  let sent: Recorded[]
  let seq = 0

  beforeAll(async () => {
    fake = createFakeStripe()
    sent = []
    const enqueue: EnqueueFn = async (name, data, opts) => { sent.push({ name, data, opts }); return `job-${sent.length}` }
    t = await createTestApi({}, { enqueue, stripe: fake.port })
    base = await listen(t.app)
    deps = {
      api: t.api, enqueue, logger: createAppLogger({ level: 'silent' }), stripe: fake.port, appWebOrigin: WEB,
      priceDomain: PRICE_DOMAIN, priceOverage: PRICE_OVERAGE,
    }
  })
  afterAll(async () => { await t.close() })
  beforeEach(() => { sent.length = 0; fake.calls.length = 0; fake.rawBodies.length = 0; fake.failing.clear() })

  /** A workspace whose billing row already carries a Stripe customer id — what `resolve_stripe_customer` finds. */
  async function seedOrg(opts: { customerId?: string } = {}) {
    const n = ++seq
    const signed = await signInWithOtp(t.app, t.mail, `billing-hook-${n}@example.com`, 'Owner')
    const c = client(base, signed.cookie)
    const { orgId } = await c.workspace.create.mutate({ businessName: `Acme ${n}`, timezone: 'UTC' })
    const customerId = opts.customerId ?? `cus_hook_${n}`
    if (opts.customerId !== null) {
      await t.api.withOrg(orgId, (tx) => tx.update(billingSubscriptions)
        .set({ stripeCustomerId: customerId }).where(eq(billingSubscriptions.orgId, orgId)))
    }
    return { orgId, customerId, c, seq: n }
  }

  const rowOf = async (orgId: string) => {
    const [row] = await t.api.withOrg(orgId, (tx) => tx.select().from(billingSubscriptions).where(eq(billingSubscriptions.orgId, orgId)))
    return row
  }
  const auditsOf = (orgId: string, action: string) =>
    t.api.withOrg(orgId, (tx) => tx.select().from(auditLog).where(and(eq(auditLog.orgId, orgId), eq(auditLog.action, action))))
  const billingNotificationsOf = (orgId: string) =>
    t.api.withOrg(orgId, (tx) => tx.select().from(notifications).where(and(eq(notifications.orgId, orgId), eq(notifications.kind, 'billing'))))
  /** `webhook_events` is an RLS-exempt PLATFORM table — the app role cannot read it. */
  const webhookEventsFor = (externalId: string) =>
    withPlatform(t.handle.db, 'test:read-webhook-events', (tx) => tx.select().from(webhookEvents).where(eq(webhookEvents.externalId, externalId)))

  // -------------------------------------------------------------------------

  it('checkout.session.completed: resolves the org by customer id, writes subscription id, item ids by price, quantity, period from items[0], plan standard, status active, last_stripe_event_created; audits billing.subscription_activated', async () => {
    const org = await seedOrg()
    const ev = event('checkout.session.completed', {
      customer: org.customerId,
      client_reference_id: org.orgId,
      metadata: { orgId: org.orgId },
      subscription: subscriptionObject({
        id: 'sub_hook_1', customer: org.customerId, status: 'active', quantity: 3,
        domainItemId: 'si_dom_x', overageItemId: 'si_ovg_x',
      }),
    })

    expect(await applyStripeEvent(deps, ev)).toBe('applied')

    const row = await rowOf(org.orgId)
    expect(row).toMatchObject({
      plan: 'standard', status: 'active',
      stripeSubscriptionId: 'sub_hook_1',
      stripeDomainItemId: 'si_dom_x',
      stripeOverageItemId: 'si_ovg_x',
      domainQuantity: 3,
      cancelAtPeriodEnd: false,
      lastStripeEventCreated: T0,
    })
    expect(row!.currentPeriodStart).toEqual(new Date(T0 * 1000))
    expect(row!.currentPeriodEnd).toEqual(new Date((T0 + 2_592_000) * 1000))

    const audits = await auditsOf(org.orgId, 'billing.subscription_activated')
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({ actor: 'system:stripe.webhook', entityType: 'billing_subscription', entityId: org.orgId })
    expect(audits[0]!.detail).toMatchObject({ eventId: ev.id, subscriptionId: 'sub_hook_1' })
  })

  it('a bare subscription id (what Stripe really sends) is still written; the following customer.subscription.updated fills in the items and period', async () => {
    const org = await seedOrg()
    expect(await applyStripeEvent(deps, event('checkout.session.completed', {
      customer: org.customerId, client_reference_id: org.orgId, subscription: 'sub_bare_1',
      payment_status: 'paid',
    }))).toBe('applied')
    expect(await rowOf(org.orgId)).toMatchObject({ plan: 'standard', status: 'active', stripeSubscriptionId: 'sub_bare_1', domainQuantity: 0 })

    expect(await applyStripeEvent(deps, event('customer.subscription.updated', subscriptionObject({
      id: 'sub_bare_1', customer: org.customerId, status: 'active', quantity: 4,
    }), { created: T0 + 1 }))).toBe('applied')
    expect(await rowOf(org.orgId)).toMatchObject({ domainQuantity: 4, stripeDomainItemId: 'si_domain_1', lastStripeEventCreated: T0 + 1 })
  })

  it('the SAME event id a second time → duplicate (webhook_events), no second audit row', async () => {
    const org = await seedOrg()
    const ev = event('customer.subscription.updated', subscriptionObject({ id: 'sub_dup', customer: org.customerId, status: 'active' }))

    expect(await applyStripeEvent(deps, ev)).toBe('applied')
    expect(await applyStripeEvent(deps, ev)).toBe('duplicate')

    expect(await webhookEventsFor(ev.id)).toHaveLength(1)
    expect((await webhookEventsFor(ev.id))[0]!.envelope).toEqual({ type: ev.type, created: ev.created })
    expect(await auditsOf(org.orgId, 'billing.subscription_updated')).toHaveLength(1)
  })

  it('an event with created < last_stripe_event_created → stale, row untouched', async () => {
    const org = await seedOrg()
    expect(await applyStripeEvent(deps, event('customer.subscription.updated', subscriptionObject({
      id: 'sub_stale', customer: org.customerId, status: 'active', quantity: 7,
    }), { created: T0 + 100 }))).toBe('applied')
    expect(await rowOf(org.orgId)).toMatchObject({ domainQuantity: 7, lastStripeEventCreated: T0 + 100 })

    // An older delivery arriving late must not undo the newer state.
    expect(await applyStripeEvent(deps, event('customer.subscription.updated', subscriptionObject({
      id: 'sub_stale', customer: org.customerId, status: 'past_due', quantity: 1,
    }), { created: T0 + 50 }))).toBe('stale')
    expect(await rowOf(org.orgId)).toMatchObject({ domainQuantity: 7, status: 'active', lastStripeEventCreated: T0 + 100 })
    expect(await billingNotificationsOf(org.orgId)).toEqual([])
  })

  it('customer.subscription.updated with status past_due → status past_due + ONE billing notification (dedupe billing:past_due:<org>:<day>) + notify.dispatch enqueued post-commit; a second past_due event the same day adds no notification', async () => {
    const org = await seedOrg()
    // The dedupe day is the WALL CLOCK's, not the event's — the key rate-limits pages ("at most one
    // per workspace per day"), exactly like `escalationDedupeKey` and `provider_health:` do, so an
    // old event replayed today must still collapse onto today's page.
    const day = new Date().toISOString().slice(0, 10)

    expect(await applyStripeEvent(deps, event('customer.subscription.updated', subscriptionObject({
      id: 'sub_pd', customer: org.customerId, status: 'past_due',
    }), { created: T0 }))).toBe('applied')

    expect(await rowOf(org.orgId)).toMatchObject({ status: 'past_due' })
    const notes = await billingNotificationsOf(org.orgId)
    expect(notes).toHaveLength(1)
    expect(notes[0]).toMatchObject({
      kind: 'billing', title: 'Payment failed',
      body: 'Autopilot is paused until the card is updated. Replies still come to you for review.',
      dedupeKey: `billing:past_due:${org.orgId}:${day}`,
    })
    expect(notes[0]!.payload).toEqual({ state: 'past_due' })

    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ name: JOB_NAMES.notifyDispatch, data: { orgId: org.orgId, notificationId: notes[0]!.id }, opts: { entityId: notes[0]!.id } })

    // Second past_due the same UTC day: the row is already past_due, so there is no transition INTO
    // it — and even if there were, the dedupe key is the same.
    sent.length = 0
    expect(await applyStripeEvent(deps, event('customer.subscription.updated', subscriptionObject({
      id: 'sub_pd', customer: org.customerId, status: 'unpaid',
    }), { created: T0 + 10 }))).toBe('applied')
    expect(await billingNotificationsOf(org.orgId)).toHaveLength(1)
    expect(sent).toEqual([])
  })

  it('customer.subscription.deleted → status canceled, plan trial, cancel_at_period_end false', async () => {
    const org = await seedOrg()
    await applyStripeEvent(deps, event('checkout.session.completed', {
      customer: org.customerId, client_reference_id: org.orgId,
      subscription: subscriptionObject({ id: 'sub_del', customer: org.customerId, status: 'active', cancelAtPeriodEnd: true }),
    }))
    expect(await rowOf(org.orgId)).toMatchObject({ plan: 'standard', status: 'active', cancelAtPeriodEnd: true })

    expect(await applyStripeEvent(deps, event('customer.subscription.deleted', subscriptionObject({
      id: 'sub_del', customer: org.customerId, status: 'canceled', cancelAtPeriodEnd: true,
    }), { created: T0 + 1 }))).toBe('applied')

    expect(await rowOf(org.orgId)).toMatchObject({ plan: 'trial', status: 'canceled', cancelAtPeriodEnd: false })
    expect(await auditsOf(org.orgId, 'billing.subscription_canceled')).toHaveLength(1)
  })

  it('invoice.payment_failed → past_due (+ the same day-deduped page); invoice.paid → active', async () => {
    const org = await seedOrg()
    const invoice = { customer: org.customerId, parent: { subscription_details: { subscription: 'sub_inv' } } }

    expect(await applyStripeEvent(deps, event('invoice.payment_failed', invoice, { created: T0 }))).toBe('applied')
    expect(await rowOf(org.orgId)).toMatchObject({ status: 'past_due', stripeSubscriptionId: 'sub_inv' })
    expect(await billingNotificationsOf(org.orgId)).toHaveLength(1)
    expect(sent).toHaveLength(1)

    sent.length = 0
    expect(await applyStripeEvent(deps, event('invoice.paid', invoice, { created: T0 + 1 }))).toBe('applied')
    // The plan moves too, but ONLY because the invoice names the subscription the row already
    // carries (`sub_inv`, recorded by the payment_failed above). That guard is the whole point: the
    // "foreign invoice" and "row id still null" cases below/above prove an invoice we cannot vouch
    // for never promotes anyone. This is what carries a deferred checkout to standard once the
    // money actually arrives (ruling R10).
    expect(await rowOf(org.orgId)).toMatchObject({ status: 'active', plan: 'standard' })
    expect(sent).toEqual([])

    // Back to past_due the same day: still ONE notification row (the dedupe key is per org per day).
    expect(await applyStripeEvent(deps, event('invoice.payment_failed', invoice, { created: T0 + 2 }))).toBe('applied')
    expect(await billingNotificationsOf(org.orgId)).toHaveLength(1)
  })

  it('an unknown customer → unknown_customer, 200 over HTTP, an alert-level log line', async () => {
    const lines: string[] = []
    const loudDeps: BillingServiceDeps = { ...deps, logger: createAppLogger({ level: 'error', stream: { write: (l: string) => void lines.push(l) } }) }

    expect(await applyStripeEvent(loudDeps, event('customer.subscription.updated', subscriptionObject({
      id: 'sub_nobody', customer: 'cus_never_seen', status: 'active',
    })))).toBe('unknown_customer')

    const line = lines.join('')
    expect(line).toContain('"alert":true')
    expect(line).toContain('stripe_unknown_customer')

    const raw = JSON.stringify(event('customer.subscription.updated', subscriptionObject({
      id: 'sub_nobody2', customer: 'cus_never_seen_2', status: 'active',
    })))
    const res = await t.app.inject({
      method: 'POST', url: '/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': 'valid' },
      payload: raw,
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ outcome: 'unknown_customer' })
  })

  it('an event type this api does not handle, and a payload that does not parse, are both ignored', async () => {
    const org = await seedOrg()
    expect(await applyStripeEvent(deps, event('customer.created', { id: org.customerId }))).toBe('ignored')
    expect(await applyStripeEvent(deps, event('customer.subscription.updated', { customer: 12345 }))).toBe('ignored')
    expect(await rowOf(org.orgId)).toMatchObject({ plan: 'trial', status: 'trialing', lastStripeEventCreated: null })
  })

  it('a checkout for an org with no stored customer claims it through client_reference_id, but never one whose row already names a DIFFERENT customer', async () => {
    const fresh = await seedOrg({ customerId: null as unknown as string })
    await t.api.withOrg(fresh.orgId, (tx) => tx.update(billingSubscriptions)
      .set({ stripeCustomerId: null }).where(eq(billingSubscriptions.orgId, fresh.orgId)))

    expect(await applyStripeEvent(deps, event('checkout.session.completed', {
      customer: 'cus_claimed_1', client_reference_id: fresh.orgId, subscription: 'sub_claim_1',
    }))).toBe('applied')
    expect(await rowOf(fresh.orgId)).toMatchObject({ stripeCustomerId: 'cus_claimed_1', stripeSubscriptionId: 'sub_claim_1' })

    // The row now names cus_claimed_1; a session claiming the same org under a different customer id
    // is refused rather than allowed to re-point the workspace's billing.
    expect(await applyStripeEvent(deps, event('checkout.session.completed', {
      customer: 'cus_attacker', client_reference_id: fresh.orgId, subscription: 'sub_claim_2',
    }))).toBe('unknown_customer')
    expect(await rowOf(fresh.orgId)).toMatchObject({ stripeCustomerId: 'cus_claimed_1', stripeSubscriptionId: 'sub_claim_1' })

    // And a NON-checkout event may not claim by metadata at all.
    expect(await applyStripeEvent(deps, event('customer.subscription.updated', subscriptionObject({
      id: 'sub_meta', customer: 'cus_unknown_meta', status: 'active', orgId: fresh.orgId,
    })))).toBe('unknown_customer')
  })

  // ---- finding 1: items are identified by price, never by position -------------------------

  it('a subscription whose items come back OVERAGE FIRST still lands both ids in the right columns and still updates domainQuantity', async () => {
    const org = await seedOrg()
    expect(await applyStripeEvent(deps, event('customer.subscription.updated', subscriptionObject({
      id: 'sub_order', customer: org.customerId, status: 'active', quantity: 6,
      domainItemId: 'si_dom_ordered', overageItemId: 'si_ovg_ordered', overageFirst: true,
    })))).toBe('applied')

    // Read positionally, this would store the two ids swapped AND silently stop updating the
    // quantity (a metered item carries none), freezing the billed domain count.
    expect(await rowOf(org.orgId)).toMatchObject({
      stripeDomainItemId: 'si_dom_ordered',
      stripeOverageItemId: 'si_ovg_ordered',
      domainQuantity: 6,
    })
  })

  it('a subscription on RETIRED price ids falls back to position and says so at warn — an old subscription stays readable', async () => {
    const org = await seedOrg()
    const lines: string[] = []
    const loud: BillingServiceDeps = { ...deps, logger: createAppLogger({ level: 'warn', stream: { write: (l: string) => void lines.push(l) } }) }

    expect(await applyStripeEvent(loud, event('customer.subscription.updated', subscriptionObject({
      id: 'sub_retired', customer: org.customerId, status: 'active', quantity: 9,
      priceDomain: 'price_retired_domain', priceOverage: 'price_retired_overage',
      domainItemId: 'si_dom_old', overageItemId: 'si_ovg_old',
    })))).toBe('applied')

    expect(await rowOf(org.orgId)).toMatchObject({
      stripeDomainItemId: 'si_dom_old', stripeOverageItemId: 'si_ovg_old', domainQuantity: 9,
    })
    expect(lines.join('')).toContain('stripe.items_read_positionally')
  })

  // ---- finding 2: an invoice speaks only for its own subscription ---------------------------

  it('invoice.paid naming a subscription other than the row`s is ignored — a dunning payment on an old invoice cannot resurrect a canceled workspace', async () => {
    const org = await seedOrg()
    await applyStripeEvent(deps, event('checkout.session.completed', {
      customer: org.customerId, client_reference_id: org.orgId,
      subscription: subscriptionObject({ id: 'sub_current', customer: org.customerId, status: 'active' }),
    }))
    expect(await applyStripeEvent(deps, event('customer.subscription.deleted', subscriptionObject({
      id: 'sub_current', customer: org.customerId, status: 'canceled',
    }), { created: T0 + 1 }))).toBe('applied')
    expect(await rowOf(org.orgId)).toMatchObject({ status: 'canceled', plan: 'trial', stripeSubscriptionId: 'sub_current' })

    // A genuinely NEWER event (so the monotonic guard lets it through) for a DIFFERENT subscription.
    const foreign = { customer: org.customerId, parent: { subscription_details: { subscription: 'sub_someone_elses' } } }
    expect(await applyStripeEvent(deps, event('invoice.paid', foreign, { created: T0 + 99 }))).toBe('ignored')
    expect(await rowOf(org.orgId)).toMatchObject({
      status: 'canceled', plan: 'trial', stripeSubscriptionId: 'sub_current', lastStripeEventCreated: T0 + 1,
    })

    // The matching subscription's own invoice still applies.
    const mine = { customer: org.customerId, parent: { subscription_details: { subscription: 'sub_current' } } }
    expect(await applyStripeEvent(deps, event('invoice.paid', mine, { created: T0 + 100 }))).toBe('applied')
    expect(await rowOf(org.orgId)).toMatchObject({ status: 'active' })
  })

  it('an invoice arriving BEFORE the checkout (the row has no subscription yet) moves the status but NOT the plan', async () => {
    const org = await seedOrg()
    const invoice = { customer: org.customerId, parent: { subscription_details: { subscription: 'sub_early' } } }
    expect(await applyStripeEvent(deps, event('invoice.paid', invoice))).toBe('applied')
    // The legitimate invoice.paid-beats-checkout race: the row had no subscription id to match
    // against, so the promotion guard does not fire and the workspace stays on trial until the
    // checkout (or a subsequent invoice for the now-recorded subscription) says otherwise.
    expect(await rowOf(org.orgId)).toMatchObject({ status: 'active', plan: 'trial', stripeSubscriptionId: 'sub_early' })
  })

  it('ruling R10 — a bare-id checkout.session.completed with payment_status unpaid records the Stripe ids but leaves the workspace on trial, and the matching invoice.paid is what promotes it', async () => {
    const org = await seedOrg()
    const lines: string[] = []
    const loud: BillingServiceDeps = { ...deps, logger: createAppLogger({ level: 'info', stream: { write: (l: string) => void lines.push(l) } }) }

    // The ONLY shape a real completion takes: a bare subscription id (a webhook payload does not
    // honour an `expand` passed at session creation), and a subscription that initialised unpaid.
    expect(await applyStripeEvent(loud, event('checkout.session.completed', {
      customer: org.customerId, client_reference_id: org.orgId,
      subscription: 'sub_deferred', payment_status: 'unpaid',
    }))).toBe('applied')

    // The ids are facts and are recorded; the paid product is not handed over.
    expect(await rowOf(org.orgId)).toMatchObject({
      stripeCustomerId: org.customerId, stripeSubscriptionId: 'sub_deferred',
      plan: 'trial', status: 'trialing',
    })
    expect(lines.join('')).toContain('stripe.checkout_completed_unpaid')

    // The money arrives for THAT subscription — and that is what promotes the workspace.
    const invoice = { customer: org.customerId, parent: { subscription_details: { subscription: 'sub_deferred' } } }
    expect(await applyStripeEvent(deps, event('invoice.paid', invoice, { created: T0 + 1 }))).toBe('applied')
    expect(await rowOf(org.orgId)).toMatchObject({ plan: 'standard', status: 'active' })
  })

  it('a bare-id checkout with payment_status paid (and with no_payment_required) fulfils immediately', async () => {
    for (const [n, paymentStatus] of [['paid', 'paid'], ['free', 'no_payment_required']] as const) {
      const org = await seedOrg()
      expect(await applyStripeEvent(deps, event('checkout.session.completed', {
        customer: org.customerId, client_reference_id: org.orgId,
        subscription: `sub_${n}`, payment_status: paymentStatus,
      }))).toBe('applied')
      expect(await rowOf(org.orgId)).toMatchObject({ plan: 'standard', status: 'active', stripeSubscriptionId: `sub_${n}` })
    }
  })

  it('a payment_status Stripe adds later does not fail the parse — it defers like unpaid rather than losing the checkout', async () => {
    const org = await seedOrg()
    expect(await applyStripeEvent(deps, event('checkout.session.completed', {
      customer: org.customerId, client_reference_id: org.orgId,
      subscription: 'sub_future', payment_status: 'something_stripe_invented',
    }))).toBe('applied')
    expect(await rowOf(org.orgId)).toMatchObject({
      stripeSubscriptionId: 'sub_future', plan: 'trial', status: 'trialing',
    })
  })

  it('checkout.session.completed on an INCOMPLETE subscription records the ids but moves neither the status nor the plan', async () => {
    const org = await seedOrg()
    expect(await applyStripeEvent(deps, event('checkout.session.completed', {
      customer: org.customerId, client_reference_id: org.orgId,
      subscription: subscriptionObject({ id: 'sub_sca', customer: org.customerId, status: 'incomplete', quantity: 2 }),
    }))).toBe('applied')

    // SCA still pending (or the card declined at completion): the workspace must NOT get the paid
    // product yet. The facts are recorded; the state is not moved.
    expect(await rowOf(org.orgId)).toMatchObject({
      plan: 'trial', status: 'trialing',
      stripeSubscriptionId: 'sub_sca', stripeDomainItemId: 'si_domain_1', domainQuantity: 2,
    })

    // The payment then succeeds, and THAT is what promotes the workspace.
    expect(await applyStripeEvent(deps, event('customer.subscription.updated', subscriptionObject({
      id: 'sub_sca', customer: org.customerId, status: 'active', quantity: 2,
    }), { created: T0 + 1 }))).toBe('applied')
    expect(await rowOf(org.orgId)).toMatchObject({ plan: 'standard', status: 'active' })
  })

  // ---- finding 3: two live subscriptions are taken, and paged ------------------------------

  it('a SECOND completed checkout takes the newer subscription id and alerts with BOTH ids so the orphan can be cancelled', async () => {
    const org = await seedOrg()
    const lines: string[] = []
    const loud: BillingServiceDeps = { ...deps, logger: createAppLogger({ level: 'error', stream: { write: (l: string) => void lines.push(l) } }) }

    const completed = (subscriptionId: string, created: number) => event('checkout.session.completed', {
      customer: org.customerId, client_reference_id: org.orgId,
      subscription: subscriptionObject({ id: subscriptionId, customer: org.customerId, status: 'active' }),
    }, { created })

    expect(await applyStripeEvent(loud, completed('sub_first', T0))).toBe('applied')
    expect(lines.join('')).not.toContain('stripe_double_subscription')

    // Two tabs: both sessions complete, Stripe now bills TWO subscriptions.
    expect(await applyStripeEvent(loud, completed('sub_second', T0 + 5))).toBe('applied')

    // Last-write-wins, as everywhere else here — Stripe treats the newer as current.
    expect(await rowOf(org.orgId)).toMatchObject({ stripeSubscriptionId: 'sub_second' })

    // ...but silence is not an option: the line names the orphan AND the survivor.
    const line = lines.join('')
    expect(line).toContain('"alert":true')
    expect(line).toContain('stripe_double_subscription')
    expect(line).toContain('sub_first')
    expect(line).toContain('sub_second')
    expect(line).toContain(org.orgId)
  })

  it('HTTP: a bad signature is 400 and records nothing; the route is 404 when stripe is null; the body reaches constructEvent as the RAW string (assert the fake saw the exact bytes, including whitespace)', async () => {
    const org = await seedOrg()

    // Deliberately ugly whitespace: this exact string is what the signature would cover.
    const ev = event('customer.subscription.updated', subscriptionObject({ id: 'sub_raw', customer: org.customerId, status: 'active', quantity: 5 }))
    const raw = JSON.stringify(ev, null, 2) + '\n'

    const bad = await t.app.inject({
      method: 'POST', url: '/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': 'nope' },
      payload: raw,
    })
    expect(bad.statusCode).toBe(400)
    expect(await webhookEventsFor(ev.id)).toEqual([])
    expect(await rowOf(org.orgId)).toMatchObject({ lastStripeEventCreated: null })
    // The port still saw the untouched bytes on the way to failing.
    expect(fake.rawBodies.at(-1)).toBe(raw)

    const ok = await t.app.inject({
      method: 'POST', url: '/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': 'valid' },
      payload: raw,
    })
    expect(ok.statusCode).toBe(200)
    expect(ok.json()).toEqual({ outcome: 'applied' })
    expect(fake.rawBodies.at(-1)).toBe(raw)
    expect(fake.rawBodies.at(-1)).toContain('\n  "type"')          // pretty-printed, i.e. NOT re-serialized
    expect(await rowOf(org.orgId)).toMatchObject({ domainQuantity: 5 })

    // A missing signature header never reaches the port at all.
    const noSig = await t.app.inject({ method: 'POST', url: '/webhooks/stripe', headers: { 'content-type': 'application/json' }, payload: raw })
    expect(noSig.statusCode).toBe(400)

    // Unconfigured api: the route exists but answers 404, exactly like the Gmail webhook does.
    const off = await createTestApi()
    const gone = await off.app.inject({
      method: 'POST', url: '/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': 'valid' }, payload: raw,
    })
    expect(gone.statusCode).toBe(404)
    await off.close()
  })

  it('every other route still gets PARSED json — the raw parser is scoped to the webhook alone', async () => {
    // /api/auth/* is the loudest neighbour: server.ts's app-wide parser hands it an object, and
    // Better Auth's bridge re-serializes `request.body`. If the raw parser had leaked out of its
    // register(), this sign-in would post the string `"[object Object]"` and fail.
    const signed = await signInWithOtp(t.app, t.mail, `billing-hook-scope@example.com`, 'Owner')
    expect(signed.cookie).toBeTruthy()
  })
})
