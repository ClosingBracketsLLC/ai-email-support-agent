/**
 * The billing service (`src/billing/service.ts`) driven directly — the ONE implementation the
 * `billing` router calls (`billing-router.test.ts` covers the wire). Everything here is about what a
 * transaction writes, what reaches Stripe, and above all WHEN: the discipline this module exists to
 * keep is that a `withOrg` transaction never spans a network call (CLAUDE.md, Transactions).
 *
 * That last one is asserted, not assumed: `fake.onCall.createCheckoutSession` reads the billing row
 * back through an INDEPENDENT connection at the moment the Stripe call starts. Seeing the customer
 * id there proves the write transaction had already committed — if the service held it open across
 * the call, that read would see `null` (or block until the pool timed it out).
 */
import { eq } from 'drizzle-orm'
import { createTRPCClient, httpBatchLink } from '@trpc/client'
import superjson from 'superjson'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { BILLING_PRICING } from '@aesa/contracts'
import { auditLog, billingSubscriptions } from '@aesa/db'
import type { EnqueueFn } from '../src/deps.ts'
import { getBilling, openPortal, setOverageMode, startCheckout, type BillingActor, type BillingServiceDeps } from '../src/billing/service.ts'
import { createAppLogger } from '../src/logging.ts'
import type { AppRouter } from '../src/trpc/router.ts'
import { WEB, createTestApi, insertAgent, insertConnectedMailbox, listen, signInWithOtp } from './helpers/app.ts'
import { callsTo, createFakeStripe, type FakeStripe } from './helpers/fake-stripe.ts'

const client = (base: string, cookie?: string) => createTRPCClient<AppRouter>({
  links: [httpBatchLink({ url: `${base}/trpc`, transformer: superjson, headers: () => ({ origin: WEB, ...(cookie ? { cookie } : {}) }) })],
})

interface Recorded { name: string; data: Record<string, unknown>; opts: { entityId: string } }

/** The two configured price ids. Only the webhook reads them, but they ride on the same deps. */
const PRICE_DOMAIN = 'price_domain_cfg'
const PRICE_OVERAGE = 'price_overage_cfg'

