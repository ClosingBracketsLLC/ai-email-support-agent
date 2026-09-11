/**
 * Phase 5's Autopilot surface: `agents.categories` (the screen's whole payload — mode, threshold,
 * the cold-start counter, the graduation suggestion, the demotion stamps and the 30-day stats) and
 * `agents.setCategoryPolicy` (the switch itself, behind the cold-start lock), plus the two agent-wide
 * knobs `agents.update` gained (`autoGraduate`, `autoSendDelayMin`).
 */
import { randomUUID } from 'node:crypto'
import { createTRPCClient, httpBatchLink } from '@trpc/client'
import { and, eq } from 'drizzle-orm'
import superjson from 'superjson'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { COLD_START_DECISIONS } from '@aesa/core'
import { DEFAULT_AUTO_SEND_THRESHOLD } from '@aesa/contracts'
import { agentCategoryPolicies, agents, auditLog, categories, categoryStatsDaily, drafts } from '@aesa/db'
import type { AppRouter } from '../src/trpc/router.ts'
import {
  WEB, createTestApi, insertConnectedMailbox, insertTicket, listen, seedPendingDraft, signInWithOtp,
} from './helpers/app.ts'

const client = (base: string, cookie?: string) => createTRPCClient<AppRouter>({
  links: [httpBatchLink({ url: `${base}/trpc`, transformer: superjson, headers: () => ({ origin: WEB, ...(cookie ? { cookie } : {}) }) })],
})

const DAY_MS = 86_400_000
const utcDay = (d: Date): string => d.toISOString().slice(0, 10)

