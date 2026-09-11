import { initTRPC, TRPCError } from '@trpc/server'
import { APIError } from 'better-auth/api'
import superjson from 'superjson'
import { GUARDRAIL_CODES, ORG_ROLES, canManageWorkspace, type GuardrailCode, type OrgRole } from '@aesa/contracts'
import type { GuardrailFinding } from '@aesa/core'
import type { AuditActor } from '@aesa/db'
import type { TrpcContext } from './context.ts'

/**
 * tRPC's error shape has no room for structured detail — `data` is a fixed set of fields and `cause`
 * never crosses the wire — so `drafts.approve`'s BAD_REQUEST 'guardrail' hands its findings over in
 * `cause` and this lifts them onto `data.findings`. Rebuilt field by field, never spread: whatever a
 * thrower put in that object, only these three strings reach a client.
 */
function guardrailFindings(cause: unknown): GuardrailFinding[] | null {
  if (typeof cause !== 'object' || cause === null) return null
  const raw = (cause as { findings?: unknown }).findings
  if (!Array.isArray(raw)) return null
  const findings: GuardrailFinding[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) return null
    const { code, severity, detail } = entry as { code?: unknown; severity?: unknown; detail?: unknown }
    if (typeof code !== 'string' || !(GUARDRAIL_CODES as readonly string[]).includes(code)) return null
    if (severity !== 'fail' && severity !== 'warn') return null
    findings.push({ code: code as GuardrailCode, severity, detail: typeof detail === 'string' ? detail : '' })
  }
  return findings
}

// isDev: false — never emit a stack, even outside production (tRPC's own default is
// `process.env.NODE_ENV !== 'production'`, which would otherwise leak one in dev/test). The
// errorFormatter then masks the message of any INTERNAL_SERVER_ERROR: tRPC's default getErrorShape
// always sets `message: error.message`, and an INTERNAL_SERVER_ERROR's message is the thrown
// error's own message (a DrizzleQueryError's raw SQL and bound parameters, say) unless replaced
// here. A TRPCError a procedure throws on purpose (FORBIDDEN, BAD_REQUEST, ...) keeps its message —
// only the code that means "something we didn't plan for" is masked (Phase 1 review, Critical 1).
const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson,
  isDev: false,
  errorFormatter({ shape, error }) {
    if (error.code !== 'INTERNAL_SERVER_ERROR') {
      // Non-500s only, and only this one shape: the 500 branch below runs first, so an internal
      // error that happens to carry a `findings` cause is still masked to a bare message.
      const findings = guardrailFindings(error.cause)
      return findings === null ? shape : { ...shape, data: { ...shape.data, findings } }
    }
    // isDev:false already keeps getErrorShape from ever setting shape.data.stack, but delete (not
    // `stack: undefined`) belt-and-braces that for any future isDev flip: superjson — the transformer
    // below — encodes an `undefined` property as a real `"stack":null` field plus a meta marker, so
    // setting it to undefined would still put the literal key on the wire.
    const data: Record<string, unknown> = { ...shape.data }
    delete data.stack
    return { ...shape, message: 'Internal Server Error', data: data as typeof shape.data }
  },
})

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
