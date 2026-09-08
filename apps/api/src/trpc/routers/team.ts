import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import type { OrgRole } from '@aesa/contracts'
import { audit } from '@aesa/db'
import { managerProcedure, orgProcedure, router } from '../init.ts'

/** Owner transfer is not a v1 feature: invitations and role changes stop at admin. */
const GrantableRole = z.enum(['admin', 'member'])

export const teamRouter = router({
  list: orgProcedure.query(async ({ ctx }) => {
    const full = await ctx.deps.auth.api.getFullOrganization({ headers: ctx.headers, query: { organizationId: ctx.orgId } })
    if (!full) throw new TRPCError({ code: 'NOT_FOUND', message: 'workspace not found' })
    return {
      members: full.members.map((m) => ({ id: m.id, userId: m.userId, role: m.role as OrgRole, name: m.user.name, email: m.user.email, createdAt: m.createdAt })),
      invitations: full.invitations
        .filter((i) => i.status === 'pending')
        .map((i) => ({ id: i.id, email: i.email, role: (i.role ?? 'member') as OrgRole, expiresAt: i.expiresAt })),
    }
  }),

  invite: managerProcedure.input(z.object({ email: z.email().max(254), role: GrantableRole })).mutation(async ({ ctx, input }) => {
    const email = input.email.toLowerCase()
    const inv = await ctx.deps.auth.api.createInvitation({ headers: ctx.headers, body: { email, role: input.role, organizationId: ctx.orgId, resend: true } })
    await ctx.deps.api.withOrg(ctx.orgId, (tx) => audit(tx, { actor: ctx.actor, action: 'team.invite', entityType: 'invitation', entityId: inv.id, detail: { role: input.role }, ip: ctx.ip, userAgent: ctx.userAgent }))
    return { invitationId: inv.id }
  }),

  cancelInvitation: managerProcedure.input(z.object({ invitationId: z.uuid() })).mutation(async ({ ctx, input }) => {
    // Better Auth's cancel-invitation endpoint takes no organizationId — it authorizes against the
    // invitation's own org, independent of ctx.orgId. Confirm the invitation is pending in the active
    // workspace first, so neither the cancellation nor its audit row can land against the wrong org.
    const full = await ctx.deps.auth.api.getFullOrganization({ headers: ctx.headers, query: { organizationId: ctx.orgId } })
    if (!full || !full.invitations.some((i) => i.id === input.invitationId && i.status === 'pending')) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'no pending invitation with that id in this workspace' })
    }
    await ctx.deps.auth.api.cancelInvitation({ headers: ctx.headers, body: { invitationId: input.invitationId } })
    await ctx.deps.api.withOrg(ctx.orgId, (tx) => audit(tx, { actor: ctx.actor, action: 'team.invite.cancel', entityType: 'invitation', entityId: input.invitationId, ip: ctx.ip, userAgent: ctx.userAgent }))
    return { ok: true as const }
  }),

  changeRole: managerProcedure.input(z.object({ memberId: z.uuid(), role: GrantableRole })).mutation(async ({ ctx, input }) => {
    await ctx.deps.auth.api.updateMemberRole({ headers: ctx.headers, body: { memberId: input.memberId, role: input.role, organizationId: ctx.orgId } })
    await ctx.deps.api.withOrg(ctx.orgId, (tx) => audit(tx, { actor: ctx.actor, action: 'team.role', entityType: 'member', entityId: input.memberId, detail: { to: input.role }, ip: ctx.ip, userAgent: ctx.userAgent }))
    return { ok: true as const }
  }),

  remove: managerProcedure.input(z.object({ memberId: z.uuid() })).mutation(async ({ ctx, input }) => {
    if (input.memberId === ctx.member.id) throw new TRPCError({ code: 'BAD_REQUEST', message: 'use Leave workspace to remove yourself' })
    await ctx.deps.auth.api.removeMember({ headers: ctx.headers, body: { memberIdOrEmail: input.memberId, organizationId: ctx.orgId } })
    await ctx.deps.api.withOrg(ctx.orgId, (tx) => audit(tx, { actor: ctx.actor, action: 'team.remove', entityType: 'member', entityId: input.memberId, ip: ctx.ip, userAgent: ctx.userAgent }))
    return { ok: true as const }
  }),
})