describe('autonomy (agents.categories / agents.setCategoryPolicy)', () => {
  let t: Awaited<ReturnType<typeof createTestApi>>
  let base: string
  let seq = 0
  beforeAll(async () => { t = await createTestApi(); base = await listen(t.app) })
  afterAll(async () => { await t.close() })

  /** An owner, a workspace, a connected mailbox and its primary (active) agent — `addAddress` is what
   * seeds the org's 8 categories and one `review` policy row per category. */
  async function setupOrg() {
    const n = ++seq
    const signed = await signInWithOtp(t.app, t.mail, `autonomy-${n}@example.com`, 'Owner')
    const c = client(base, signed.cookie)
    const { orgId } = await c.workspace.create.mutate({ businessName: 'Acme', timezone: 'UTC' })
    const address = `support${n}@autonomy.test`
    const connectionId = await insertConnectedMailbox(t.api, orgId, signed.user.id, address)
    const added = await c.mailboxes.addAddress.mutate({ connectionId, address, replyFromConnection: false })
    return { orgId, c, connectionId, agentId: added.agentId, userId: signed.user.id, cookie: signed.cookie, seq: n }
  }

  const categoryByKey = async (orgId: string, key: string) =>
    (await t.api.withOrg(orgId, (tx) => tx.select().from(categories).where(eq(categories.key, key))))[0]!

  const readPolicy = (orgId: string, agentId: string, categoryId: string) =>
    t.api.withOrg(orgId, async (tx) => (await tx.select().from(agentCategoryPolicies)
      .where(and(eq(agentCategoryPolicies.agentId, agentId), eq(agentCategoryPolicies.categoryId, categoryId))))[0])

  /** `n` drafts a HUMAN decided in this (agent, category) — what the cold-start lock counts. */
  async function seedHumanDecisions(
    org: Awaited<ReturnType<typeof setupOrg>>, categoryId: string, n: number,
  ): Promise<void> {
    for (let i = 0; i < n; i++) {
      const ticket = await insertTicket(t.api, org.orgId, {
        connectionId: org.connectionId, agentId: org.agentId, status: 'waiting_on_customer', categoryId,
      })
      const draft = await seedPendingDraft(t.api, org.orgId, ticket.id, { agentId: org.agentId })
      await t.api.withOrg(org.orgId, (tx) => tx.update(drafts).set({
        categoryId, status: 'sent', decisionSource: 'app', decidedBy: org.userId, decidedAt: new Date(), editDistanceRatio: 0,
      }).where(eq(drafts.id, draft.id)))
    }
  }

  it("agents.categories returns mode, threshold, humanDecisionCount, the suggestion, demotion stamps and 30-day stats per category, plus the agent's autoGraduate/autoSendDelayMin", async () => {
    const org = await setupOrg()
    const orderStatus = await categoryByKey(org.orgId, 'order_status')
    const returns = await categoryByKey(org.orgId, 'returns_refunds')

    // One category with a live graduation suggestion, one demoted, and a day of stats for each.
    const suggestedAt = new Date('2026-09-01T00:00:00Z')
    const demotedAt = new Date('2026-09-02T00:00:00Z')
    await t.api.withOrg(org.orgId, (tx) => tx.update(agentCategoryPolicies)
      .set({ suggestedAt, suggestedWouldSend: 18, suggestedOf: 20 })
      .where(and(eq(agentCategoryPolicies.agentId, org.agentId), eq(agentCategoryPolicies.categoryId, orderStatus.id))))
    await t.api.withOrg(org.orgId, (tx) => tx.update(agentCategoryPolicies)
      .set({ mode: 'off', demotedAt, demotedReason: 'flags', autoSendMinConfidence: 85 })
      .where(and(eq(agentCategoryPolicies.agentId, org.agentId), eq(agentCategoryPolicies.categoryId, returns.id))))

    const today = utcDay(new Date())
    const longAgo = utcDay(new Date(Date.now() - 90 * DAY_MS))
    await t.api.withOrg(org.orgId, (tx) => tx.insert(categoryStatsDaily).values([
      { orgId: org.orgId, agentId: org.agentId, categoryId: orderStatus.id, day: today, drafted: 5, approvedUnchanged: 3, approvedEdited: 1, rejected: 1, autoSent: 2, autoSentFlagged: 1, held: 1 },
      { orgId: org.orgId, agentId: org.agentId, categoryId: orderStatus.id, day: utcDay(new Date(Date.now() - DAY_MS)), drafted: 2, approvedUnchanged: 2 },
      // Outside the 30-day window: counted by nothing below.
      { orgId: org.orgId, agentId: org.agentId, categoryId: orderStatus.id, day: longAgo, drafted: 99, approvedUnchanged: 99 },
    ]))

    await seedHumanDecisions(org, orderStatus.id, 3)

    const res = await org.c.agents.categories.query({ agentId: org.agentId })
    expect(res.coldStartAt).toBe(COLD_START_DECISIONS)
    expect(res.agent).toEqual({ autoGraduate: false, autoSendDelayMin: 2 })
    expect(res.categories).toHaveLength(8)

    const order = res.categories.find((c) => c.key === 'order_status')!
    expect(order).toMatchObject({
      categoryId: orderStatus.id, label: 'Order status', mode: 'review', autoSendMinConfidence: null,
      humanDecisionCount: 3, graduatedAt: null, demotedAt: null, demotedReason: null,
    })
    expect(order.suggestion).toEqual({ wouldSend: 18, of: 20, at: suggestedAt })
    expect(order.stats30d).toEqual({ drafted: 7, approvedUnchanged: 5, approvedEdited: 1, rejected: 1, autoSent: 2, autoSentFlagged: 1, held: 1 })

    const ret = res.categories.find((c) => c.key === 'returns_refunds')!
    expect(ret).toMatchObject({ mode: 'off', autoSendMinConfidence: 85, demotedReason: 'flags', humanDecisionCount: 0 })
    expect(ret.demotedAt).toEqual(demotedAt)
    expect(ret.suggestion).toBeNull()
    expect(ret.stats30d).toEqual({ drafted: 0, approvedUnchanged: 0, approvedEdited: 0, rejected: 0, autoSent: 0, autoSentFlagged: 0, held: 0 })

    // Another workspace's agent id is not this workspace's business.
    const other = await setupOrg()
    await expect(other.c.agents.categories.query({ agentId: org.agentId })).rejects.toMatchObject({ data: { code: 'NOT_FOUND' } })
  })

  it('setCategoryPolicy to auto is refused with PRECONDITION_FAILED cold_start under 10 human decisions, and succeeds at 10: mode auto, threshold defaults to 80, graduated_at set, suggestion cleared, audited', async () => {
    const org = await setupOrg()
    const category = await categoryByKey(org.orgId, 'order_status')
    await t.api.withOrg(org.orgId, (tx) => tx.update(agentCategoryPolicies)
      .set({ suggestedAt: new Date(), suggestedWouldSend: 9, suggestedOf: 10 })
      .where(and(eq(agentCategoryPolicies.agentId, org.agentId), eq(agentCategoryPolicies.categoryId, category.id))))

    await seedHumanDecisions(org, category.id, COLD_START_DECISIONS - 1)
    await expect(org.c.agents.setCategoryPolicy.mutate({ agentId: org.agentId, categoryId: category.id, mode: 'auto' }))
      .rejects.toMatchObject({ data: { code: 'PRECONDITION_FAILED' }, message: 'cold_start' })
    expect(await readPolicy(org.orgId, org.agentId, category.id)).toMatchObject({ mode: 'review' })

    await seedHumanDecisions(org, category.id, 1)
    expect(await org.c.agents.setCategoryPolicy.mutate({ agentId: org.agentId, categoryId: category.id, mode: 'auto' })).toEqual({ ok: true })

    const policy = await readPolicy(org.orgId, org.agentId, category.id)
    expect(policy).toMatchObject({ mode: 'auto', autoSendMinConfidence: DEFAULT_AUTO_SEND_THRESHOLD, suggestedWouldSend: null, suggestedOf: null })
    expect(policy!.graduatedAt).toBeInstanceOf(Date)
    expect(policy!.suggestedAt).toBeNull()

    const rows = await t.api.withOrg(org.orgId, (tx) => tx.select().from(auditLog).where(eq(auditLog.action, 'autonomy.policy_updated')))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ actor: `user:${org.userId}`, entityType: 'agent', entityId: org.agentId })
    expect(rows[0]!.detail).toMatchObject({ categoryId: category.id, mode: 'auto', autoSendMinConfidence: DEFAULT_AUTO_SEND_THRESHOLD })

    // An explicit threshold is kept, and the graduation stamp is not re-cut by a threshold change.
    expect(await org.c.agents.setCategoryPolicy.mutate({ agentId: org.agentId, categoryId: category.id, mode: 'auto', autoSendMinConfidence: 92 })).toEqual({ ok: true })
    const after = await readPolicy(org.orgId, org.agentId, category.id)
    expect(after).toMatchObject({ mode: 'auto', autoSendMinConfidence: 92 })
    expect(after!.graduatedAt?.getTime()).toBe(policy!.graduatedAt?.getTime())
  })

  it('setCategoryPolicy to review or off never needs the lock; a foreign categoryId is NOT_FOUND, and a disabled agent cannot go auto', async () => {
    const org = await setupOrg()
    const category = await categoryByKey(org.orgId, 'billing_payment')

    expect(await org.c.agents.setCategoryPolicy.mutate({ agentId: org.agentId, categoryId: category.id, mode: 'off' })).toEqual({ ok: true })
    expect(await readPolicy(org.orgId, org.agentId, category.id)).toMatchObject({ mode: 'off', graduatedAt: null })
    expect(await org.c.agents.setCategoryPolicy.mutate({ agentId: org.agentId, categoryId: category.id, mode: 'review' })).toEqual({ ok: true })
    expect(await readPolicy(org.orgId, org.agentId, category.id)).toMatchObject({ mode: 'review' })

    // A category id that is not this workspace's (and one that is, but has no policy row for this agent).
    const other = await setupOrg()
    const foreign = await categoryByKey(other.orgId, 'billing_payment')
    await expect(org.c.agents.setCategoryPolicy.mutate({ agentId: org.agentId, categoryId: foreign.id, mode: 'review' }))
      .rejects.toMatchObject({ data: { code: 'NOT_FOUND' } })
    await expect(org.c.agents.setCategoryPolicy.mutate({ agentId: randomUUID(), categoryId: category.id, mode: 'review' }))
      .rejects.toMatchObject({ data: { code: 'NOT_FOUND' } })

    await seedHumanDecisions(org, category.id, COLD_START_DECISIONS)
    await t.api.withOrg(org.orgId, (tx) => tx.update(agents).set({ status: 'disabled' }).where(eq(agents.id, org.agentId)))
    await expect(org.c.agents.setCategoryPolicy.mutate({ agentId: org.agentId, categoryId: category.id, mode: 'auto' }))
      .rejects.toMatchObject({ data: { code: 'PRECONDITION_FAILED' }, message: 'agent_inactive' })
    // …but taking a category OFF never depends on the agent being active.
    expect(await org.c.agents.setCategoryPolicy.mutate({ agentId: org.agentId, categoryId: category.id, mode: 'off' })).toEqual({ ok: true })
  })

  it('agents.update sets autoGraduate and autoSendDelayMin (bounded 1..60), audited', async () => {
    const org = await setupOrg()
    await org.c.agents.update.mutate({ agentId: org.agentId, autoGraduate: true, autoSendDelayMin: 15 })

    const [row] = await t.api.withOrg(org.orgId, (tx) => tx.select().from(agents).where(eq(agents.id, org.agentId)))
    expect(row).toMatchObject({ autoGraduate: true, autoSendDelayMin: 15 })

    const listed = (await org.c.agents.list.query()).agents.find((a) => a.id === org.agentId)
    expect(listed).toMatchObject({ autoGraduate: true, autoSendDelayMin: 15 })
    expect((await org.c.agents.categories.query({ agentId: org.agentId })).agent).toEqual({ autoGraduate: true, autoSendDelayMin: 15 })

    const rows = await t.api.withOrg(org.orgId, (tx) => tx.select().from(auditLog).where(and(eq(auditLog.action, 'agent.updated'), eq(auditLog.entityId, org.agentId))))
    expect(rows[0]!.detail).toMatchObject({ autoGraduate: true, autoSendDelayMin: 15 })

    await expect(org.c.agents.update.mutate({ agentId: org.agentId, autoSendDelayMin: 0 })).rejects.toMatchObject({ data: { code: 'BAD_REQUEST' } })
    await expect(org.c.agents.update.mutate({ agentId: org.agentId, autoSendDelayMin: 61 })).rejects.toMatchObject({ data: { code: 'BAD_REQUEST' } })
  })

  it('a member (non-manager) can read the categories but cannot call setCategoryPolicy', async () => {
    const org = await setupOrg()
    const category = await categoryByKey(org.orgId, 'order_status')

    const memberEmail = `autonomy-member-${org.seq}@example.com`
    const memberSignIn = await signInWithOtp(t.app, t.mail, memberEmail, 'Bob')
    const { invitationId } = await org.c.team.invite.mutate({ email: memberEmail, role: 'member' })
    await t.app.inject({
      method: 'POST', url: '/api/auth/organization/accept-invitation',
      headers: { origin: WEB, cookie: memberSignIn.cookie, 'content-type': 'application/json' }, payload: { invitationId },
    })
    await t.app.inject({
      method: 'POST', url: '/api/auth/organization/set-active',
      headers: { origin: WEB, cookie: memberSignIn.cookie, 'content-type': 'application/json' }, payload: { organizationId: org.orgId },
    })

    const asMember = client(base, memberSignIn.cookie)
    expect((await asMember.agents.categories.query({ agentId: org.agentId })).categories).toHaveLength(8)
    await expect(asMember.agents.setCategoryPolicy.mutate({ agentId: org.agentId, categoryId: category.id, mode: 'review' }))
      .rejects.toMatchObject({ data: { code: 'FORBIDDEN' } })
  })
})
