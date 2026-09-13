/**
 * The `billing` router over real HTTP: the thin code-to-`TRPCError` layer on top of
 * `src/billing/service.ts` (`billing-service.test.ts` drives the service itself). Two things this
 * file is here for:
 *  - the permission boundary. Seeing what the workspace is on is every teammate's business
 *    (`orgProcedure`); spending money is the OWNER's alone (`ownerProcedure`) — an ADMIN, who may
 *    manage every other part of the workspace, is FORBIDDEN here;
 *  - the soft codes landing on the right tRPC codes with the right `BILLING_ERROR_MESSAGES` text,
 *    which is what the Billing screen keys its own copy on.
 */
import { createTRPCClient, httpBatchLink } from '@trpc/client'
import { eq } from 'drizzle-orm'
import superjson from 'superjson'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { BILLING_ERROR_MESSAGES, BILLING_PRICING } from '@aesa/contracts'
import { billingSubscriptions } from '@aesa/db'
import type { AppRouter } from '../src/trpc/router.ts'
import { WEB, createTestApi, listen, signInWithOtp } from './helpers/app.ts'
import { createFakeStripe, type FakeStripe } from './helpers/fake-stripe.ts'

const client = (base: string, cookie?: string) => createTRPCClient<AppRouter>({
  links: [httpBatchLink({ url: `${base}/trpc`, transformer: superjson, headers: () => ({ origin: WEB, ...(cookie ? { cookie } : {}) }) })],
})

/** tRPC's client throws a TRPCClientError; this pulls the two fields every case below asserts on. */
async function caught(fn: () => Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await fn()
  } catch (e) {
    const err = e as { message: string; data?: { code?: string } }
    return { code: err.data?.code ?? 'UNKNOWN', message: err.message }
  }
  throw new Error('expected a rejection')
}

