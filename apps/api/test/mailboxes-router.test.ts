import { createTRPCClient, httpBatchLink } from '@trpc/client'
import { eq } from 'drizzle-orm'
import superjson from 'superjson'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { hashToken, hashesEqual } from '@aesa/crypto'
import { agentCategoryPolicies, agents, auditLog, gmailAccessRequests } from '@aesa/db'
import type { AppRouter } from '../src/trpc/router.ts'
import { WEB, createTestApi, insertConnectedMailbox, listen, signInWithOtp } from './helpers/app.ts'

const client = (base: string, cookie?: string) => createTRPCClient<AppRouter>({
  links: [httpBatchLink({ url: `${base}/trpc`, transformer: superjson, headers: () => ({ origin: WEB, ...(cookie ? { cookie } : {}) }) })],
})

describe('mailboxes router: addresses, verification, consent, gmail access', () => {
  let t: Awaited<ReturnType<typeof createTestApi>>
  let base: string
  beforeAll(async () => { t = await createTestApi(); base = await listen(t.app) })
  afterAll(async () => { await t.close() })

  /** A fresh owner, a fresh workspace, and one already-`connected` mailbox — the shared starting
   * point for every test below except the multi-user consent scenario. */
  async function setupOrgWithMailbox(ownerEmail: string, mailboxEmail: string) {
    const signed = await signInWithOtp(t.app, t.mail, ownerEmail, 'Owner')
    const c = client(base, signed.cookie)
    const { orgId } = await c.workspace.create.mutate({ businessName: 'Acme', timezone: 'UTC' })
    const connectionId = await insertConnectedMailbox(t.api, orgId, signed.user.id, mailboxEmail)
    return { orgId, userId: signed.user.id, cookie: signed.cookie, client: c, connectionId }
  }

  it('mailboxes.list shows the connection with its agents and credentialAgeDays', async () => {
    const { client: c, connectionId } = await setupOrgWithMailbox('owner-list@example.com', 'support@list.test')
    const added = await c.mailboxes.addAddress.mutate({ connectionId, address: 'support@list.test', replyFromConnection: false })

    const res = await c.mailboxes.list.query()
    expect(res.connections).toHaveLength(1)
    expect(res.connections[0]).toMatchObject({
      id: connectionId, provider: 'gmail', emailAddress: 'support@list.test', status: 'connected',
      connectedByMe: true, credentialAgeDays: 0,
    })
    expect(res.connections[0]!.agents).toEqual([
      { id: added.agentId, address: 'support@list.test', status: 'active', priority: 0, displayName: 'support' },
    ])
  })

  it('addAddress on the primary address activates immediately, seeds all 8 category policies at mode review, and audits it', async () => {
    const { client: c, orgId, connectionId } = await setupOrgWithMailbox('owner-primary@example.com', 'support@primary.test')
    const res = await c.mailboxes.addAddress.mutate({ connectionId, address: 'support@primary.test', replyFromConnection: false })
    expect(res.status).toBe('active')

    const policies = await t.api.withOrg(orgId, (tx) => tx.select().from(agentCategoryPolicies).where(eq(agentCategoryPolicies.agentId, res.agentId)))
    expect(policies).toHaveLength(8)
    expect(policies.every((p) => p.mode === 'review')).toBe(true)

    const rows = await t.api.withOrg(orgId, (tx) => tx.select().from(auditLog).where(eq(auditLog.entityId, res.agentId)))
    expect(rows.some((r) => r.action === 'agent.address_added')).toBe(true)
  })

  it('addAddress on an alias sends a 6-digit verification code and sets reply_from when asked', async () => {
    const { client: c, orgId, connectionId } = await setupOrgWithMailbox('owner-alias@example.com', 'support@alias.test')
    const res = await c.mailboxes.addAddress.mutate({ connectionId, address: 'sales@alias.test', replyFromConnection: true })
    expect(res.status).toBe('pending_verification')

    const mail = t.mail.latestTo('sales@alias.test')
    expect(mail).toBeDefined()
    const code = mail!.subject.match(/\b(\d{6})\b/)?.[1]
    expect(code).toBeDefined()
    expect(mail!.text).toContain(code!)

    const [agent] = await t.api.withOrg(orgId, (tx) => tx.select().from(agents).where(eq(agents.id, res.agentId)))
    expect(agent?.replyFromAddress).toBe('support@alias.test')
    expect(agent?.verificationCodeHash).toBeTruthy()
    expect(hashesEqual(hashToken('action', code!), agent!.verificationCodeHash!)).toBe(true)
  })

  it('addAddress leaves reply_from NULL when replyFromConnection is false', async () => {
    const { client: c, orgId, connectionId } = await setupOrgWithMailbox('owner-noreply@example.com', 'support@noreply.test')
    const res = await c.mailboxes.addAddress.mutate({ connectionId, address: 'billing@noreply.test', replyFromConnection: false })
    const [agent] = await t.api.withOrg(orgId, (tx) => tx.select().from(agents).where(eq(agents.id, res.agentId)))
    expect(agent?.replyFromAddress).toBeNull()
  })

  it('a 4th active agent on one domain is FORBIDDEN ("agent limit for domain")', async () => {
    const signed = await signInWithOtp(t.app, t.mail, 'owner-domain@example.com', 'Owner')
    const c = client(base, signed.cookie)
    const { orgId } = await c.workspace.create.mutate({ businessName: 'Acme', timezone: 'UTC' })

    for (const local of ['a', 'b', 'c']) {
      const address = `${local}@fourth.test`
      const connectionId = await insertConnectedMailbox(t.api, orgId, signed.user.id, address)
      const res = await c.mailboxes.addAddress.mutate({ connectionId, address, replyFromConnection: false })
      expect(res.status).toBe('active')
    }

    const address = 'd@fourth.test'
    const connectionId = await insertConnectedMailbox(t.api, orgId, signed.user.id, address)
    await expect(c.mailboxes.addAddress.mutate({ connectionId, address, replyFromConnection: false }))
      .rejects.toMatchObject({ data: { code: 'FORBIDDEN' }, message: 'agent limit for domain' })
  })

  it("addAddress on someone else's connection gates on consent; the wrong user is FORBIDDEN; approve unblocks; reject deletes", async () => {
    const ownerA = await signInWithOtp(t.app, t.mail, 'owner-consent-a@example.com', 'Ann')
    const a = client(base, ownerA.cookie)
    const { orgId } = await a.workspace.create.mutate({ businessName: 'Acme', timezone: 'UTC' })
    const connectionId = await insertConnectedMailbox(t.api, orgId, ownerA.user.id, 'support@consent.test')

    const ownerB = await signInWithOtp(t.app, t.mail, 'owner-consent-b@example.com', 'Bea')
    await t.handle.pool.query(`INSERT INTO member (organization_id, user_id, role) VALUES ($1, $2, 'admin')`, [orgId, ownerB.user.id])
    await t.app.inject({
      method: 'POST', url: '/api/auth/organization/set-active',
      headers: { origin: WEB, cookie: ownerB.cookie, 'content-type': 'application/json' },
      payload: { organizationId: orgId },
    })
    const b = client(base, ownerB.cookie)

    // B adds the PRIMARY address on A's connection — normally instant-active, but the consent gate
    // holds it pending because B, not A, is calling.
    const added = await b.mailboxes.addAddress.mutate({ connectionId, address: 'support@consent.test', replyFromConnection: false })
    expect(added.status).toBe('pending_verification')
    const [gated] = await t.api.withOrg(orgId, (tx) => tx.select().from(agents).where(eq(agents.id, added.agentId)))
    expect(gated?.consentRequiredFromUserId).toBe(ownerA.user.id)

    // The wrong user (B, who just added it) cannot consent on their own addition.
    await expect(b.mailboxes.consentAddress.mutate({ agentId: added.agentId, approve: true })).rejects.toMatchObject({ data: { code: 'FORBIDDEN' } })

    // A approves: primary address, consent cleared → active immediately.
    const approved = await a.mailboxes.consentAddress.mutate({ agentId: added.agentId, approve: true })
    expect(approved).toMatchObject({ deleted: false, status: 'active' })
    const [afterApprove] = await t.api.withOrg(orgId, (tx) => tx.select().from(agents).where(eq(agents.id, added.agentId)))
    expect(afterApprove).toMatchObject({ status: 'active', consentRequiredFromUserId: null })

    // A second, alias address added by B — rejecting it deletes the agent outright.
    const added2 = await b.mailboxes.addAddress.mutate({ connectionId, address: 'billing@consent.test', replyFromConnection: false })
    const rejected = await a.mailboxes.consentAddress.mutate({ agentId: added2.agentId, approve: false })
    expect(rejected).toMatchObject({ deleted: true })
    const [afterReject] = await t.api.withOrg(orgId, (tx) => tx.select().from(agents).where(eq(agents.id, added2.agentId)))
    expect(afterReject).toBeUndefined()
  })

  it('resendVerification rotates the code — the old hash no longer matches', async () => {
    const { client: c, orgId, connectionId } = await setupOrgWithMailbox('owner-resend@example.com', 'support@resend.test')
    const added = await c.mailboxes.addAddress.mutate({ connectionId, address: 'alias@resend.test', replyFromConnection: false })
    const [before] = await t.api.withOrg(orgId, (tx) => tx.select().from(agents).where(eq(agents.id, added.agentId)))
    const oldCode = t.mail.latestTo('alias@resend.test')!.subject.match(/\b(\d{6})\b/)![1]!
    const oldHash = before!.verificationCodeHash!
    expect(hashesEqual(hashToken('action', oldCode), oldHash)).toBe(true)

    await c.mailboxes.resendVerification.mutate({ agentId: added.agentId })

    const [after] = await t.api.withOrg(orgId, (tx) => tx.select().from(agents).where(eq(agents.id, added.agentId)))
    expect(after!.verificationCodeHash).not.toBe(oldHash)
    expect(hashesEqual(hashToken('action', oldCode), after!.verificationCodeHash!)).toBe(false)

    const newCode = t.mail.latestTo('alias@resend.test')!.subject.match(/\b(\d{6})\b/)![1]!
    expect(newCode).not.toBe(oldCode)
    expect(hashesEqual(hashToken('action', newCode), after!.verificationCodeHash!)).toBe(true)
  })

  it('resendVerification is NOT_FOUND for an active (already-verified) agent', async () => {
    const { client: c, connectionId } = await setupOrgWithMailbox('owner-resend2@example.com', 'support@resend2.test')
    const added = await c.mailboxes.addAddress.mutate({ connectionId, address: 'support@resend2.test', replyFromConnection: false })
    expect(added.status).toBe('active')
    await expect(c.mailboxes.resendVerification.mutate({ agentId: added.agentId })).rejects.toMatchObject({ data: { code: 'NOT_FOUND' } })
  })

  it('requestGmailAccess is idempotent', async () => {
    const signed = await signInWithOtp(t.app, t.mail, 'owner-gmail@example.com', 'Owner')
    const c = client(base, signed.cookie)
    const { orgId } = await c.workspace.create.mutate({ businessName: 'Acme', timezone: 'UTC' })

    expect(await c.mailboxes.requestGmailAccess.mutate({ email: 'help@needs-access.test' })).toEqual({ requested: true })
    expect(await c.mailboxes.requestGmailAccess.mutate({ email: 'help@needs-access.test' })).toEqual({ requested: true })

    const rows = await t.api.withOrg(orgId, (tx) => tx.select().from(gmailAccessRequests).where(eq(gmailAccessRequests.orgId, orgId)))
    expect(rows).toHaveLength(1)
  })

  it('adminConsentInfo is PRECONDITION_FAILED when Microsoft mailbox OAuth is not configured', async () => {
    const signed = await signInWithOtp(t.app, t.mail, 'owner-admin-consent@example.com', 'Owner')
    const c = client(base, signed.cookie)
    await c.workspace.create.mutate({ businessName: 'Acme', timezone: 'UTC' })
    await expect(c.mailboxes.adminConsentInfo.query({})).rejects.toMatchObject({ data: { code: 'PRECONDITION_FAILED' } })
  })

  it('adminConsentInfo builds a Microsoft admin-consent URL from config when it is configured', async () => {
    const withMs = await createTestApi({ MS_OAUTH_CLIENT_ID: 'ms-client', MS_OAUTH_CLIENT_SECRET: 'ms-secret' })
    try {
      const base2 = await listen(withMs.app)
      const signed = await signInWithOtp(withMs.app, withMs.mail, 'owner-ms@example.com', 'Owner')
      const c = client(base2, signed.cookie)
      await c.workspace.create.mutate({ businessName: 'Acme', timezone: 'UTC' })
      const res = await c.mailboxes.adminConsentInfo.query({})
      const url = new URL(res.adminConsentUrl)
      expect(`${url.origin}${url.pathname}`).toBe('https://login.microsoftonline.com/common/adminconsent')
      expect(url.searchParams.get('client_id')).toBe('ms-client')
      expect(url.searchParams.get('redirect_uri')).toBe(`${withMs.config.appBaseUrl}/connect/microsoft/callback`)
    } finally {
      await withMs.close()
    }
  })
})
