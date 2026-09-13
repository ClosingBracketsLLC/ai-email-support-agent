/**
 * The `billing` router: input → `src/billing/service.ts` → tRPC error mapping, and nothing else —
 * mirrors `routers/llm.ts` and `routers/memory.ts`. What the workspace is on, what it has used and
 * what it will cost is every teammate's business (`orgProcedure`); putting a card on file, opening
 * the Customer Portal (from which the subscription can be cancelled) and turning metered overage on
 * are the OWNER's alone (`ownerProcedure` — an admin manages the workspace, not its money).
 *
 * Every `switch` here is exhaustive with NO `default`, so a new soft code in the service is a
 * compile error rather than a silent 500; every message comes from `BILLING_ERROR_MESSAGES` in
 * `@aesa/contracts`, which is what the Billing screen keys its own copy on.
 */
import { TRPCError } from '@trpc/server'
import { BILLING_ERROR_MESSAGES, SetOverageModeInput } from '@aesa/contracts'
import type { AuditActor } from '@aesa/db'
import type pino from 'pino'
import type { StripePort } from '../../billing/stripe.ts'
import {
  getBilling, openPortal, setOverageMode, startCheckout,
  type BillingActor, type BillingServiceDeps,
} from '../../billing/service.ts'
import type { ApiFacade, EnqueueFn } from '../../deps.ts'
import { orgProcedure, ownerProcedure, router } from '../init.ts'

/** The slice of the tRPC context the service needs — structural, so the real context just satisfies it. */
interface BillingContext {
  deps: {
    api: ApiFacade; enqueue: EnqueueFn; logger: pino.Logger
    stripe: StripePort | null
    config: { appWebOrigin: string; stripe: { priceDomain: string; priceOverage: string } | null }
  }
  user: { id: string; email: string }
  actor: AuditActor
  ip: string
  userAgent: string | null
}

const serviceDeps = (ctx: BillingContext): BillingServiceDeps => ({
  api: ctx.deps.api, enqueue: ctx.deps.enqueue, logger: ctx.deps.logger,
  stripe: ctx.deps.stripe, appWebOrigin: ctx.deps.config.appWebOrigin,
  // Unused by every procedure in this router — the webhook is what reads them (see
  // `BillingServiceDeps`) — but they belong to the same deps object, so they are filled in here too.
  priceDomain: ctx.deps.config.stripe?.priceDomain ?? null,
  priceOverage: ctx.deps.config.stripe?.priceOverage ?? null,
})

/** The signed-in owner's email is what a brand-new Stripe customer is created with — Stripe emails
 *  receipts and dunning notices to it, so it must be a person, not a workspace alias. */
const appActor = (ctx: BillingContext): BillingActor => ({
  userId: ctx.user.id, actor: ctx.actor, email: ctx.user.email ?? null, ip: ctx.ip, userAgent: ctx.userAgent,
})

/** `not_configured`, `already_subscribed` and `no_customer` are all states of the server or the
 *  workspace that a different action clears (configure Stripe; use the Portal; subscribe first) —
 *  PRECONDITION_FAILED. `stripe_unavailable` is the upstream being down, which is a BAD_GATEWAY and
 *  the one code the screen may offer a plain "try again" for. */
const precondition = (message: string): TRPCError => new TRPCError({ code: 'PRECONDITION_FAILED', message })
const badGateway = (message: string): TRPCError => new TRPCError({ code: 'BAD_GATEWAY', message })

export const billingRouter = router({
  get: orgProcedure.query(({ ctx }) => getBilling(serviceDeps(ctx), ctx.orgId)),

  startCheckout: ownerProcedure.mutation(async ({ ctx }) => {
    const res = await startCheckout(serviceDeps(ctx), ctx.orgId, appActor(ctx))
    if (res.ok) return { url: res.url }
    switch (res.code) {
      case 'not_configured': throw precondition(BILLING_ERROR_MESSAGES.not_configured)
      case 'already_subscribed': throw precondition(BILLING_ERROR_MESSAGES.already_subscribed)
      case 'stripe_unavailable': throw badGateway(BILLING_ERROR_MESSAGES.stripe_unavailable)
    }
  }),

  openPortal: ownerProcedure.mutation(async ({ ctx }) => {
    const res = await openPortal(serviceDeps(ctx), ctx.orgId, appActor(ctx))
    if (res.ok) return { url: res.url }
    switch (res.code) {
      case 'not_configured': throw precondition(BILLING_ERROR_MESSAGES.not_configured)
      case 'no_customer': throw precondition(BILLING_ERROR_MESSAGES.no_customer)
      case 'stripe_unavailable': throw badGateway(BILLING_ERROR_MESSAGES.stripe_unavailable)
    }
  }),

  setOverageMode: ownerProcedure.input(SetOverageModeInput).mutation(({ ctx, input }) =>
    setOverageMode(serviceDeps(ctx), ctx.orgId, input, appActor(ctx))),
})
