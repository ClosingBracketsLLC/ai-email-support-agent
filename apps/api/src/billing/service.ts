/**
 * Settings › Billing as ONE service module, mirroring `src/llm/service.ts` and
 * `src/knowledge/service.ts`: every procedure is a plain exported async function
 * `(deps, orgId, …) => result`, a soft outcome is a typed `{ ok: false; code }` (never a thrown
 * error), and `trpc/routers/billing.ts` does nothing but map those codes onto `TRPCError`s. The
 * webhook (`./webhook.ts`) shares these deps so the Phase 7 E2E can drive both halves directly.
 *
 * Discipline every function here keeps (CLAUDE.md):
 *  - ONE `withOrg` transaction per read or write, NEVER spanning a Stripe call. `startCheckout` is
 *    therefore three short transactions with the two network calls BETWEEN them, not one long one:
 *    a transaction that awaited Stripe would hold its row locks for the whole round trip and blow
 *    through the app role's 5 s idle-in-transaction timeout on a slow one.
 *  - every write is guarded on what it was read at (`stripe_customer_id IS NULL`), so two owners
 *    tapping Subscribe at once cannot overwrite each other — the loser re-reads the winner's id.
 *  - the Stripe keys live in `config.stripe` and reach only `createStripePort`; nothing here can see
 *    one, and nothing Stripe returns beyond an id and a URL is ever stored or logged.
 *
 * Lock order: the only row any of this touches is `billing_subscriptions`, which is not one of the
 * four ordered row kinds, so the global lock order is not engaged.
 */
import { and, eq, isNull } from 'drizzle-orm'
import type pino from 'pino'
import { BILLING_PRICING, type BillingView, type SetOverageModeInput } from '@aesa/contracts'
import { overageOf } from '@aesa/core'
import {
  audit, billingSubscriptions, countActiveDomains, countManagedConversations, ensureBillingRow, readBillingState,
  workspaces, type AuditActor,
} from '@aesa/db'
import type { ApiFacade, EnqueueFn } from '../deps.ts'
import type { StripePort } from './stripe.ts'

export interface BillingServiceDeps {
  api: ApiFacade
  enqueue: EnqueueFn
  logger: pino.Logger
  /** null when STRIPE_* is unconfigured (every dev box without keys) — every paid path soft-refuses. */
  stripe: StripePort | null
  /** The Expo web origin: the base of Checkout's success/cancel URLs and the Portal's return URL. */
  appWebOrigin: string
  /** The two configured price ids (`config.stripe`), null when `STRIPE_*` is unset. `startCheckout`
   *  never needs them — the port holds its own copy for the line items — but the WEBHOOK does: it is
   *  how `selectItems` tells the licensed domain item from the metered overage item, instead of
   *  trusting the order Stripe happened to return them in. */
  priceDomain: string | null
  priceOverage: string | null
  /** Test seam; production leaves it unset and reads the wall clock per call. */
  now?: () => Date
}

/** Who is acting. `email` is the signed-in owner's — what a new Stripe customer is created with. */
export interface BillingActor {
  userId: string
  actor: AuditActor
  email: string | null
  ip?: string | null
  userAgent?: string | null
}

const clock = (deps: BillingServiceDeps): Date => deps.now?.() ?? new Date()

/** Both Checkout outcomes and the Portal return land the owner back on the same screen; the query
 *  parameter is only there for the screen's own "thanks, we're setting it up" banner. */
const billingUrl = (deps: BillingServiceDeps, suffix = ''): string => `${deps.appWebOrigin}/settings/billing${suffix}`

// ---------------------------------------------------------------------------
// the read
// ---------------------------------------------------------------------------

/** `BillingView` plus the LIVE active-domain count — the screen shows it beside the BILLED
 *  `domainQuantity` when they differ, which is the owner's cue that a newly connected domain has
 *  not been picked up by the nightly quantity sync yet. */
export interface BillingSummary extends BillingView {
  activeDomains: number
}

export async function getBilling(deps: BillingServiceDeps, orgId: string): Promise<BillingSummary> {
  const now = clock(deps)
  return deps.api.withOrg(orgId, async (tx) => {
    const state = await readBillingState(tx, now)
    const used = await countManagedConversations(tx, state.period)
    const activeDomains = await countActiveDomains(tx)
    return {
      plan: state.plan,
      state: state.state,
      trialEndsAt: state.trialEndsAt,
      domainQuantity: state.domainQuantity,
      allowance: state.allowance,
      used,
      overageUnits: overageOf(used, state.allowance),
      periodStart: state.period.start,
      periodEnd: state.period.end,
      overageMode: state.overageMode,
      overageUnitCents: state.overageUnitCents,
      perDomainCents: BILLING_PRICING.perDomainCents,
      hasStripeCustomer: state.stripeCustomerId !== null,
      hasSubscription: state.stripeSubscriptionId !== null,
      cancelAtPeriodEnd: state.cancelAtPeriodEnd,
      configured: deps.stripe !== null,
      activeDomains,
    }
  })
}

// ---------------------------------------------------------------------------
// Checkout
// ---------------------------------------------------------------------------

export type StartCheckoutResult =
  | { ok: true; url: string }
  | { ok: false; code: 'not_configured' | 'already_subscribed' | 'stripe_unavailable' }

