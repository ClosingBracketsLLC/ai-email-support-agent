import { randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  agentCategoryPolicies, agents, categories, countHumanDecisions, demoteCategory, drafts, ensureDefaultCategories,
  graduateCategory, mailboxConnections, notifications, readDemotionSignals, tickets, withOrg, workspaces,
} from '../src/index.ts'
import { createDb } from '../src/raw.ts'
import { createTestDatabase, createTestOrganization } from './helpers/test-db.ts'

const NOW = new Date('2026-09-11T12:00:00Z')
const DAY = '2026-09-11'
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000)

describe('autonomy', () => {
  let t: Awaited<ReturnType<typeof createTestDatabase>>
  let handle: ReturnType<typeof createDb>
  let orgId: string
  let userId: string
  let connectionId: string
  let agentId: string
  let categoryId: string
  let ticketSeq = 0

  beforeAll(async () => {
    t = await createTestDatabase()
    handle = createDb(t.url, { role: 'app' })
    orgId = await createTestOrganization(handle)
    await withOrg(handle.db, orgId, (tx) => tx.insert(workspaces).values({ orgId, businessName: 'Acme', timezone: 'UTC' }))

    const usr = await handle.pool.query<{ id: string }>(
      `INSERT INTO "user" (name, email) VALUES ($1, $2) RETURNING id`,
      ['Owner', `owner-${randomBytes(4).toString('hex')}@example.com`],
    )
    userId = usr.rows[0]!.id

    connectionId = await withOrg(handle.db, orgId, async (tx) => {
      const [row] = await tx.insert(mailboxConnections).values({
        orgId, provider: 'gmail', providerAccountId: 'acct-1', emailAddress: 'support@acme.com',
        status: 'connected', connectedByUserId: userId,
      }).returning({ id: mailboxConnections.id })
      return row!.id
    })

    await withOrg(handle.db, orgId, (tx) => ensureDefaultCategories(tx))
    const [cat] = await withOrg(handle.db, orgId, (tx) => tx.select().from(categories).limit(1))
    categoryId = cat!.id

    agentId = await withOrg(handle.db, orgId, async (tx) => {
      const [row] = await tx.insert(agents).values({
        orgId, connectionId, address: 'support@acme.com', domain: 'acme.com', displayName: 'Acme Support', status: 'active',
      }).returning({ id: agents.id })
      return row!.id
    })

    await withOrg(handle.db, orgId, (tx) =>
      tx.insert(agentCategoryPolicies).values({ orgId, agentId, categoryId, mode: 'auto', autoSendMinConfidence: 80 }))
  })
  afterAll(async () => { await handle.pool.end(); await t.drop() })

  const mkTicket = async () => {
    ticketSeq += 1
    return withOrg(handle.db, orgId, async (tx) => {
      const [row] = await tx.insert(tickets).values({ orgId, connectionId, providerThreadId: `thread-${ticketSeq}` }).returning({ id: tickets.id })
      return row!.id
    })
  }

  const mkDraft = async (overrides: Partial<typeof drafts.$inferInsert> = {}) => {
    const ticketId = await mkTicket()
    return withOrg(handle.db, orgId, (tx) => tx.insert(drafts).values({
      orgId, ticketId, agentId, categoryId,
      body: 'Thanks for reaching out.', decision: 'send', decisionReason: 'auto-eligible',
      status: 'sent',
      threadSnapshotAt: new Date(), expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      ...overrides,
    }))
  }

  describe('countHumanDecisions', () => {
    it('counts decided_by IS NOT NULL only (auto-sends never unlock the cold start)', async () => {
      await mkDraft({ decidedBy: userId, decisionSource: 'app', decidedAt: new Date(), status: 'sent' })
      await mkDraft({ decidedBy: userId, decisionSource: 'email', decidedAt: new Date(), status: 'sent' })
      await mkDraft({ decisionSource: 'auto', autoDecidedAt: new Date(), status: 'sent' })   // decided_by stays null

      expect(await withOrg(handle.db, orgId, (tx) => countHumanDecisions(tx, agentId, categoryId))).toBe(2)
    })
  })

  describe('readDemotionSignals', () => {
    it('windows rejections to 7 days, flags to 30, and splits unchanged/edited over 30 days', async () => {
      // rejected 2d ago (counts), rejected 9d ago (does not)
      await mkDraft({ status: 'rejected', decision: 'review', decisionSource: 'app', decidedBy: userId, decidedAt: daysAgo(2) })
      await mkDraft({ status: 'rejected', decision: 'review', decisionSource: 'app', decidedBy: userId, decidedAt: daysAgo(9) })
      // flagged 10d ago (counts), flagged 40d ago (does not)
      await mkDraft({ status: 'sent', flaggedAt: daysAgo(10), flaggedBy: userId })
      await mkDraft({ status: 'sent', flaggedAt: daysAgo(40), flaggedBy: userId })
      // approved unchanged x3 in window
      await mkDraft({ status: 'approved', decisionSource: 'app', decidedBy: userId, decidedAt: daysAgo(3), editDistanceRatio: 0 })
      await mkDraft({ status: 'approved', decisionSource: 'app', decidedBy: userId, decidedAt: daysAgo(5), editDistanceRatio: 0 })
      await mkDraft({ status: 'sent', decisionSource: 'email', decidedBy: userId, decidedAt: daysAgo(10), editDistanceRatio: 0 })
      // one held-then-edited auto draft 1d ago (also the single "edited" decision)
      await mkDraft({
        status: 'approved', decisionSource: 'app', decidedBy: userId, decidedAt: daysAgo(1), editDistanceRatio: 0.4,
        autoDecidedAt: daysAgo(1), autoHeldAt: daysAgo(1),
      })

      const signals = await withOrg(handle.db, orgId, (tx) => readDemotionSignals(tx, {
        agentId, categoryId, now: NOW, windows: { rejectionWindowDays: 7, flagWindowDays: 30, decisionWindowDays: 30 },
      }))
      expect(signals).toEqual({ rejectionsInWindow: 1, flagsInWindow: 1, heldThenChanged: true, decisions: { unchanged: 3, edited: 1 } })
    })
  })

  describe('demoteCategory', () => {
    it('flips auto → review once, writes the audit row and one demotion notification per day', async () => {
      const first = await withOrg(handle.db, orgId, (tx) =>
        demoteCategory(tx, { orgId, agentId, categoryId, categoryLabel: 'Order status', reason: 'rejections', now: NOW, day: DAY, actor: 'user:test' }))
      expect(first.demoted).toBe(true)
      expect(first.notificationId).toBeDefined()

      const again = await withOrg(handle.db, orgId, (tx) =>
        demoteCategory(tx, { orgId, agentId, categoryId, categoryLabel: 'Order status', reason: 'rejections', now: NOW, day: DAY, actor: 'user:test' }))
      expect(again).toEqual({ demoted: false })

      const [policy] = await withOrg(handle.db, orgId, (tx) => tx.select().from(agentCategoryPolicies).where(eq(agentCategoryPolicies.agentId, agentId)))
      expect(policy).toMatchObject({ mode: 'review', demotedReason: 'rejections' })
      expect(policy!.demotedAt?.toISOString()).toBe(NOW.toISOString())

      const [n] = await withOrg(handle.db, orgId, (tx) => tx.select().from(notifications).where(eq(notifications.id, first.notificationId!)))
      expect(n).toMatchObject({ kind: 'demotion', payload: { agentId, categoryId } })
    })
  })

  describe('graduateCategory', () => {
    it('(auto: false) records the suggestion and pages once per ISO week; (auto: true) flips review → auto with the threshold', async () => {
      // demote first so mode is 'review' (idempotent: a no-op if the previous test already demoted it)
      await withOrg(handle.db, orgId, (tx) =>
        demoteCategory(tx, { orgId, agentId, categoryId, categoryLabel: 'Order status', reason: 'rejections', now: NOW, day: DAY, actor: 'user:test' }))

      const suggested = await withOrg(handle.db, orgId, (tx) => graduateCategory(tx, {
        orgId, agentId, categoryId, categoryLabel: 'Order status', threshold: 80, wouldSend: 17, of: 20,
        now: NOW, day: DAY, weekKey: '2026-W37', actor: 'system:cron:stats.rollup', auto: false,
      }))
      expect(suggested.changed).toBe(true)
      expect(suggested.notificationId).toBeDefined()

      const [afterSuggest] = await withOrg(handle.db, orgId, (tx) => tx.select().from(agentCategoryPolicies).where(eq(agentCategoryPolicies.agentId, agentId)))
      expect(afterSuggest).toMatchObject({ mode: 'review', suggestedWouldSend: 17, suggestedOf: 20 })
      expect(afterSuggest!.suggestedAt?.toISOString()).toBe(NOW.toISOString())

      const turnedOn = await withOrg(handle.db, orgId, (tx) => graduateCategory(tx, {
        orgId, agentId, categoryId, categoryLabel: 'Order status', threshold: 80, wouldSend: 17, of: 20,
        now: NOW, day: DAY, weekKey: '2026-W37', actor: 'system:cron:stats.rollup', auto: true,
      }))
      expect(turnedOn.changed).toBe(true)
      expect(turnedOn.notificationId).toBeDefined()

      const [afterAuto] = await withOrg(handle.db, orgId, (tx) => tx.select().from(agentCategoryPolicies).where(eq(agentCategoryPolicies.agentId, agentId)))
      expect(afterAuto).toMatchObject({ mode: 'auto', autoSendMinConfidence: 80, suggestedAt: null, suggestedWouldSend: null, suggestedOf: null })
      expect(afterAuto!.graduatedAt?.toISOString()).toBe(NOW.toISOString())

      const [n] = await withOrg(handle.db, orgId, (tx) => tx.select().from(notifications).where(eq(notifications.id, turnedOn.notificationId!)))
      expect(n).toMatchObject({ kind: 'graduation' })
    })
  })
})