describe('billing router', () => {
  let t: Awaited<ReturnType<typeof createTestApi>>
  let base: string
  let fake: FakeStripe
  let seq = 0

  beforeAll(async () => {
    fake = createFakeStripe()
    t = await createTestApi({}, { stripe: fake.port })
    base = await listen(t.app)
  })
  afterAll(async () => { await t.close() })
  beforeEach(() => { fake.calls.length = 0; fake.failing.clear() })

  /** An owner with a workspace, plus an invited teammate at `role` who has that workspace active. */
  async function setupOrg(role: 'admin' | 'member' = 'admin') {
    const n = ++seq
    const owner = await signInWithOtp(t.app, t.mail, `billing-rtr-owner-${n}@example.com`, 'Owner')
    const ownerClient = client(base, owner.cookie)
    const { orgId } = await ownerClient.workspace.create.mutate({ businessName: `Acme ${n}`, timezone: 'UTC' })

    // Better Auth owns acceptance and the active-organization flip — the same two injects
    // `team.test.ts` uses, since neither has a tRPC procedure.
    const mateEmail = `billing-rtr-mate-${n}@example.com`
    const { invitationId } = await ownerClient.team.invite.mutate({ email: mateEmail, role })
    const mate = await signInWithOtp(t.app, t.mail, mateEmail, 'Mate')
    const headers = { origin: WEB, cookie: mate.cookie, 'content-type': 'application/json' }
    const accepted = await t.app.inject({ method: 'POST', url: '/api/auth/organization/accept-invitation', headers, payload: { invitationId } })
    expect(accepted.statusCode).toBe(200)
    await t.app.inject({ method: 'POST', url: '/api/auth/organization/set-active', headers, payload: { organizationId: orgId } })
    const mateClient = client(base, mate.cookie)

    return { orgId, ownerClient, mateClient, owner, n }
  }

  it('billing.get is readable by any member; startCheckout / openPortal / setOverageMode are the owner`s alone (ownerProcedure)', async () => {
    const org = await setupOrg('admin')

    const view = await org.mateClient.billing.get.query()
    expect(view).toMatchObject({
      plan: 'trial', state: 'trialing', allowance: BILLING_PRICING.trialIncludedConversations,
      used: 0, configured: true, hasStripeCustomer: false,
    })

    // An ADMIN can manage everything else in the workspace; billing is still the owner's.
    expect(await caught(() => org.mateClient.billing.startCheckout.mutate())).toMatchObject({ code: 'FORBIDDEN' })
    expect(await caught(() => org.mateClient.billing.openPortal.mutate())).toMatchObject({ code: 'FORBIDDEN' })
    expect(await caught(() => org.mateClient.billing.setOverageMode.mutate({ mode: 'blocked' }))).toMatchObject({ code: 'FORBIDDEN' })
    expect(fake.calls).toEqual([])

    const started = await org.ownerClient.billing.startCheckout.mutate()
    expect(started.url).toMatch(/^https:\/\/checkout\.stripe\.test\//)

    const portal = await org.ownerClient.billing.openPortal.mutate()
    expect(portal.url).toMatch(/^https:\/\/portal\.stripe\.test\//)

    expect(await org.ownerClient.billing.setOverageMode.mutate({ mode: 'blocked' })).toEqual({ ok: true })
    expect(await org.ownerClient.billing.get.query()).toMatchObject({ overageMode: 'blocked' })
  })

  it('a plain member can read billing too — it is the workspace`s state, not a secret', async () => {
    const org = await setupOrg('member')
    expect(await org.mateClient.billing.get.query()).toMatchObject({ plan: 'trial' })
    expect(await caught(() => org.mateClient.billing.startCheckout.mutate())).toMatchObject({ code: 'FORBIDDEN' })
  })

  it('the soft codes map to PRECONDITION_FAILED (not_configured, already_subscribed, no_customer) and BAD_GATEWAY (stripe_unavailable), with BILLING_ERROR_MESSAGES', async () => {
    const org = await setupOrg()

    expect(await caught(() => org.ownerClient.billing.openPortal.mutate()))
      .toEqual({ code: 'PRECONDITION_FAILED', message: BILLING_ERROR_MESSAGES.no_customer })

    fake.failing.add('createCustomer')
    expect(await caught(() => org.ownerClient.billing.startCheckout.mutate()))
      .toEqual({ code: 'BAD_GATEWAY', message: BILLING_ERROR_MESSAGES.stripe_unavailable })
    fake.failing.clear()

    await t.api.withOrg(org.orgId, (tx) => tx.update(billingSubscriptions)
      .set({ status: 'active', plan: 'standard', stripeSubscriptionId: 'sub_rtr_1' })
      .where(eq(billingSubscriptions.orgId, org.orgId)))
    expect(await caught(() => org.ownerClient.billing.startCheckout.mutate()))
      .toEqual({ code: 'PRECONDITION_FAILED', message: BILLING_ERROR_MESSAGES.already_subscribed })
  })

  it('an api with no STRIPE_* reports configured:false and refuses both paid paths with not_configured', async () => {
    const off = await createTestApi()
    const offBase = await listen(off.app)
    const signed = await signInWithOtp(off.app, off.mail, 'billing-rtr-off@example.com', 'Owner')
    const c = client(offBase, signed.cookie)
    await c.workspace.create.mutate({ businessName: 'Unconfigured', timezone: 'UTC' })

    expect(await c.billing.get.query()).toMatchObject({ configured: false })
    expect(await caught(() => c.billing.startCheckout.mutate()))
      .toEqual({ code: 'PRECONDITION_FAILED', message: BILLING_ERROR_MESSAGES.not_configured })
    expect(await caught(() => c.billing.openPortal.mutate()))
      .toEqual({ code: 'PRECONDITION_FAILED', message: BILLING_ERROR_MESSAGES.not_configured })

    // /meta tells the app the same thing before it renders a Subscribe button at all.
    expect((await off.app.inject({ method: 'GET', url: '/meta' })).json()).toMatchObject({ billing: false })
    await off.close()
  })

  it('/meta reports billing: true when the port is configured', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/meta' })).json()).toMatchObject({ billing: true })
  })
})
