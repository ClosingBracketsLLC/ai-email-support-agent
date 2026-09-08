import { createTRPCClient, httpBatchLink } from '@trpc/client'
import { eq } from 'drizzle-orm'
import superjson from 'superjson'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { auditLog } from '@aesa/db'
import type { AppRouter } from '../src/trpc/router.ts'
import { WEB, createTestApi, listen, signInWithOtp } from './helpers/app.ts'

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
})
