import { createTRPCClient, httpBatchLink } from '@trpc/client'
import { eq } from 'drizzle-orm'
import superjson from 'superjson'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { auditLog } from '@aesa/db'
import type { AppRouter } from '../src/trpc/router.ts'
import { WEB, createTestApi, listen, signInWithOtp } from './helpers/app.ts'

const client = (base: string, cookie: string) => createTRPCClient<AppRouter>({
  links: [httpBatchLink({ url: `${base}/trpc`, transformer: superjson, headers: () => ({ origin: WEB, cookie }) })],
})
const PROFILE = { websiteUrl: null, description: '', tone: 'formal' as const, contactPhone: null, contactUrls: [] }

describe('team router', () => {
  let t: Awaited<ReturnType<typeof createTestApi>>
  let base: string
  let owner: ReturnType<typeof client>
  let ownerId: string
  let orgId: string
  let cookieA: string
  let cookieB: string
  let bob: ReturnType<typeof client>
  let bobId: string
  beforeAll(async () => {
    t = await createTestApi(); base = await listen(t.app)
    const a = await signInWithOtp(t.app, t.mail, 'ann@example.com', 'Ann'); ownerId = a.user.id; cookieA = a.cookie; owner = client(base, a.cookie)
    orgId = (await owner.workspace.create.mutate({ businessName: 'Acme', timezone: 'UTC' })).orgId
    const b = await signInWithOtp(t.app, t.mail, 'bob@example.com', 'Bob'); cookieB = b.cookie; bobId = b.user.id; bob = client(base, cookieB)
  })
  afterAll(async () => { await t.close() })

  it('invite: emails a link to /invite/<id>, lists the pending invitation, audits team.invite as the inviter', async () => {
    const { invitationId } = await owner.team.invite.mutate({ email: 'Bob@Example.com', role: 'member' })
    const mail = t.mail.latestTo('bob@example.com')
    expect(mail?.subject).toBe('Ann invited you to Acme on aesa')
    expect(mail?.text).toContain(`${WEB}/invite/${invitationId}`)
    const list = await owner.team.list.query()
    expect(list.members).toEqual([expect.objectContaining({ userId: ownerId, role: 'owner', email: 'ann@example.com' })])
    expect(list.invitations).toEqual([expect.objectContaining({ id: invitationId, email: 'bob@example.com', role: 'member' })])
    const rows = await t.api.withOrg(orgId, (tx) => tx.select().from(auditLog).where(eq(auditLog.action, 'team.invite')))
    expect(rows[0]).toMatchObject({ actor: `user:${ownerId}`, entityId: invitationId, detail: { role: 'member' } })
  })

  it('accept: the invitee joins as member (audited team.join as the joiner), can read but not edit the workspace', async () => {
    const invitationId = (await owner.team.list.query()).invitations[0]!.id
    const accept = await t.app.inject({ method: 'POST', url: '/api/auth/organization/accept-invitation', headers: { origin: WEB, cookie: cookieB, 'content-type': 'application/json' }, payload: { invitationId } })
    expect(accept.statusCode).toBe(200)
    await t.app.inject({ method: 'POST', url: '/api/auth/organization/set-active', headers: { origin: WEB, cookie: cookieB, 'content-type': 'application/json' }, payload: { organizationId: orgId } })
    expect((await bob.workspace.get.query())).toMatchObject({ orgId, role: 'member' })
    await expect(bob.workspace.updateProfile.mutate(PROFILE)).rejects.toMatchObject({ data: { code: 'FORBIDDEN' } })
    await expect(bob.team.invite.mutate({ email: 'c@example.com', role: 'member' })).rejects.toMatchObject({ data: { code: 'FORBIDDEN' } })
    const joins = await t.api.withOrg(orgId, (tx) => tx.select().from(auditLog).where(eq(auditLog.action, 'team.join')))
    expect(joins[0]).toMatchObject({ actor: `user:${bobId}`, detail: { invitationId, role: 'member' } })
    expect((await owner.team.list.query()).members.map((m) => m.email).sort()).toEqual(['ann@example.com', 'bob@example.com'])
  })

  it('changeRole to admin lets Bob edit; remove revokes access; both audited by the acting user', async () => {
    const bobMember = (await owner.team.list.query()).members.find((m) => m.userId === bobId)!
    await owner.team.changeRole.mutate({ memberId: bobMember.id, role: 'admin' })
    expect((await bob.workspace.updateProfile.mutate(PROFILE)).tone).toBe('formal')
    await owner.team.remove.mutate({ memberId: bobMember.id })
    await expect(bob.workspace.get.query()).rejects.toMatchObject({ data: { code: expect.stringMatching(/FORBIDDEN|PRECONDITION_FAILED/) } })
    const actions = await t.api.withOrg(orgId, (tx) => tx.select().from(auditLog))
    expect(actions.filter((r) => r.action === 'team.role')[0]).toMatchObject({ actor: `user:${ownerId}`, entityId: bobMember.id, detail: { to: 'admin' } })
    expect(actions.filter((r) => r.action === 'team.remove')[0]).toMatchObject({ actor: `user:${ownerId}`, entityId: bobMember.id })
  })

  it('cancelInvitation removes a pending invitation', async () => {
    const { invitationId } = await owner.team.invite.mutate({ email: 'carol@example.com', role: 'admin' })
    await owner.team.cancelInvitation.mutate({ invitationId })
    expect((await owner.team.list.query()).invitations.find((i) => i.id === invitationId)).toBeUndefined()
  })

  it('cancelInvitation is scoped to the active workspace', async () => {
    const { invitationId } = await owner.team.invite.mutate({ email: 'dave@example.com', role: 'member' })
    const { orgId: orgB } = await owner.workspace.create.mutate({ businessName: 'Ann Two', timezone: 'UTC' })   // creating it makes B active
    await expect(owner.team.cancelInvitation.mutate({ invitationId })).rejects.toMatchObject({ data: { code: 'NOT_FOUND' } })
    await t.app.inject({ method: 'POST', url: '/api/auth/organization/set-active', headers: { origin: WEB, cookie: cookieA, 'content-type': 'application/json' }, payload: { organizationId: orgId } })
    expect((await owner.team.list.query()).invitations.find((i) => i.id === invitationId)).toBeDefined()
    await owner.team.cancelInvitation.mutate({ invitationId })
    expect((await owner.team.list.query()).invitations.find((i) => i.id === invitationId)).toBeUndefined()
    const inA = await t.api.withOrg(orgId, (tx) => tx.select().from(auditLog).where(eq(auditLog.action, 'team.invite.cancel')))
    const inB = await t.api.withOrg(orgB, (tx) => tx.select().from(auditLog).where(eq(auditLog.action, 'team.invite.cancel')))
    expect(inA.map((r) => r.entityId)).toContain(invitationId)
    expect(inB).toHaveLength(0)
  })

  it('throttles invitations per organization: 20 succeed, the 21st within the rolling hour is TOO_MANY_REQUESTS', async () => {
    const owner2 = client(base, (await signInWithOtp(t.app, t.mail, 'throttle-owner@example.com', 'Throttle')).cookie)
    await owner2.workspace.create.mutate({ businessName: 'Throttle Co', timezone: 'UTC' })
    for (let i = 0; i < 20; i++) {
      await owner2.team.invite.mutate({ email: `throttle-invitee-${i}@example.com`, role: 'member' })
    }
    await expect(owner2.team.invite.mutate({ email: 'throttle-invitee-20@example.com', role: 'member' })).rejects.toMatchObject({ data: { code: 'TOO_MANY_REQUESTS' } })
  }, 20_000)

  it('remove: the caller cannot remove their own membership', async () => {
    await expect(owner.team.remove.mutate({ memberId: (await owner.team.list.query()).members[0]!.id })).rejects.toMatchObject({ data: { code: 'BAD_REQUEST' } })
  })

  it('changeRole and invite reject the owner role — zod only grants admin/member', async () => {
    // Input validation runs before the resolver, so the memberId need not name a real membership.
    const anyMemberId = (await owner.team.list.query()).members[0]!.id
    await expect(owner.team.changeRole.mutate({ memberId: anyMemberId, role: 'owner' as never })).rejects.toMatchObject({ data: { code: 'BAD_REQUEST' } })
    await expect(owner.team.invite.mutate({ email: 'owner-role@example.com', role: 'owner' as never })).rejects.toMatchObject({ data: { code: 'BAD_REQUEST' } })
  })
})
