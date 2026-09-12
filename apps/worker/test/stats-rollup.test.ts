/**
 * `stats.rollup` against Postgres + a real (test) pg-boss: the nightly `category_stats_daily`
 * recompute, the graduation suggestion / auto-graduation, the demotion backstop, and the Monday
 * sampling nudge. One org per test (each test's own org carries its own `agent_category_policies`
 * row — that table is the pass's ONLY source of "which orgs to visit", so a test whose org has no
 * policy row at all would simply never be reached). Styled after `sweeps-daily.test.ts` /
 * `ticket-backstop-sweep.test.ts`.
 *
 * The whole file shares ONE throwaway database, and `runStatsRollup` visits every org that has a
 * policy row — including ones seeded by earlier tests in this file. That is harmless for every
 * counter this file asserts on (a completed graduation/demotion never re-fires once the policy's
 * mode has flipped, and the daily upsert is idempotent), but it means the PASS-LEVEL return value
 * (`orgs`/`rows`/`suggested`/`graduated`/`demoted`/`nudged`) can include other tests' orgs too — so
 * assertions on it use `toBeGreaterThanOrEqual`, never an exact count. Every exact assertion instead
 * reads the database directly, scoped to this test's own org/agent/category/notification ids.
 */
import { randomBytes } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import type PgBoss from 'pg-boss'
import pino from 'pino'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  agentCategoryPolicies, agents, categories, categoryStatsDaily, drafts, ensureDefaultCategories,
  mailboxConnections, notifications, resolvedAnswers, tickets, user, withOrg, workspaces,
} from '@aesa/db'
import { createDb } from '@aesa/db/raw'
import { createTestDatabase, createTestOrganization } from '@aesa/db/testing'
import { JOB_NAMES } from '@aesa/queue'
import { utcDayString, utcWeekString } from '../src/date-utils.ts'
import { runStatsRollup, type StatsRollupDeps } from '../src/jobs/stats-rollup.ts'
import { deleteJobsForOrgs, queryJobs, startTestBoss } from './helpers/boss.ts'

const rand = () => randomBytes(4).toString('hex')
// A Friday — never accidentally a Monday, so the sampling nudge never leaks into the other tests.
const NOW = new Date('2026-09-11T12:00:00Z')
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60_000)
const dayString = (n: number) => utcDayString(daysAgo(n))

