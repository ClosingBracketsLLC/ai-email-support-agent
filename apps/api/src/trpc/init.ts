import { initTRPC, TRPCError } from '@trpc/server'
import { APIError } from 'better-auth/api'
import superjson from 'superjson'
import { ORG_ROLES, canManageWorkspace, type OrgRole } from '@aesa/contracts'
import type { AuditActor } from '@aesa/db'
import type { TrpcContext } from './context.ts'

const t = initTRPC.context<TrpcContext>().create({ transformer: superjson })

export const router = t.router
export const publicProcedure = t.procedure

export const authedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.session) throw new TRPCError({ code: 'UNAUTHORIZED' })
  const actor: AuditActor = `user:${ctx.session.user.id}`
  return next({ ctx: { ...ctx, session: ctx.session, user: ctx.session.user, actor } })
})

/**
 * The organization comes from the session's active organization AND a membership check (spec, tenancy net 3).
 * No procedure accepts an org id in its input; a stale or forged active organization ends here.
 */
export const orgProcedure = authedProcedure.use(async ({ ctx, next }) => {
  const orgId = ctx.session.session.activeOrganizationId
  if (!orgId) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'no active workspace' })
  let member: { id: string; organizationId: string; role: string } | null = null
  try {
    member = await ctx.deps.auth.api.getActiveMember({ headers: ctx.headers })
  } catch (e) {
    if (!(e instanceof APIError)) throw e
  }
  if (!member || member.organizationId !== orgId || !(ORG_ROLES as readonly string[]).includes(member.role)) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'not a member of the active workspace' })
  }
  return next({ ctx: { ...ctx, orgId, member: { id: member.id, role: member.role as OrgRole } } })
})

export const managerProcedure = orgProcedure.use(({ ctx, next }) => {
  if (!canManageWorkspace(ctx.member.role)) throw new TRPCError({ code: 'FORBIDDEN', message: 'owner or admin required' })
  return next()
})
