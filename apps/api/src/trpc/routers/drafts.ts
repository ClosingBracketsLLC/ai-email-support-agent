/**
 * The `drafts` router: input → `src/drafts/service.ts` → tRPC error mapping, and nothing else. Every
 * procedure is an `orgProcedure` — reviewing the agent's replies is every teammate's job, not just an
 * owner's — and every mutation's audit row is written by the service, with `ctx.actor`.
 *
 * The two soft hold outcomes (`too_late`, `not_holdable`) are returned, not thrown: the app's undo
 * toast is racing a 15-second clock and losing that race is an ordinary result, not an error.
 */
import { TRPCError } from '@trpc/server'
import { ApproveDraftInput, DraftIdInput, RejectDraftInput } from '@aesa/contracts'
import type { AuditActor } from '@aesa/db'
import type pino from 'pino'
import type { ApiFacade, EnqueueFn } from '../../deps.ts'
import {
  approveDraft, holdDraft, loadDraftView, markViewed, rejectDraft, resumeDraft,
  type DraftActor, type DraftServiceDeps,
} from '../../drafts/service.ts'
import { orgProcedure, router } from '../init.ts'
import { loadTicketSummary } from './inbox.ts'

/** The slice of the tRPC context the service needs — structural, so the real context just satisfies it. */
interface DraftContext {
  deps: { api: ApiFacade; enqueue: EnqueueFn; logger: pino.Logger }
  user: { id: string }
  actor: AuditActor
  ip: string
  userAgent: string | null
}

const serviceDeps = (ctx: DraftContext): DraftServiceDeps => ({ api: ctx.deps.api, enqueue: ctx.deps.enqueue, logger: ctx.deps.logger })
const appActor = (ctx: DraftContext): DraftActor => ({ userId: ctx.user.id, actor: ctx.actor, source: 'app', ip: ctx.ip, userAgent: ctx.userAgent })

const notFound = (): TRPCError => new TRPCError({ code: 'NOT_FOUND', message: 'draft not found' })

export const draftsRouter = router({
  get: orgProcedure.input(DraftIdInput).query(async ({ ctx, input }) => {
    const result = await ctx.deps.api.withOrg(ctx.orgId, async (tx) => {
      const draft = await loadDraftView(tx, ctx.orgId, input.draftId)
      if (!draft) return null
      const ticket = await loadTicketSummary(tx, ctx.orgId, draft.ticketId)
      return ticket ? { draft, ticket } : null
    })
    if (!result) throw notFound()
    return result
  }),

  /** The app calls this once as the panel renders; the approve gate then knows a human read the body. */
  markViewed: orgProcedure.input(DraftIdInput).mutation(async ({ ctx, input }) => ({
    viewed: await markViewed(serviceDeps(ctx), ctx.orgId, input.draftId, appActor(ctx)),
  })),

  approve: orgProcedure.input(ApproveDraftInput).mutation(async ({ ctx, input }) => {
    const res = await approveDraft(serviceDeps(ctx), ctx.orgId, input, appActor(ctx))
    if (res.ok) return { sendId: res.sendId, sendAfter: res.sendAfter, undoUntil: res.sendAfter }
    if (res.code === 'not_found') throw notFound()
    // The findings ride in `cause`: init.ts's errorFormatter copies them to `data.findings` for any
    // non-500, which is the only way a tRPC error shape can carry structured detail.
    if (res.code === 'guardrail') throw new TRPCError({ code: 'BAD_REQUEST', message: 'guardrail', cause: { findings: res.findings ?? [] } })
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: res.code })
  }),

  /** Undo, and Phase 5's Hold: the queued send is held and the draft comes back to To review. */
  hold: orgProcedure.input(DraftIdInput).mutation(async ({ ctx, input }) => {
    const res = await holdDraft(serviceDeps(ctx), ctx.orgId, input.draftId, appActor(ctx))
    if (res.ok) return { held: true }
    if (res.code === 'not_found') throw notFound()
    return { held: false, code: res.code }
  }),

  /** "Back to review" for a draft the send job parked on hold (a kill lever, a mailbox re-auth). */
  resume: orgProcedure.input(DraftIdInput).mutation(async ({ ctx, input }) => {
    const res = await resumeDraft(serviceDeps(ctx), ctx.orgId, input.draftId, appActor(ctx))
    if (res.ok) return { resumed: true }
    if (res.code === 'not_found') throw notFound()
    return { resumed: false }
  }),

  reject: orgProcedure.input(RejectDraftInput).mutation(async ({ ctx, input }) => {
    const res = await rejectDraft(serviceDeps(ctx), ctx.orgId, input, appActor(ctx))
    if (res.ok) return { resolution: res.resolution }
    if (res.code === 'not_found') throw notFound()
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: res.code })
  }),
})
