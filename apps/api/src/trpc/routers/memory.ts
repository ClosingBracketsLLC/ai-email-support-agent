/**
 * The `memory` router: input → `src/memory/service.ts` → tRPC error mapping, and nothing else —
 * mirrors `routers/knowledge.ts` and `routers/drafts.ts`. Reading what the agent remembers is every
 * teammate's job (`orgProcedure`); deciding what it keeps, forgets, or forgets about one customer is
 * workspace management (`managerProcedure`).
 */
import { TRPCError } from '@trpc/server'
import { AnswerIdInput, DeleteByCustomerInput, MemoryListInput, RememberReplyInput } from '@aesa/contracts'
import type { AuditActor } from '@aesa/db'
import type pino from 'pino'
import type { ApiFacade, EnqueueFn } from '../../deps.ts'
import {
  confirmCandidate, deleteByCustomer, keepAnswer, list, rejectCandidate, rememberReply, retireAnswer, summary,
  type MemoryActor, type MemoryResult, type MemoryServiceDeps, type RememberReplyResult,
} from '../../memory/service.ts'
import { managerProcedure, orgProcedure, router } from '../init.ts'

/** The slice of the tRPC context the service needs — structural, so the real context just satisfies it. */
interface MemoryContext {
  deps: { api: ApiFacade; enqueue: EnqueueFn; logger: pino.Logger }
  user: { id: string }
  actor: AuditActor
  ip: string
  userAgent: string | null
}

const serviceDeps = (ctx: MemoryContext): MemoryServiceDeps => ({ api: ctx.deps.api, enqueue: ctx.deps.enqueue, logger: ctx.deps.logger })
const appActor = (ctx: MemoryContext): MemoryActor => ({ userId: ctx.user.id, actor: ctx.actor, ip: ctx.ip, userAgent: ctx.userAgent })

/** The service's one soft code. "Not in a state this decision applies to" is reported the same way as
 * "no such answer" on purpose: the difference would leak whether an id exists in another workspace. */
function unwrap(res: MemoryResult): { ok: true } {
  if (res.ok) return { ok: true }
  throw new TRPCError({ code: 'NOT_FOUND', message: 'answer not found' })
}

export const memoryRouter = router({
  summary: orgProcedure.query(({ ctx }) => summary(serviceDeps(ctx), ctx.orgId)),

  list: orgProcedure.input(MemoryListInput).query(({ ctx, input }) => list(serviceDeps(ctx), ctx.orgId, input)),

  keep: managerProcedure.input(AnswerIdInput).mutation(async ({ ctx, input }) =>
    unwrap(await keepAnswer(serviceDeps(ctx), ctx.orgId, input.answerId, appActor(ctx)))),

  retire: managerProcedure.input(AnswerIdInput).mutation(async ({ ctx, input }) =>
    unwrap(await retireAnswer(serviceDeps(ctx), ctx.orgId, input.answerId, appActor(ctx)))),

  confirmCandidate: managerProcedure.input(AnswerIdInput).mutation(async ({ ctx, input }) =>
    unwrap(await confirmCandidate(serviceDeps(ctx), ctx.orgId, input.answerId, appActor(ctx)))),

  rejectCandidate: managerProcedure.input(AnswerIdInput).mutation(async ({ ctx, input }) =>
    unwrap(await rejectCandidate(serviceDeps(ctx), ctx.orgId, input.answerId, appActor(ctx)))),

  /** The address is hashed inside the transaction and never stored, logged or echoed back — only the
   * number of answers that matched it comes out. */
  deleteByCustomer: managerProcedure.input(DeleteByCustomerInput).mutation(({ ctx, input }) =>
    deleteByCustomer(serviceDeps(ctx), ctx.orgId, input.email, appActor(ctx))),

  /** Phase 7's "Remember this reply": one already-sent outbound message becomes a learned answer,
   * through the SAME `memory.capture` job everything else goes through. `{ ok: true }` means the job
   * is queued — the job re-validates and may still skip (a reply with no question before it). */
  rememberReply: managerProcedure.input(RememberReplyInput).mutation(async ({ ctx, input }) =>
    unwrapRemember(await rememberReply(serviceDeps(ctx), ctx.orgId, input.messageId, appActor(ctx)))),
})

/** Exhaustive with NO `default`, so a new soft code in the service is a compile error rather than a
 * silent 500. `not_found` covers "another workspace's message" too — telling those apart would leak
 * whether an id exists elsewhere. The other three are states of the message that a different action
 * (or none) resolves, never the caller's input being malformed: PRECONDITION_FAILED. */
function unwrapRemember(res: RememberReplyResult): { ok: true } {
  if (res.ok) return { ok: true }
  switch (res.code) {
    case 'not_found': throw new TRPCError({ code: 'NOT_FOUND', message: 'message not found' })
    case 'not_outbound': throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'only a reply this workspace sent can be remembered' })
    case 'already_remembered': throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'this reply is already remembered' })
    case 'empty': throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'this reply has no text left to remember' })
  }
}