describe('stats.rollup', () => {
  let t: Awaited<ReturnType<typeof createTestDatabase>>
  let app: ReturnType<typeof createDb>
  let boss: PgBoss
  let userId: string
  const createdOrgIds: string[] = []

  beforeAll(async () => {
    t = await createTestDatabase()
    app = createDb(t.url)
    boss = await startTestBoss()
    await boss.createQueue(JOB_NAMES.notifyDispatch)
    const [u] = await app.db.insert(user).values({ name: 'Owner', email: `owner-${rand()}@example.com` }).returning()
    userId = u!.id
  })
  afterAll(async () => {
    await deleteJobsForOrgs(JOB_NAMES.notifyDispatch, createdOrgIds)
    await boss.stop({ graceful: false, wait: true })
    await app.pool.end()
    await t.drop()
  })

  function makeDeps(overrides: Partial<StatsRollupDeps> = {}): StatsRollupDeps {
    return { db: app.db, logger: pino({ level: 'silent' }), now: () => NOW, ...overrides }
  }

  interface SeedOrgOpts {
    mode?: 'off' | 'review' | 'auto'
    autoGraduate?: boolean
    demotedAt?: Date | null
    categoryKey?: string
  }

  /** One org, one connection, one active agent, the default categories, and ONE policy row on the
   *  requested category (default `order_status`, default `mode: 'off'`) — every test's org needs at
   *  least one policy row to be visited by the pass at all (see file header). */
  async function seedOrg(opts: SeedOrgOpts = {}): Promise<{
    orgId: string; connectionId: string; agentId: string; categoryId: string; categoryIds: Record<string, string>
  }> {
    const orgId = await createTestOrganization(app)
    createdOrgIds.push(orgId)
    return withOrg(app.db, orgId, async (tx) => {
      await tx.insert(workspaces).values({ orgId, businessName: 'Acme Dog Supplies', timezone: 'UTC' })
      await ensureDefaultCategories(tx)
      const cats = await tx.select({ id: categories.id, key: categories.key }).from(categories)
      const categoryIds = Object.fromEntries(cats.map((c) => [c.key, c.id]))
      const [conn] = await tx.insert(mailboxConnections).values({
        orgId, provider: 'gmail', providerAccountId: `acct-${rand()}`, emailAddress: `support-${rand()}@acme.test`,
        status: 'connected', connectedByUserId: userId,
      }).returning({ id: mailboxConnections.id })
      const [agent] = await tx.insert(agents).values({
        orgId, connectionId: conn!.id, address: `support-${rand()}@acme.test`, domain: 'acme.test', displayName: 'Acme Support',
        status: 'active', priority: 0, autoGraduate: opts.autoGraduate ?? false,
      }).returning({ id: agents.id })
      const categoryId = categoryIds[opts.categoryKey ?? 'order_status']!
      await tx.insert(agentCategoryPolicies).values({
        orgId, agentId: agent!.id, categoryId, mode: opts.mode ?? 'off', demotedAt: opts.demotedAt ?? null,
      })
      return { orgId, connectionId: conn!.id, agentId: agent!.id, categoryId, categoryIds }
    })
  }

  async function addPolicy(orgId: string, agentId: string, categoryId: string, opts: SeedOrgOpts = {}): Promise<void> {
    await withOrg(app.db, orgId, (tx) =>
      tx.insert(agentCategoryPolicies).values({
        orgId, agentId, categoryId, mode: opts.mode ?? 'off', demotedAt: opts.demotedAt ?? null,
      }))
  }

  async function getPolicy(orgId: string, agentId: string, categoryId: string) {
    const [row] = await withOrg(app.db, orgId, (tx) =>
      tx.select().from(agentCategoryPolicies).where(and(eq(agentCategoryPolicies.agentId, agentId), eq(agentCategoryPolicies.categoryId, categoryId))))
    return row!
  }

  /** Full control over every column the rollup reads — one draft, one throwaway ticket. */
  async function seedDraft(
    orgId: string, connectionId: string, agentId: string, categoryId: string,
    overrides: Partial<typeof drafts.$inferInsert>,
  ): Promise<void> {
    const [ticketRow] = await withOrg(app.db, orgId, (tx) =>
      tx.insert(tickets).values({ orgId, connectionId, agentId, providerThreadId: `thread-${rand()}`, status: 'resolved', categoryId }).returning({ id: tickets.id }))
    await withOrg(app.db, orgId, (tx) =>
      tx.insert(drafts).values({
        orgId, ticketId: ticketRow!.id, agentId, categoryId, version: 1, body: 'draft body',
        decision: 'review', decisionReason: 'below_threshold', status: 'pending',
        threadSnapshotAt: NOW, expiresAt: new Date(NOW.getTime() + 86_400_000), createdAt: NOW,
        ...overrides,
      }))
  }

  /** An `app`-decided, unchanged (ratio 0), approved-and-sent draft — the shape `evaluateGraduation`'s
   *  sample reads — with an explicit `confidenceBreakdown.evidence`. */
  async function seedUnchangedApproval(
    orgId: string, connectionId: string, agentId: string, categoryId: string, decidedAt: Date, evidence: number,
  ): Promise<void> {
    await seedDraft(orgId, connectionId, agentId, categoryId, {
      status: 'sent', decisionSource: 'app', decidedBy: userId, decidedAt, editDistanceRatio: 0,
      createdAt: decidedAt, confidenceBreakdown: { evidence },
    })
  }

  async function statsRow(orgId: string, agentId: string, categoryId: string, day: string) {
    const [row] = await withOrg(app.db, orgId, (tx) =>
      tx.select().from(categoryStatsDaily).where(and(
        eq(categoryStatsDaily.agentId, agentId), eq(categoryStatsDaily.categoryId, categoryId), eq(categoryStatsDaily.day, day),
      )))
    return row
  }

  async function notificationsFor(orgId: string, kind: string) {
    return withOrg(app.db, orgId, (tx) => tx.select().from(notifications).where(and(eq(notifications.orgId, orgId), eq(notifications.kind, kind))))
  }

  async function notifyJobs() {
    return queryJobs(JOB_NAMES.notifyDispatch)
  }

  async function seedCandidateAnswer(orgId: string): Promise<void> {
    await withOrg(app.db, orgId, (tx) =>
      tx.insert(resolvedAnswers).values({
        orgId, questionText: 'How do I track my order?', answerBody: 'Use the tracking link in your confirmation email.',
        status: 'candidate', expiresAt: new Date(NOW.getTime() + 365 * 86_400_000), createdAt: NOW,
      }))
  }

  describe('utcWeekString', () => {
    it('is ISO-correct across a year boundary', () => {
      // Jan 1 2026 is a Thursday, so ISO week 1 of 2026 starts Monday Dec 29 2025.
      expect(utcWeekString(new Date('2025-12-29T00:00:00Z'))).toBe('2026-W01')
      expect(utcWeekString(new Date('2026-01-01T00:00:00Z'))).toBe('2026-W01')
      // Jan 1 2027 is a Friday; its ISO week's Thursday (Dec 31 2026) is still in 2026, which has 53
      // ISO weeks (Jan 1 2026 is a Thursday).
      expect(utcWeekString(new Date('2027-01-01T00:00:00Z'))).toBe('2026-W53')
    })
  })

  it('recomputes category_stats_daily for the trailing 30 days: drafted by created day, decisions by decided day, auto_sent by auto_decided day, confirmed only past 7 days with no flag and no hold-then-change', async () => {
    const { orgId, connectionId, agentId, categoryId } = await seedOrg()

    // drafted only, no decision at all.
    await seedDraft(orgId, connectionId, agentId, categoryId, { createdAt: daysAgo(20), status: 'pending' })
    // approved unchanged.
    await seedDraft(orgId, connectionId, agentId, categoryId, {
      createdAt: daysAgo(3), decidedAt: daysAgo(3), decisionSource: 'app', status: 'approved', editDistanceRatio: 0,
    })
    // approved edited.
    await seedDraft(orgId, connectionId, agentId, categoryId, {
      createdAt: daysAgo(4), decidedAt: daysAgo(4), decisionSource: 'email', status: 'sent', editDistanceRatio: 0.3,
    })
    // rejected.
    await seedDraft(orgId, connectionId, agentId, categoryId, {
      createdAt: daysAgo(2), decidedAt: daysAgo(2), decisionSource: 'app', status: 'rejected',
    })
    // auto-sent, too recent to be confirmed (1 day old).
    await seedDraft(orgId, connectionId, agentId, categoryId, {
      createdAt: daysAgo(1), autoDecidedAt: daysAgo(1), decisionSource: 'auto', status: 'sent',
    })
    // auto-sent, confirmed (10 days old, no flag, no hold).
    await seedDraft(orgId, connectionId, agentId, categoryId, {
      createdAt: daysAgo(10), autoDecidedAt: daysAgo(10), decisionSource: 'auto', status: 'sent',
    })
    // auto-sent, flagged — old enough to otherwise confirm, but the flag excludes it.
    await seedDraft(orgId, connectionId, agentId, categoryId, {
      createdAt: daysAgo(8), autoDecidedAt: daysAgo(8), decisionSource: 'auto', status: 'sent', flaggedAt: daysAgo(1),
    })
    // auto-sent, held — old enough to otherwise confirm, but hold-then-change excludes it; the hold
    // itself lands on ITS OWN day, distinct from the auto-decided day.
    await seedDraft(orgId, connectionId, agentId, categoryId, {
      createdAt: daysAgo(9), autoDecidedAt: daysAgo(9), autoHeldAt: daysAgo(6), decisionSource: 'auto', status: 'sent',
    })
    // entirely outside the 30-day window — never loaded at all.
    await seedDraft(orgId, connectionId, agentId, categoryId, { createdAt: daysAgo(40), status: 'pending' })

    const result = await runStatsRollup(boss, makeDeps())
    expect(result.orgs).toBeGreaterThanOrEqual(1)
    expect(result.rows).toBeGreaterThanOrEqual(8)

    expect(await statsRow(orgId, agentId, categoryId, dayString(20))).toMatchObject({ drafted: 1 })
    expect(await statsRow(orgId, agentId, categoryId, dayString(3))).toMatchObject({ drafted: 1, approvedUnchanged: 1 })
    expect(await statsRow(orgId, agentId, categoryId, dayString(4))).toMatchObject({ drafted: 1, approvedEdited: 1 })
    expect(await statsRow(orgId, agentId, categoryId, dayString(2))).toMatchObject({ drafted: 1, rejected: 1 })
    expect(await statsRow(orgId, agentId, categoryId, dayString(1))).toMatchObject({ drafted: 1, autoSent: 1, autoSentConfirmed: 0 })
    expect(await statsRow(orgId, agentId, categoryId, dayString(10))).toMatchObject({ drafted: 1, autoSent: 1, autoSentConfirmed: 1 })
    expect(await statsRow(orgId, agentId, categoryId, dayString(8))).toMatchObject({ drafted: 1, autoSent: 1, autoSentFlagged: 1, autoSentConfirmed: 0 })
    expect(await statsRow(orgId, agentId, categoryId, dayString(9))).toMatchObject({ drafted: 1, autoSent: 1, autoSentConfirmed: 0 })
    expect(await statsRow(orgId, agentId, categoryId, dayString(6))).toMatchObject({ held: 1 })
    expect(await statsRow(orgId, agentId, categoryId, dayString(40))).toBeUndefined()
  })

  it('never overwrites a day outside the trailing window with a partial recompute: a draft created 33 days ago but decided 2 days ago leaves that old, already-complete day untouched', async () => {
    const { orgId, connectionId, agentId, categoryId } = await seedOrg()

    // A complete, previously-computed row for a day that is genuinely outside the 30-day window.
    await withOrg(app.db, orgId, (tx) =>
      tx.insert(categoryStatsDaily).values({
        orgId, agentId, categoryId, day: dayString(33),
        drafted: 120, approvedUnchanged: 95, approvedEdited: 10, rejected: 5,
        autoSent: 30, autoSentConfirmed: 25, autoSentFlagged: 1, held: 2,
      }))

    // Created 33 days ago (outside the window — this draft is loaded ONLY via its decidedAt leg).
    await seedDraft(orgId, connectionId, agentId, categoryId, {
      createdAt: daysAgo(33), decidedAt: daysAgo(2), decisionSource: 'app', status: 'approved', editDistanceRatio: 0,
    })

    await runStatsRollup(boss, makeDeps())

    // The old day's row is untouched — the buggy version wrote drafted:1 and zeroed every other
    // counter here, destroying a day this pass had no business touching at all.
    expect(await statsRow(orgId, agentId, categoryId, dayString(33))).toMatchObject({
      drafted: 120, approvedUnchanged: 95, approvedEdited: 10, rejected: 5,
      autoSent: 30, autoSentConfirmed: 25, autoSentFlagged: 1, held: 2,
    })
    // The decision itself still lands correctly, on its OWN day.
    expect(await statsRow(orgId, agentId, categoryId, dayString(2))).toMatchObject({ approvedUnchanged: 1 })
  })

  it("the trailing window is day-aligned, not instant-aligned: a draft on the cutoff's own calendar day counts in full even before the cron's own run time that day", async () => {
    const { orgId, connectionId, agentId, categoryId } = await seedOrg()
    const runAt = new Date('2026-09-11T02:15:00Z') // stats.rollup's own schedule (15 2 * * *)
    const onCutoffDay = new Date('2026-08-12T01:00:00Z') // the cutoff calendar day, before 02:15Z

    await seedDraft(orgId, connectionId, agentId, categoryId, {
      createdAt: onCutoffDay, decidedAt: onCutoffDay, decisionSource: 'app', status: 'approved', editDistanceRatio: 0,
    })

    await runStatsRollup(boss, makeDeps({ now: () => runAt }))

    expect(await statsRow(orgId, agentId, categoryId, utcDayString(onCutoffDay))).toMatchObject({ drafted: 1, approvedUnchanged: 1 })
  })

  it("suggests Autopilot for a review category that earns it (≥20 decisions, ≥90% unchanged, no rejection in 14 d): suggested_* set from the last 20 unchanged approvals' evidence ≥ 0.80, one graduation notification, mode unchanged", async () => {
    const { orgId, connectionId, agentId, categoryId } = await seedOrg({ mode: 'review', autoGraduate: false })

    // 20 unchanged human approvals, 15 at/above the 80% evidence bar and 5 below it.
    for (let i = 0; i < 15; i++) await seedUnchangedApproval(orgId, connectionId, agentId, categoryId, daysAgo(i + 1), 0.85)
    for (let i = 15; i < 20; i++) await seedUnchangedApproval(orgId, connectionId, agentId, categoryId, daysAgo(i + 1), 0.5)

    const result = await runStatsRollup(boss, makeDeps())
    expect(result.suggested).toBeGreaterThanOrEqual(1)

    const policy = await getPolicy(orgId, agentId, categoryId)
    expect(policy.mode).toBe('review') // unchanged — only auto_graduate flips it on
    expect(policy.suggestedWouldSend).toBe(15)
    expect(policy.suggestedOf).toBe(20)
    expect(policy.suggestedAt?.toISOString()).toBe(NOW.toISOString())

    const notifs = await notificationsFor(orgId, 'graduation')
    expect(notifs).toHaveLength(1)
    expect(notifs[0]!.title).toContain('ready for Autopilot')
    expect(notifs[0]!.dedupeKey).toBe(`graduation_suggest:${agentId}:${categoryId}:${utcWeekString(NOW)}`)

    const jobs = await notifyJobs()
    expect(jobs.some((j) => (j.data as { notificationId: string }).notificationId === notifs[0]!.id)).toBe(true)
  })

  it('turns Autopilot ON for an agent with auto_graduate: mode auto, threshold 80, graduated_at, notification "Autopilot is on"', async () => {
    const { orgId, connectionId, agentId, categoryId } = await seedOrg({ mode: 'review', autoGraduate: true })

    for (let i = 0; i < 20; i++) await seedUnchangedApproval(orgId, connectionId, agentId, categoryId, daysAgo(i + 1), 0.9)

    const result = await runStatsRollup(boss, makeDeps())
    expect(result.graduated).toBeGreaterThanOrEqual(1)

    const policy = await getPolicy(orgId, agentId, categoryId)
    expect(policy.mode).toBe('auto')
    expect(policy.autoSendMinConfidence).toBe(80)
    expect(policy.graduatedAt?.toISOString()).toBe(NOW.toISOString())
    expect(policy.suggestedAt).toBeNull()

    const notifs = await notificationsFor(orgId, 'graduation')
    expect(notifs).toHaveLength(1)
    expect(notifs[0]!.title).toBe('Autopilot is on for Order status')
  })

  it('does not suggest a category already in auto, one the owner switched off, or one under 20 decisions', async () => {
    const { orgId, connectionId, agentId, categoryId: autoCategoryId, categoryIds } = await seedOrg({ mode: 'auto' })
    const offCategoryId = categoryIds['shipping_delivery']!
    const underCountCategoryId = categoryIds['returns_refunds']!
    await addPolicy(orgId, agentId, offCategoryId, { mode: 'off' })
    await addPolicy(orgId, agentId, underCountCategoryId, { mode: 'review' })

    // 20 unchanged decisions on the already-auto and the switched-off categories.
    for (let i = 0; i < 20; i++) {
      await seedUnchangedApproval(orgId, connectionId, agentId, autoCategoryId, daysAgo(i + 1), 0.9)
      await seedUnchangedApproval(orgId, connectionId, agentId, offCategoryId, daysAgo(i + 1), 0.9)
    }
    // only 10 decisions on the review category — under GRADUATION_RULES.minDecisions.
    for (let i = 0; i < 10; i++) await seedUnchangedApproval(orgId, connectionId, agentId, underCountCategoryId, daysAgo(i + 1), 0.9)

    await runStatsRollup(boss, makeDeps())

    expect((await getPolicy(orgId, agentId, autoCategoryId)).mode).toBe('auto')
    expect((await getPolicy(orgId, agentId, offCategoryId)).mode).toBe('off')
    const underCount = await getPolicy(orgId, agentId, underCountCategoryId)
    expect(underCount.mode).toBe('review')
    expect(underCount.suggestedAt).toBeNull()

    expect(await notificationsFor(orgId, 'graduation')).toHaveLength(0)
    expect(await notificationsFor(orgId, 'demotion')).toHaveLength(0)
  })

  it('does not re-suggest a category demoted within the last 14 days, even though it otherwise qualifies', async () => {
    const { orgId, connectionId, agentId, categoryId } = await seedOrg({ mode: 'review', demotedAt: daysAgo(5) })

    for (let i = 0; i < 20; i++) await seedUnchangedApproval(orgId, connectionId, agentId, categoryId, daysAgo(i + 1), 0.9)

    await runStatsRollup(boss, makeDeps())

    const policy = await getPolicy(orgId, agentId, categoryId)
    expect(policy.mode).toBe('review')
    expect(policy.suggestedAt).toBeNull()
    expect(await notificationsFor(orgId, 'graduation')).toHaveLength(0)
  })

  it('demotes an auto category whose live signals trip a rule (the nightly backstop)', async () => {
    const { orgId, connectionId, agentId, categoryId } = await seedOrg({ mode: 'auto' })

    // Two rejections inside the 7-day rejection window trips DEMOTION_RULES.rejections.
    await seedDraft(orgId, connectionId, agentId, categoryId, {
      createdAt: daysAgo(2), decidedAt: daysAgo(2), decisionSource: 'app', status: 'rejected',
    })
    await seedDraft(orgId, connectionId, agentId, categoryId, {
      createdAt: daysAgo(3), decidedAt: daysAgo(3), decisionSource: 'app', status: 'rejected',
    })

    const result = await runStatsRollup(boss, makeDeps())
    expect(result.demoted).toBeGreaterThanOrEqual(1)

    const policy = await getPolicy(orgId, agentId, categoryId)
    expect(policy.mode).toBe('review')
    expect(policy.demotedReason).toBe('rejections')
    expect(policy.demotedAt?.toISOString()).toBe(NOW.toISOString())

    const notifs = await notificationsFor(orgId, 'demotion')
    expect(notifs).toHaveLength(1)
    expect(notifs[0]!.title).toBe('Autopilot paused for Order status')

    const jobs = await notifyJobs()
    expect(jobs.some((j) => (j.data as { notificationId: string }).notificationId === notifs[0]!.id)).toBe(true)
  })

  describe('the Monday sampling nudge', () => {
    const MONDAY = new Date('2026-09-14T09:00:00Z')

    it('nudges once per ISO week on a Monday when candidates exist, never on other days and never without candidates', async () => {
      // A: Monday, candidates exist — nudges.
      const orgA = await seedOrg()
      await seedCandidateAnswer(orgA.orgId)
      await seedCandidateAnswer(orgA.orgId)
      const firstRun = await runStatsRollup(boss, makeDeps({ now: () => MONDAY }))
      expect(firstRun.nudged).toBeGreaterThanOrEqual(1)
      const notifsA = await notificationsFor(orgA.orgId, 'memory_sample')
      expect(notifsA).toHaveLength(1)
      expect(notifsA[0]!.title).toBe('Auto-sent replies to check')
      expect(notifsA[0]!.body).toBe('2 auto-sent replies are waiting for a quick look in Settings › Learned answers.')
      expect(notifsA[0]!.dedupeKey).toBe(`memory_sample:${orgA.orgId}:${utcWeekString(MONDAY)}`)
      const jobs = await notifyJobs()
      expect(jobs.some((j) => (j.data as { notificationId: string }).notificationId === notifsA[0]!.id)).toBe(true)

      // Running again on the SAME Monday (same ISO week) adds nothing more.
      const secondRun = await runStatsRollup(boss, makeDeps({ now: () => MONDAY }))
      expect(secondRun.nudged).toBe(0)
      expect(await notificationsFor(orgA.orgId, 'memory_sample')).toHaveLength(1)

      // B: candidates exist, but it is not Monday — never nudges.
      const orgB = await seedOrg()
      await seedCandidateAnswer(orgB.orgId)
      await runStatsRollup(boss, makeDeps({ now: () => NOW }))
      expect(await notificationsFor(orgB.orgId, 'memory_sample')).toHaveLength(0)

      // C: Monday, but no candidates — never nudges.
      const orgC = await seedOrg()
      await runStatsRollup(boss, makeDeps({ now: () => MONDAY }))
      expect(await notificationsFor(orgC.orgId, 'memory_sample')).toHaveLength(0)
    })
  })
})