describe('billing service', () => {
  let t: Awaited<ReturnType<typeof createTestApi>>
  let base: string
  let fake: FakeStripe
  let deps: BillingServiceDeps
  let sent: Recorded[]
  let seq = 0

  beforeAll(async () => {
    t = await createTestApi()
    base = await listen(t.app)
    sent = []
    fake = createFakeStripe()
    const enqueue: EnqueueFn = async (name, data, opts) => { sent.push({ name, data, opts }); return `job-${sent.length}` }
    deps = {
      api: t.api, enqueue, logger: createAppLogger({ level: 'silent' }),
      stripe: fake.port, appWebOrigin: WEB,
      priceDomain: PRICE_DOMAIN, priceOverage: PRICE_OVERAGE,
    }
  })
  afterAll(async () => { await t.close() })
  beforeEach(() => {
    sent.length = 0
    fake.calls.length = 0
    fake.rawBodies.length = 0
    fake.failing.clear()
    for (const k of Object.keys(fake.onCall)) delete fake.onCall[k as keyof FakeStripe['onCall']]
  })

  async function seedOrg() {
    const n = ++seq
    const email = `billing-svc-${n}@example.com`
    const signed = await signInWithOtp(t.app, t.mail, email, 'Owner')
    const c = client(base, signed.cookie)
    const { orgId } = await c.workspace.create.mutate({ businessName: `Acme ${n}`, timezone: 'UTC' })
    const actor: BillingActor = { userId: signed.user.id, actor: `user:${signed.user.id}`, email, ip: '127.0.0.1', userAgent: 'vitest' }
    return { orgId, c, actor, email, userId: signed.user.id, seq: n }
  }

  const rowOf = async (orgId: string) => {
    const [row] = await t.api.withOrg(orgId, (tx) => tx.select().from(billingSubscriptions).where(eq(billingSubscriptions.orgId, orgId)))
    return row
  }
  const auditsOf = (orgId: string, action: string) =>
    t.api.withOrg(orgId, (tx) => tx.select().from(auditLog).where(eq(auditLog.action, action)))

  // -------------------------------------------------------------------------

  it('getBilling on a fresh workspace: trial, trialing, allowance 50, used 0, period = this UTC month, configured true, hasStripeCustomer false', async () => {
    const org = await seedOrg()
    const now = new Date()

    const view = await getBilling(deps, org.orgId)

    expect(view).toMatchObject({
      plan: 'trial',
      state: 'trialing',
      trialEndsAt: null,
      domainQuantity: 0,
      allowance: BILLING_PRICING.trialIncludedConversations,
      used: 0,
      overageUnits: 0,
      overageMode: 'automatic',
      overageUnitCents: BILLING_PRICING.overageUnitCents,
      perDomainCents: BILLING_PRICING.perDomainCents,
      hasStripeCustomer: false,
      hasSubscription: false,
      cancelAtPeriodEnd: false,
      configured: true,
      activeDomains: 0,
    })
    expect(view.allowance).toBe(50)
    expect(view.periodStart).toEqual(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)))
    expect(view.periodEnd).toEqual(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)))

    // `configured` is the api's own STRIPE_* state, nothing to do with the workspace.
    expect(await getBilling({ ...deps, stripe: null }, org.orgId)).toMatchObject({ configured: false })
  })

  it('startCheckout: creates the customer with metadata.orgId and the owner email OUTSIDE the transaction, writes stripe_customer_id guarded on NULL, creates a subscription-mode session with the domain line (quantity max(1, active domains)) and the overage line, success/cancel URLs under appWebOrigin/settings/billing, audits billing.checkout_started; a second call reuses the customer (one createCustomer call total)', async () => {
    const org = await seedOrg()
    const connectionId = await insertConnectedMailbox(t.api, org.orgId, org.userId, `support${org.seq}@one.test`)
    await insertAgent(t.api, org.orgId, connectionId, `support${org.seq}@one.test`)
    await insertAgent(t.api, org.orgId, connectionId, `help${org.seq}@two.test`)

    // Proof that no transaction is held across the network call: an INDEPENDENT connection can
    // already see the committed customer id by the time the checkout session is created.
    let seenMidFlight: string | null | undefined
    fake.onCall.createCheckoutSession = async () => { seenMidFlight = (await rowOf(org.orgId))?.stripeCustomerId }

    const res = await startCheckout(deps, org.orgId, org.actor)
    expect(res).toEqual({ ok: true, url: expect.stringContaining('https://checkout.stripe.test/') })

    const created = callsTo(fake, 'createCustomer')
    expect(created).toHaveLength(1)
    expect(created[0]!.params).toEqual({ email: org.email, name: `Acme ${org.seq}`, orgId: org.orgId })

    const row = await rowOf(org.orgId)
    expect(row!.stripeCustomerId).toBe('cus_fake_1')
    expect(seenMidFlight).toBe('cus_fake_1')

    const sessions = callsTo(fake, 'createCheckoutSession')
    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.params).toEqual({
      customerId: 'cus_fake_1', orgId: org.orgId, domainQuantity: 2,
      successUrl: expect.stringContaining(`${WEB}/settings/billing`),
      cancelUrl: expect.stringContaining(`${WEB}/settings/billing`),
    })

    const audits = await auditsOf(org.orgId, 'billing.checkout_started')
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({ actor: `user:${org.userId}`, entityType: 'billing_subscription', entityId: org.orgId })
    expect(audits[0]!.detail).toMatchObject({ domainQuantity: 2 })

    // Second call: the stored customer is reused, so Stripe is asked for a session only.
    const again = await startCheckout(deps, org.orgId, org.actor)
    expect(again).toMatchObject({ ok: true })
    expect(callsTo(fake, 'createCustomer')).toHaveLength(1)
    expect(callsTo(fake, 'createCheckoutSession')).toHaveLength(2)
  })

  it('startCheckout with no active agent still bills one domain (quantity max(1, 0))', async () => {
    const org = await seedOrg()
    expect(await startCheckout(deps, org.orgId, org.actor)).toMatchObject({ ok: true })
    expect(callsTo(fake, 'createCheckoutSession')[0]!.params).toMatchObject({ domainQuantity: 1 })
  })

  it('startCheckout when status is active → already_subscribed; when deps.stripe is null → not_configured; when the fake throws → stripe_unavailable and NO row change', async () => {
    const org = await seedOrg()

    expect(await startCheckout({ ...deps, stripe: null }, org.orgId, org.actor)).toEqual({ ok: false, code: 'not_configured' })
    expect(await rowOf(org.orgId)).toMatchObject({ stripeCustomerId: null })

    fake.failing.add('createCustomer')
    expect(await startCheckout(deps, org.orgId, org.actor)).toEqual({ ok: false, code: 'stripe_unavailable' })
    expect(await rowOf(org.orgId)).toMatchObject({ stripeCustomerId: null })
    expect(await auditsOf(org.orgId, 'billing.checkout_started')).toEqual([])
    fake.failing.clear()

    // A failure AFTER the customer is stored leaves the customer behind (it is reused next time) but
    // still writes no audit row and no session.
    fake.failing.add('createCheckoutSession')
    expect(await startCheckout(deps, org.orgId, org.actor)).toEqual({ ok: false, code: 'stripe_unavailable' })
    expect((await rowOf(org.orgId))!.stripeCustomerId).toMatch(/^cus_fake_/)
    expect(await auditsOf(org.orgId, 'billing.checkout_started')).toEqual([])
    fake.failing.clear()

    await t.api.withOrg(org.orgId, (tx) => tx.update(billingSubscriptions)
      .set({ status: 'active', plan: 'standard', stripeSubscriptionId: 'sub_live_1' })
      .where(eq(billingSubscriptions.orgId, org.orgId)))
    expect(await startCheckout(deps, org.orgId, org.actor)).toEqual({ ok: false, code: 'already_subscribed' })

    // past_due is "already subscribed" too — the remedy is the Portal, not a second subscription.
    await t.api.withOrg(org.orgId, (tx) => tx.update(billingSubscriptions)
      .set({ status: 'past_due' }).where(eq(billingSubscriptions.orgId, org.orgId)))
    expect(await startCheckout(deps, org.orgId, org.actor)).toEqual({ ok: false, code: 'already_subscribed' })

    // A CANCELED subscription may subscribe again.
    await t.api.withOrg(org.orgId, (tx) => tx.update(billingSubscriptions)
      .set({ status: 'canceled' }).where(eq(billingSubscriptions.orgId, org.orgId)))
    expect(await startCheckout(deps, org.orgId, org.actor)).toMatchObject({ ok: true })
  })

  it('ruling R30 — a subscription id on a TRIALING row is a Checkout still pending (checkout_pending), never a second session; an expired trial or a canceled row with no id may subscribe', async () => {
    const org = await seedOrg()
    // R10's deferred state: an unpaid checkout.session.completed recorded the id, the plan is still trial.
    await t.api.withOrg(org.orgId, (tx) => tx.update(billingSubscriptions)
      .set({ stripeCustomerId: 'cus_pending_1', stripeSubscriptionId: 'sub_pending_1' })
      .where(eq(billingSubscriptions.orgId, org.orgId)))
    fake.calls.length = 0
    expect(await startCheckout(deps, org.orgId, org.actor)).toEqual({ ok: false, code: 'checkout_pending' })
    expect(fake.calls).toEqual([])
    expect(await auditsOf(org.orgId, 'billing.checkout_started')).toEqual([])

    // Once the webhook forgets the dead subscription (R30), Checkout is open again.
    await t.api.withOrg(org.orgId, (tx) => tx.update(billingSubscriptions)
      .set({ stripeSubscriptionId: null }).where(eq(billingSubscriptions.orgId, org.orgId)))
    expect(await startCheckout(deps, org.orgId, org.actor)).toMatchObject({ ok: true })
  })

  it('openPortal without a customer → no_customer; with one → a url under return_url = appWebOrigin/settings/billing', async () => {
    const org = await seedOrg()

    expect(await openPortal({ ...deps, stripe: null }, org.orgId, org.actor)).toEqual({ ok: false, code: 'not_configured' })
    expect(await openPortal(deps, org.orgId, org.actor)).toEqual({ ok: false, code: 'no_customer' })

    await startCheckout(deps, org.orgId, org.actor)
    const customerId = (await rowOf(org.orgId))!.stripeCustomerId

    const res = await openPortal(deps, org.orgId, org.actor)
    expect(res).toEqual({ ok: true, url: expect.stringContaining('https://portal.stripe.test/') })
    expect(callsTo(fake, 'createPortalSession')[0]!.params).toEqual({ customerId, returnUrl: `${WEB}/settings/billing` })
    expect(await auditsOf(org.orgId, 'billing.portal_opened')).toHaveLength(1)

    fake.failing.add('createPortalSession')
    expect(await openPortal(deps, org.orgId, org.actor)).toEqual({ ok: false, code: 'stripe_unavailable' })
  })

  it('setOverageMode writes the row and audits', async () => {
    const org = await seedOrg()
    expect((await rowOf(org.orgId))!.overageMode).toBe('automatic')

    expect(await setOverageMode(deps, org.orgId, { mode: 'blocked' }, org.actor)).toEqual({ ok: true })
    expect((await rowOf(org.orgId))!.overageMode).toBe('blocked')
    expect(await getBilling(deps, org.orgId)).toMatchObject({ overageMode: 'blocked' })

    const audits = await auditsOf(org.orgId, 'billing.overage_mode_set')
    expect(audits).toHaveLength(1)
    expect(audits[0]!.detail).toMatchObject({ mode: 'blocked' })

    expect(await setOverageMode(deps, org.orgId, { mode: 'automatic' }, org.actor)).toEqual({ ok: true })
    expect((await rowOf(org.orgId))!.overageMode).toBe('automatic')
  })
})
