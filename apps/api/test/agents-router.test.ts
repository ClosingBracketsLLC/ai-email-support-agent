import { createTRPCClient, httpBatchLink } from '@trpc/client'
import { and, eq } from 'drizzle-orm'
import superjson from 'superjson'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { auditLog } from '@aesa/db'
import type { AppRouter } from '../src/trpc/router.ts'
import { WEB, createTestApi, insertConnectedMailbox, listen, signInWithOtp } from './helpers/app.ts'

const client = (base: string, cookie?: string) => createTRPCClient<AppRouter>({
  links: [httpBatchLink({ url: `${base}/trpc`, transformer: superjson, headers: () => ({ origin: WEB, ...(cookie ? { cookie } : {}) }) })],
})

describe('agents router', () => {
  let t: Awaited<ReturnType<typeof createTestApi>>
  let base: string
  beforeAll(async () => { t = await createTestApi(); base = await listen(t.app) })
  afterAll(async () => { await t.close() })

  /** A fresh owner, a fresh workspace, and one active (primary-address) agent. */
  async function setupOrgWithActiveAgent(ownerEmail: string, mailboxEmail: string) {
    const signed = await signInWithOtp(t.app, t.mail, ownerEmail, 'Owner')
    const c = client(base, signed.cookie)
    const { orgId } = await c.workspace.create.mutate({ businessName: 'Acme', timezone: 'UTC' })
    const connectionId = await insertConnectedMailbox(t.api, orgId, signed.user.id, mailboxEmail)
    const added = await c.mailboxes.addAddress.mutate({ connectionId, address: mailboxEmail, replyFromConnection: false })
    return { orgId, client: c, connectionId, agentId: added.agentId, userId: signed.user.id }
  }

  it('agents.list returns the seeded agent with its full shape', async () => {
    const { client: c, connectionId, agentId } = await setupOrgWithActiveAgent('owner-list@example.com', 'support@agentslist.test')
    const res = await c.agents.list.query()
    expect(res.agents).toEqual([
      expect.objectContaining({
        id: agentId, connectionId, address: 'support@agentslist.test', domain: 'agentslist.test',
        replyFromAddress: null, connectionEmailAddress: 'support@agentslist.test', displayName: 'support', signature: '', personaPreset: 'support',
        personaText: '', guidanceExtra: '', priority: 0, status: 'active', autoSendDelayMin: 2,
      }),
    ])
  })

  it("agents.list returns connectionEmailAddress — the connection's own address, not necessarily the agent's own (review fix, Important 1: the app needs this to make the reply-from choice actually settable)", async () => {
    const { client: c, connectionId, agentId } = await setupOrgWithActiveAgent('owner-replyfrom@example.com', 'support@replyfrom.test')
    const added = await c.mailboxes.addAddress.mutate({ connectionId, address: 'alias@replyfrom.test', replyFromConnection: true })

    const res = await c.agents.list.query()
    expect(res.agents.find((a) => a.id === agentId)).toMatchObject({ address: 'support@replyfrom.test', connectionEmailAddress: 'support@replyfrom.test' })
    expect(res.agents.find((a) => a.id === added.agentId)).toMatchObject({
      address: 'alias@replyfrom.test', connectionEmailAddress: 'support@replyfrom.test', replyFromAddress: 'support@replyfrom.test',
    })
  })

  it('agents.update changes persona and priority, auditing the new values', async () => {
    const { client: c, orgId, agentId } = await setupOrgWithActiveAgent('owner-update@example.com', 'support@agentsupdate.test')
    await c.agents.update.mutate({ agentId, personaPreset: 'billing', priority: 5 })

    const res = await c.agents.list.query()
    expect(res.agents.find((a) => a.id === agentId)).toMatchObject({ personaPreset: 'billing', priority: 5 })

    const rows = await t.api.withOrg(orgId, (tx) => tx.select().from(auditLog).where(and(eq(auditLog.entityId, agentId), eq(auditLog.action, 'agent.updated'))))
    expect(rows[0]?.detail).toMatchObject({ personaPreset: 'billing', priority: 5 })
  })

  it('agents.update logs only a length for freeform persona text, never the body', async () => {
    const { client: c, orgId, agentId } = await setupOrgWithActiveAgent('owner-updatetext@example.com', 'support@agentsupdatetext.test')
    const text = 'Be extra warm and reply in two short paragraphs, never more.'
    await c.agents.update.mutate({ agentId, personaText: text })

    const rows = await t.api.withOrg(orgId, (tx) => tx.select().from(auditLog).where(and(eq(auditLog.entityId, agentId), eq(auditLog.action, 'agent.updated'))))
    expect(rows[0]?.detail).toMatchObject({ personaText: { length: text.length } })
    expect(JSON.stringify(rows[0]?.detail)).not.toContain(text)
  })

  it('agents.update on a cross-org agentId is NOT_FOUND', async () => {
    const orgA = await setupOrgWithActiveAgent('owner-crossa@example.com', 'support@crossa.test')
    const orgB = await setupOrgWithActiveAgent('owner-crossb@example.com', 'support@crossb.test')
    await expect(orgB.client.agents.update.mutate({ agentId: orgA.agentId, priority: 9 })).rejects.toMatchObject({ data: { code: 'NOT_FOUND' } })
  })

  it('a pending_verification agent cannot be set active', async () => {
    const { client: c, connectionId } = await setupOrgWithActiveAgent('owner-pending@example.com', 'support@pending.test')
    const added = await c.mailboxes.addAddress.mutate({ connectionId, address: 'alias@pending.test', replyFromConnection: false })
    expect(added.status).toBe('pending_verification')
    await expect(c.agents.update.mutate({ agentId: added.agentId, status: 'active' })).rejects.toMatchObject({ data: { code: 'PRECONDITION_FAILED' } })
  })

  it('the two-hop resurrection is blocked: a pending_verification agent cannot be set disabled either (review fix, Critical)', async () => {
    const { client: c, connectionId } = await setupOrgWithActiveAgent('owner-tworhop@example.com', 'support@tworhop.test')
    const added = await c.mailboxes.addAddress.mutate({ connectionId, address: 'alias@tworhop.test', replyFromConnection: false })
    expect(added.status).toBe('pending_verification')

    // The first hop of the old exploit — disabling a still-pending agent — is refused outright now,
    // so there is no window left for the second hop (disabled → active) to ever run.
    await expect(c.agents.update.mutate({ agentId: added.agentId, status: 'disabled' })).rejects.toMatchObject({ data: { code: 'FORBIDDEN' } })

    const res = await c.agents.list.query()
    expect(res.agents.find((a) => a.id === added.agentId)?.status).toBe('pending_verification')
  })

  it('a disabled agent can be set active again (but never resurrects from pending_verification)', async () => {
    const { client: c, agentId } = await setupOrgWithActiveAgent('owner-reactivate@example.com', 'support@reactivate.test')
    await c.agents.update.mutate({ agentId, status: 'disabled' })
    await c.agents.update.mutate({ agentId, status: 'active' })
    const res = await c.agents.list.query()
    expect(res.agents.find((a) => a.id === agentId)?.status).toBe('active')
  })

  it('agents.categories returns the 8 seeded policies, read-only', async () => {
    const { client: c, agentId } = await setupOrgWithActiveAgent('owner-categories@example.com', 'support@categories.test')
    const res = await c.agents.categories.query({ agentId })
    expect(res.categories).toHaveLength(8)
    expect(res.categories.every((cat) => cat.mode === 'review')).toBe(true)
    expect(res.categories.map((cat) => cat.key)).toContain('order_status')
  })
})
