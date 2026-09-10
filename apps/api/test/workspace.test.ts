import { createTRPCClient, httpBatchLink } from '@trpc/client'
import { eq } from 'drizzle-orm'
import superjson from 'superjson'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { auditLog, workspaces } from '@aesa/db'
import type { AppRouter } from '../src/trpc/router.ts'
import {
  WEB, createTestApi, insertAgent, insertConnectedMailbox, insertTicket, listen, seedPendingDraft, signInWithOtp,
} from './helpers/app.ts'

const client = (base: string, cookie?: string) => createTRPCClient<AppRouter>({
  links: [httpBatchLink({ url: `${base}/trpc`, transformer: superjson, headers: () => ({ origin: WEB, ...(cookie ? { cookie } : {}) }) })],
})

describe('workspace router', () => {
  let t: Awaited<ReturnType<typeof createTestApi>>
  let base: string
  let a: ReturnType<typeof client>
  let userA: { id: string }
  let cookieA: string
  beforeAll(async () => {
    t = await createTestApi(); base = await listen(t.app)
    const s = await signInWithOtp(t.app, t.mail, 'a@example.com', 'Ann'); cookieA = s.cookie; userA = s.user
    a = client(base, cookieA)
  })
  afterAll(async () => { await t.close() })

  it('unauthenticated → UNAUTHORIZED; signed in without a workspace → PRECONDITION_FAILED', async () => {
    await expect(client(base).workspace.get.query()).rejects.toMatchObject({ data: { code: 'UNAUTHORIZED' } })
    await expect(a.workspace.get.query()).rejects.toMatchObject({ data: { code: 'PRECONDITION_FAILED' } })
  })

  it('create: organization + workspace row at step profile, active organization set, audited as user:<id>', async () => {
    await expect(a.workspace.create.mutate({ businessName: 'Acme', timezone: 'Mars/Olympus' })).rejects.toMatchObject({ data: { code: 'BAD_REQUEST' } })
    const { orgId } = await a.workspace.create.mutate({ businessName: 'Acme & Sons', timezone: 'Europe/Berlin' })
    expect(orgId).toMatch(/^[0-9a-f-]{36}$/)
    const session = await t.app.inject({ method: 'GET', url: '/api/auth/get-session', headers: { cookie: cookieA } })
    expect(session.json().session.activeOrganizationId).toBe(orgId)
    const ws = await a.workspace.get.query()
    expect(ws).toMatchObject({ orgId, businessName: 'Acme & Sons', timezone: 'Europe/Berlin', tone: 'friendly', onboardingStep: 'profile', role: 'owner', allowedUrlHosts: [] })
    expect(Object.keys(ws)).not.toContain('boxPublicKey')
    const rows = await t.api.withOrg(orgId, (tx) => tx.select().from(auditLog).where(eq(auditLog.action, 'workspace.create')))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ actor: `user:${userA.id}`, entityType: 'workspace', entityId: orgId })
    const { rows: org } = await t.handle.pool.query<{ slug: string }>('SELECT slug FROM organization WHERE id = $1', [orgId])
    expect(org[0]!.slug).toMatch(/^acme-sons-[a-z0-9]{4}$/)
  })

  it('updateProfile derives the allowed hosts and moves profile → mailbox exactly once', async () => {
    const v = await a.workspace.updateProfile.mutate({ websiteUrl: 'https://www.acme.com', description: 'Socks', tone: 'concise', contactPhone: '+1 555 0100', contactUrls: ['https://acme.com/contact', 'https://shop.acme.com'] })
    expect(v).toMatchObject({ tone: 'concise', allowedUrlHosts: ['acme.com', 'shop.acme.com'], onboardingStep: 'mailbox' })
    const again = await a.workspace.updateProfile.mutate({ websiteUrl: null, description: '', tone: 'formal', contactPhone: null, contactUrls: [] })
    expect(again).toMatchObject({ allowedUrlHosts: [], onboardingStep: 'mailbox' })
  })

  it('advanceOnboarding walks mailbox → knowledge → go_live → done, stays at done, and audits each move', async () => {
    expect(await a.workspace.advanceOnboarding.mutate()).toEqual({ from: 'mailbox', to: 'knowledge' })
    expect(await a.workspace.advanceOnboarding.mutate()).toEqual({ from: 'knowledge', to: 'go_live' })
    expect(await a.workspace.advanceOnboarding.mutate()).toEqual({ from: 'go_live', to: 'done' })
    expect(await a.workspace.advanceOnboarding.mutate()).toEqual({ from: 'done', to: 'done' })
    const orgId = (await a.workspace.get.query()).orgId
    const moves = await t.api.withOrg(orgId, (tx) => tx.select().from(auditLog).where(eq(auditLog.action, 'workspace.onboarding.advance')))
    expect(moves.map((m) => (m.detail as { to: string }).to)).toEqual(['knowledge', 'go_live', 'done'])
  })

  it('the 6th workspace for one user surfaces organizationLimit as FORBIDDEN with the limit message, not a masked 500', async () => {
    const { cookie } = await signInWithOtp(t.app, t.mail, 'sixer@example.com', 'Sixer')
    const sixer = client(base, cookie)
    for (let i = 0; i < 5; i++) {
      await sixer.workspace.create.mutate({ businessName: `Sixer Org ${i}`, timezone: 'UTC' })
    }
    await expect(sixer.workspace.create.mutate({ businessName: 'One too many', timezone: 'UTC' })).rejects.toMatchObject({
      data: { code: 'FORBIDDEN' },
      message: 'You have reached the maximum number of organizations',
    })
  })

  it('isolation: another owner sees only their own workspace and cannot activate someone else’s organization', async () => {
    const b = client(base, (await signInWithOtp(t.app, t.mail, 'b@example.com', 'Bob')).cookie)
    const { orgId: orgB } = await b.workspace.create.mutate({ businessName: 'Bobcorp', timezone: 'UTC' })
    expect((await b.workspace.get.query()).businessName).toBe('Bobcorp')
    const orgA = (await a.workspace.get.query()).orgId
    const cookieB = (await signInWithOtp(t.app, t.mail, 'b@example.com', 'Bob')).cookie
    const hijack = await t.app.inject({ method: 'POST', url: '/api/auth/organization/set-active', headers: { origin: WEB, cookie: cookieB, 'content-type': 'application/json' }, payload: { organizationId: orgA } })
    expect(hijack.statusCode).toBeGreaterThanOrEqual(400)
    // A session that never activated a workspace (a fresh sign-in, as on another device) has no active
    // organization of its own — Better Auth never defaults it, and the rejected hijack above didn't set one
    // either. Auto-activating "the sole membership" is the app's job (apps/app/src/lib/use-gate.ts, Task 9),
    // not the api's, so it isn't exercised here.
    await expect(client(base, cookieB).workspace.get.query()).rejects.toMatchObject({ data: { code: 'PRECONDITION_FAILED' } })
    const activate = await t.app.inject({ method: 'POST', url: '/api/auth/organization/set-active', headers: { origin: WEB, cookie: cookieB, 'content-type': 'application/json' }, payload: { organizationId: orgB } })
    expect(activate.statusCode).toBe(200)
    expect((await client(base, cookieB).workspace.get.query()).orgId).toBe(orgB)
  })

  it('setAgentEnabled(true) on a go_live workspace completes onboarding, stamps agentEnabledAt (COALESCE), and audits workspace.agent_enabled', async () => {
    const owner = await signInWithOtp(t.app, t.mail, 'golive1@example.com', 'Golive')
    const c = client(base, owner.cookie)
    const { orgId } = await c.workspace.create.mutate({ businessName: 'GoLive Co', timezone: 'UTC' })
    await t.api.withOrg(orgId, (tx) => tx.update(workspaces).set({ onboardingStep: 'go_live' }).where(eq(workspaces.orgId, orgId)))

    const before = Date.now()
    const res = await c.workspace.setAgentEnabled.mutate({ enabled: true })
    expect(res).toMatchObject({ agentEnabled: true, onboardingStep: 'done', role: 'owner' })
    expect(res.agentEnabledAt).toBeInstanceOf(Date)
    expect(res.agentEnabledAt!.getTime()).toBeGreaterThanOrEqual(before - 1000)
    const stampedAt = res.agentEnabledAt!.getTime()

    const enabledRows = await t.api.withOrg(orgId, (tx) => tx.select().from(auditLog).where(eq(auditLog.action, 'workspace.agent_enabled')))
    expect(enabledRows).toHaveLength(1)
    expect(enabledRows[0]).toMatchObject({ actor: `user:${owner.user.id}`, entityType: 'workspace', entityId: orgId })

    // On an already-`done` workspace, enabling again leaves the step unchanged (not an error) and the
    // COALESCE leaves agentEnabledAt exactly where it was — but the switch was still flipped ON again,
    // so it still audits (unconditionally, same as every other setAgentEnabled(true) call).
    const again = await c.workspace.setAgentEnabled.mutate({ enabled: true })
    expect(again).toMatchObject({ agentEnabled: true, onboardingStep: 'done' })
    expect(again.agentEnabledAt!.getTime()).toBe(stampedAt)
    expect(await t.api.withOrg(orgId, (tx) => tx.select().from(auditLog).where(eq(auditLog.action, 'workspace.agent_enabled')))).toHaveLength(2)

    // false flips agentEnabled but keeps agentEnabledAt (the workspace's first-ever enable timestamp),
    // and audits the disable action separately from the enable ones above.
    const off = await c.workspace.setAgentEnabled.mutate({ enabled: false })
    expect(off).toMatchObject({ agentEnabled: false, onboardingStep: 'done' })
    expect(off.agentEnabledAt!.getTime()).toBe(stampedAt)

    const disabledRows = await t.api.withOrg(orgId, (tx) => tx.select().from(auditLog).where(eq(auditLog.action, 'workspace.agent_disabled')))
    expect(disabledRows).toHaveLength(1)
    expect(disabledRows[0]).toMatchObject({ actor: `user:${owner.user.id}`, entityType: 'workspace', entityId: orgId })
  })

  it('setAgentEnabled: a member (not manager) is FORBIDDEN', async () => {
    const owner = await signInWithOtp(t.app, t.mail, 'switchowner@example.com', 'Owner')
    const ownerClient = client(base, owner.cookie)
    const { orgId } = await ownerClient.workspace.create.mutate({ businessName: 'Switchco', timezone: 'UTC' })
    const { invitationId } = await ownerClient.team.invite.mutate({ email: 'switchmember@example.com', role: 'member' })
    const member = await signInWithOtp(t.app, t.mail, 'switchmember@example.com', 'Member')
    await t.app.inject({ method: 'POST', url: '/api/auth/organization/accept-invitation', headers: { origin: WEB, cookie: member.cookie, 'content-type': 'application/json' }, payload: { invitationId } })
    await t.app.inject({ method: 'POST', url: '/api/auth/organization/set-active', headers: { origin: WEB, cookie: member.cookie, 'content-type': 'application/json' }, payload: { organizationId: orgId } })

    await expect(client(base, member.cookie).workspace.setAgentEnabled.mutate({ enabled: true })).rejects.toMatchObject({ data: { code: 'FORBIDDEN' } })
  })

  it('goLiveStatus: agent addresses in priority order (active only), ticketsSeen, and the newest live draft', async () => {
    const owner = await signInWithOtp(t.app, t.mail, 'golivestatus@example.com', 'GLS')
    const c = client(base, owner.cookie)
    const { orgId } = await c.workspace.create.mutate({ businessName: 'GLS Co', timezone: 'UTC' })

    const empty = await c.workspace.goLiveStatus.query()
    expect(empty).toEqual({ agentEnabled: false, agentAddresses: [], firstDraft: null, ticketsSeen: 0 })

    const connectionId = await insertConnectedMailbox(t.api, orgId, owner.user.id, 'primary@gls.test')
    await insertAgent(t.api, orgId, connectionId, 'second@gls.test', { priority: 5 })
    const firstAgentId = await insertAgent(t.api, orgId, connectionId, 'primary@gls.test', { priority: 1 })
    await insertAgent(t.api, orgId, connectionId, 'off@gls.test', { priority: 0, status: 'disabled' })

    const withAgents = await c.workspace.goLiveStatus.query()
    expect(withAgents).toMatchObject({ agentEnabled: false, agentAddresses: ['primary@gls.test', 'second@gls.test'], firstDraft: null, ticketsSeen: 0 })

    const ticket = await insertTicket(t.api, orgId, { connectionId, agentId: firstAgentId, subject: 'Where is my order?' })
    expect((await c.workspace.goLiveStatus.query()).ticketsSeen).toBe(1)
    expect((await c.workspace.goLiveStatus.query()).firstDraft).toBeNull()

    const draft = await seedPendingDraft(t.api, orgId, ticket.id, { agentId: firstAgentId })
    const withDraft = await c.workspace.goLiveStatus.query()
    expect(withDraft.firstDraft).toMatchObject({ ticketId: ticket.id, draftId: draft.id, subject: 'Where is my order?' })
    expect(withDraft.firstDraft!.createdAt).toBeInstanceOf(Date)

    // A rejected (non-live) draft on a second ticket must never surface as the "first" draft even
    // though it is newer — only pending/approved/held/sending count as "live".
    const ticket2 = await insertTicket(t.api, orgId, { connectionId, agentId: firstAgentId, subject: 'Rejected one' })
    const rejected = await seedPendingDraft(t.api, orgId, ticket2.id, { agentId: firstAgentId, status: 'rejected' })
    void rejected
    const afterRejected = await c.workspace.goLiveStatus.query()
    expect(afterRejected.firstDraft).toMatchObject({ ticketId: ticket.id, draftId: draft.id })
    expect(afterRejected.ticketsSeen).toBe(2)
  })
})