export async function startCheckout(deps: BillingServiceDeps, orgId: string, actor: BillingActor): Promise<StartCheckoutResult> {
  const stripe = deps.stripe
  if (!stripe) return { ok: false, code: 'not_configured' }
  const now = clock(deps)

  // tx 1 — everything Stripe needs to be asked, read in one go.
  const read = await deps.api.withOrg(orgId, async (tx) => {
    const state = await readBillingState(tx, now)
    const activeDomains = await countActiveDomains(tx)
    const [ws] = await tx.select({ businessName: workspaces.businessName }).from(workspaces).where(eq(workspaces.orgId, orgId))
    return { state, activeDomains, businessName: ws?.businessName ?? 'Workspace' }
  })

  // A live subscription (or one whose card just failed) is managed through the Portal, never by
  // starting a second Checkout — a `canceled` one may subscribe again.
  if (read.state.stripeSubscriptionId !== null && (read.state.state === 'active' || read.state.state === 'past_due')) {
    return { ok: false, code: 'already_subscribed' }
  }

  let customerId = read.state.stripeCustomerId
  if (!customerId) {
    let created: { id: string }
    try {
      created = await stripe.createCustomer({ email: actor.email, name: read.businessName, orgId })
    } catch (err) {
      deps.logger.warn({ err, orgId }, 'billing.create_customer_failed')
      return { ok: false, code: 'stripe_unavailable' }
    }

    // tx 2 — guarded on NULL, so a concurrent Subscribe cannot clobber the id the other tap stored.
    // `ensureBillingRow` first: a workspace created before Phase 7 has no row for the UPDATE to hit.
    customerId = await deps.api.withOrg(orgId, async (tx) => {
      await ensureBillingRow(tx)
      const claimed = await tx.update(billingSubscriptions)
        .set({ stripeCustomerId: created.id })
        .where(and(eq(billingSubscriptions.orgId, orgId), isNull(billingSubscriptions.stripeCustomerId)))
        .returning({ stripeCustomerId: billingSubscriptions.stripeCustomerId })
      if (claimed[0]?.stripeCustomerId) return claimed[0].stripeCustomerId
      const [winner] = await tx.select({ stripeCustomerId: billingSubscriptions.stripeCustomerId })
        .from(billingSubscriptions).where(eq(billingSubscriptions.orgId, orgId))
      return winner?.stripeCustomerId ?? created.id
    })

    if (customerId !== created.id) {
      // The customer we just created is now orphaned in Stripe: nothing references it and nothing
      // will bill it. Logged rather than deleted — an api that deletes Stripe objects on a race is a
      // worse failure mode than one that leaves a stray empty customer for an operator to sweep.
      deps.logger.warn({ orgId, orphanedCustomerId: created.id, customerId }, 'billing.orphaned_stripe_customer')
    }
  }

  const domainQuantity = Math.max(1, read.activeDomains)
  let session: { url: string }
  try {
    session = await stripe.createCheckoutSession({
      customerId, orgId, domainQuantity,
      successUrl: billingUrl(deps, '?checkout=success'),
      cancelUrl: billingUrl(deps, '?checkout=cancelled'),
    })
  } catch (err) {
    deps.logger.warn({ err, orgId }, 'billing.create_checkout_session_failed')
    return { ok: false, code: 'stripe_unavailable' }
  }

  // tx 3 — the paper trail. Never the session URL: it is a bearer link to a payment page.
  await deps.api.withOrg(orgId, (tx) => audit(tx, {
    actor: actor.actor, action: 'billing.checkout_started', entityType: 'billing_subscription', entityId: orgId,
    detail: { domainQuantity }, ip: actor.ip, userAgent: actor.userAgent,
  }))

  return { ok: true, url: session.url }
}

// ---------------------------------------------------------------------------
// the Customer Portal
// ---------------------------------------------------------------------------

export type OpenPortalResult =
  | { ok: true; url: string }
  | { ok: false; code: 'not_configured' | 'no_customer' | 'stripe_unavailable' }

export async function openPortal(deps: BillingServiceDeps, orgId: string, actor: BillingActor): Promise<OpenPortalResult> {
  const stripe = deps.stripe
  if (!stripe) return { ok: false, code: 'not_configured' }
  const now = clock(deps)

  const customerId = await deps.api.withOrg(orgId, async (tx) => (await readBillingState(tx, now)).stripeCustomerId)
  if (!customerId) return { ok: false, code: 'no_customer' }

  let session: { url: string }
  try {
    session = await stripe.createPortalSession({ customerId, returnUrl: billingUrl(deps) })
  } catch (err) {
    deps.logger.warn({ err, orgId }, 'billing.create_portal_session_failed')
    return { ok: false, code: 'stripe_unavailable' }
  }

  await deps.api.withOrg(orgId, (tx) => audit(tx, {
    actor: actor.actor, action: 'billing.portal_opened', entityType: 'billing_subscription', entityId: orgId,
    detail: {}, ip: actor.ip, userAgent: actor.userAgent,
  }))

  return { ok: true, url: session.url }
}

// ---------------------------------------------------------------------------
// the overage switch
// ---------------------------------------------------------------------------

/** Purely local state: `automatic` lets metered overage accrue past the allowance, `blocked` stops
 *  Managed-AI sending there instead (`@aesa/core`'s `isAllowanceExhausted`). Stripe is not involved —
 *  the metered price stays on the subscription either way, it simply reports nothing. */
export async function setOverageMode(
  deps: BillingServiceDeps, orgId: string, input: SetOverageModeInput, actor: BillingActor,
): Promise<{ ok: true }> {
  await deps.api.withOrg(orgId, async (tx) => {
    await ensureBillingRow(tx)
    await tx.update(billingSubscriptions).set({ overageMode: input.mode }).where(eq(billingSubscriptions.orgId, orgId))
    await audit(tx, {
      actor: actor.actor, action: 'billing.overage_mode_set', entityType: 'billing_subscription', entityId: orgId,
      detail: { mode: input.mode }, ip: actor.ip, userAgent: actor.userAgent,
    })
  })
  return { ok: true }
}
