/**
 * `sweeps.daily` against Postgres + a real (test) pg-boss: the draft-expiry pass (with its
 * `escalateTicket` side effect on `pending`-sourced expiries only), and the two retention deletes.
 * Styled after `mailbox-poll-sweep.test.ts` / `ticket-backstop-sweep.test.ts` — seed the exact row
 * shape one case needs, run the sweep, assert.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import type PgBoss from 'pg-boss'
import pino from 'pino'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MEMORY_CANDIDATE_MAX_AGE_DAYS } from '@aesa/core'
import {
  agentRunEvents, agentRuns, auditLog, draftActionTokens, drafts, knowledgeChunks, knowledgeDocuments, knowledgeSources,
  mailboxConnections, resolvedAnswers, tickets, user, withOrg, withPlatform,
} from '@aesa/db'
import { createDb } from '@aesa/db/raw'
import { createTestDatabase, createTestOrganization } from '@aesa/db/testing'
import { JOB_NAMES } from '@aesa/queue'
import {
  ACTION_TOKEN_RETENTION_DAYS, runSweepsDaily, RUN_EVENT_RETENTION_DAYS, type SweepsDailyDeps,
} from '../src/jobs/sweeps-daily.ts'
import { deleteJobsForOrgs, queryJobs, startTestBoss } from './helpers/boss.ts'

const rand = () => randomBytes(4).toString('hex')
const NOW = new Date('2026-09-09T12:00:00Z')
const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60_000)
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60_000)

describe('sweeps.daily', () => {
  let t: Awaited<ReturnType<typeof createTestDatabase>>
  let app: ReturnType<typeof createDb>
  let boss: PgBoss
  let userId: string
  const createdOrgIds: string[] = []
  const connectionByOrg = new Map<string, string>()

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

  function makeDeps(overrides: Partial<SweepsDailyDeps> = {}): SweepsDailyDeps {
    return { db: app.db, logger: pino({ level: 'silent' }), now: () => NOW, ...overrides }
  }

  async function newOrg(): Promise<string> {
    const orgId = await createTestOrganization(app)
    createdOrgIds.push(orgId)
    const [conn] = await withOrg(app.db, orgId, (tx) =>
      tx
        .insert(mailboxConnections)
        .values({
          orgId, provider: 'gmail', providerAccountId: `acct-${rand()}`, emailAddress: `support-${rand()}@acme.test`,
          status: 'connected', connectedByUserId: userId,
        })
        .returning({ id: mailboxConnections.id }))
    connectionByOrg.set(orgId, conn!.id)
    return orgId
  }

  async function seedTicket(orgId: string, overrides: Partial<typeof tickets.$inferInsert> = {}): Promise<string> {
    const connectionId = connectionByOrg.get(orgId)!
    const [row] = await withOrg(app.db, orgId, (tx) =>
      tx
        .insert(tickets)
        .values({ orgId, connectionId, providerThreadId: `thread-${rand()}`, status: 'awaiting_review', ...overrides })
        .returning({ id: tickets.id }))
    return row!.id
  }

  async function getTicket(orgId: string, ticketId: string) {
    const [row] = await withOrg(app.db, orgId, (tx) => tx.select().from(tickets).where(eq(tickets.id, ticketId)))
    return row!
  }

  async function seedDraft(orgId: string, ticketId: string, overrides: Partial<typeof drafts.$inferInsert> = {}): Promise<string> {
    const [row] = await withOrg(app.db, orgId, (tx) =>
      tx
        .insert(drafts)
        .values({
          orgId, ticketId, body: 'draft body', decision: 'review', decisionReason: 'below_threshold',
          status: 'pending', threadSnapshotAt: NOW, expiresAt: minutesAgo(60), ...overrides,
        })
        .returning({ id: drafts.id }))
    return row!.id
  }

  async function getDraft(orgId: string, draftId: string) {
    const [row] = await withOrg(app.db, orgId, (tx) => tx.select().from(drafts).where(eq(drafts.id, draftId)))
    return row!
  }

  async function auditRowsFor(entityId: string, action: string) {
    return withPlatform(app.db, 'test:audit', (tx) => tx.select().from(auditLog).where(and(eq(auditLog.entityId, entityId), eq(auditLog.action, action))))
  }

  async function notifyJobs() {
    return queryJobs(JOB_NAMES.notifyDispatch)
  }

  async function seedAnswer(orgId: string, overrides: Partial<typeof resolvedAnswers.$inferInsert> = {}): Promise<string> {
    const [row] = await withOrg(app.db, orgId, (tx) =>
      tx.insert(resolvedAnswers).values({
        orgId, questionText: 'How do I track my order?', answerBody: 'Use the tracking link in your confirmation email.',
        status: 'active', expiresAt: new Date(NOW.getTime() + 365 * 24 * 60 * 60_000), createdAt: NOW, ...overrides,
      }).returning({ id: resolvedAnswers.id }))
    return row!.id
  }

  async function getAnswer(orgId: string, id: string) {
    const [row] = await withOrg(app.db, orgId, (tx) => tx.select().from(resolvedAnswers).where(eq(resolvedAnswers.id, id)))
    return row!
  }

  /** One minimal source → document → chunk chain, so arm (f) has a chunk id that genuinely exists. */
  async function seedChunk(orgId: string): Promise<string> {
    return withOrg(app.db, orgId, async (tx) => {
      const [source] = await tx.insert(knowledgeSources)
        .values({ orgId, kind: 'paste', status: 'ready', title: 'FAQ', pastedText: 'Orders ship within two business days.' })
        .returning({ id: knowledgeSources.id })
      const [doc] = await tx.insert(knowledgeDocuments)
        .values({ orgId, sourceId: source!.id, uri: `paste:${source!.id}`, contentHash: 'h'.repeat(64), chunkCount: 1 })
        .returning({ id: knowledgeDocuments.id })
      const [chunk] = await tx.insert(knowledgeChunks)
        .values({ orgId, documentId: doc!.id, ordinal: 0, content: 'Orders ship within two business days.', tokenCount: 8 })
        .returning({ id: knowledgeChunks.id })
      return chunk!.id
    })
  }

  describe('(a) draft expiry', () => {
    it('an expired pending draft is flipped to expired; its awaiting_review ticket is escalated draft_expired with a notification', async () => {
      const orgId = await newOrg()
      const ticketId = await seedTicket(orgId, { status: 'awaiting_review' })
      const draftId = await seedDraft(orgId, ticketId, { status: 'pending', expiresAt: minutesAgo(60) })

      const result = await runSweepsDaily(boss, makeDeps())

      expect(result.expiredDrafts).toBeGreaterThanOrEqual(1)
      const draft = await getDraft(orgId, draftId)
      expect(draft.status).toBe('expired')
      const ticket = await getTicket(orgId, ticketId)
      expect(ticket.status).toBe('needs_owner')
      expect(ticket.needsOwnerReason).toBe('draft_expired')
      const audits = await auditRowsFor(draftId, 'draft.expired')
      expect(audits).toHaveLength(1)
      expect(audits[0]!.detail).toEqual({ via: 'sweep' })
      const jobs = await notifyJobs()
      expect(jobs.length).toBeGreaterThan(0)
    })

    it('a held expired draft is flipped to expired but never escalates the ticket, even if it is elsewhere', async () => {
      const orgId = await newOrg()
      const ticketId = await seedTicket(orgId, { status: 'needs_owner', needsOwnerReason: 'send_failed' })
      const draftId = await seedDraft(orgId, ticketId, { status: 'held', expiresAt: minutesAgo(60) })

      await runSweepsDaily(boss, makeDeps())

      const draft = await getDraft(orgId, draftId)
      expect(draft.status).toBe('expired')
      const ticket = await getTicket(orgId, ticketId)
      expect(ticket.status).toBe('needs_owner')
      expect(ticket.needsOwnerReason).toBe('send_failed') // untouched — not overwritten with draft_expired
      const audits = await auditRowsFor(draftId, 'draft.expired')
      expect(audits).toHaveLength(1)
    })

    it('an unexpired draft stays pending', async () => {
      const orgId = await newOrg()
      const ticketId = await seedTicket(orgId, { status: 'awaiting_review' })
      const draftId = await seedDraft(orgId, ticketId, { status: 'pending', expiresAt: new Date(NOW.getTime() + 60_000) })

      await runSweepsDaily(boss, makeDeps())

      const draft = await getDraft(orgId, draftId)
      expect(draft.status).toBe('pending')
    })

    it('a sent draft past its expires_at never expires — decided rows never expire', async () => {
      const orgId = await newOrg()
      const ticketId = await seedTicket(orgId, { status: 'waiting_on_customer' })
      const draftId = await seedDraft(orgId, ticketId, { status: 'sent', expiresAt: minutesAgo(60) })

      await runSweepsDaily(boss, makeDeps())

      const draft = await getDraft(orgId, draftId)
      expect(draft.status).toBe('sent')
    })

    it('a second run adds nothing further', async () => {
      const orgId = await newOrg()
      const ticketId = await seedTicket(orgId, { status: 'awaiting_review' })
      const draftId = await seedDraft(orgId, ticketId, { status: 'pending', expiresAt: minutesAgo(60) })

      const first = await runSweepsDaily(boss, makeDeps())
      expect(first.expiredDrafts).toBeGreaterThanOrEqual(1)
      const auditsAfterFirst = await auditRowsFor(draftId, 'draft.expired')
      expect(auditsAfterFirst).toHaveLength(1)

      const second = await runSweepsDaily(boss, makeDeps())
      expect(second.expiredDrafts).toBe(0)
      const auditsAfterSecond = await auditRowsFor(draftId, 'draft.expired')
      expect(auditsAfterSecond).toHaveLength(1) // no new row
      const ticket = await getTicket(orgId, ticketId)
      expect(ticket.status).toBe('needs_owner') // unchanged by the second run
    })
  })

  describe('(b) agent_run_events retention', () => {
    it(`deletes events older than ${RUN_EVENT_RETENTION_DAYS} days; keeps newer ones and the parent run`, async () => {
      const orgId = await newOrg()
      const [run] = await withOrg(app.db, orgId, (tx) =>
        tx.insert(agentRuns).values({ orgId, kind: 'draft', provider: 'anthropic', model: 'claude-x', startedAt: NOW }).returning({ id: agentRuns.id }))
      const runId = run!.id
      const [oldEvent] = await withOrg(app.db, orgId, (tx) =>
        tx.insert(agentRunEvents).values({ orgId, runId, seq: 1, kind: 'prompt', createdAt: daysAgo(RUN_EVENT_RETENTION_DAYS + 1) }).returning({ id: agentRunEvents.id }))
      const [newEvent] = await withOrg(app.db, orgId, (tx) =>
        tx.insert(agentRunEvents).values({ orgId, runId, seq: 2, kind: 'call', createdAt: daysAgo(1) }).returning({ id: agentRunEvents.id }))

      const result = await runSweepsDaily(boss, makeDeps())

      expect(result.eventsDeleted).toBeGreaterThanOrEqual(1)
      const remaining = await withOrg(app.db, orgId, (tx) => tx.select({ id: agentRunEvents.id }).from(agentRunEvents).where(eq(agentRunEvents.runId, runId)))
      const remainingIds = remaining.map((r) => r.id)
      expect(remainingIds).not.toContain(oldEvent!.id)
      expect(remainingIds).toContain(newEvent!.id)
      const runRow = await withOrg(app.db, orgId, (tx) => tx.select().from(agentRuns).where(eq(agentRuns.id, runId)))
      expect(runRow).toHaveLength(1) // the run row itself is never pruned
    })
  })

  describe('(c) draft_action_tokens retention', () => {
    it(`deletes tokens whose own expires_at is older than ${ACTION_TOKEN_RETENTION_DAYS} days ago; keeps newer ones`, async () => {
      const orgId = await newOrg()
      const ticketId = await seedTicket(orgId, { status: 'awaiting_review' })
      const draftId = await seedDraft(orgId, ticketId, { status: 'pending', expiresAt: new Date(NOW.getTime() + 86_400_000) })
      const [oldToken] = await withOrg(app.db, orgId, (tx) =>
        tx
          .insert(draftActionTokens)
          .values({ orgId, draftId, userId, tokenHash: `hash-${rand()}`, expiresAt: daysAgo(ACTION_TOKEN_RETENTION_DAYS + 1) })
          .returning({ id: draftActionTokens.id }))
      const [freshToken] = await withOrg(app.db, orgId, (tx) =>
        tx
          .insert(draftActionTokens)
          .values({ orgId, draftId, userId, tokenHash: `hash-${rand()}`, expiresAt: new Date(NOW.getTime() + 86_400_000) })
          .returning({ id: draftActionTokens.id }))

      const result = await runSweepsDaily(boss, makeDeps())

      expect(result.tokensDeleted).toBeGreaterThanOrEqual(1)
      const remaining = await withOrg(app.db, orgId, (tx) => tx.select({ id: draftActionTokens.id }).from(draftActionTokens).where(eq(draftActionTokens.draftId, draftId)))
      const remainingIds = remaining.map((r) => r.id)
      expect(remainingIds).not.toContain(oldToken!.id)
      expect(remainingIds).toContain(freshToken!.id)
    })
  })

  describe('(d) resolved_answers expiry', () => {
    it('retires active and needs_review answers past expires_at (reason expired) and leaves candidates/retired alone', async () => {
      const orgId = await newOrg()
      const activeExpired = await seedAnswer(orgId, { status: 'active', expiresAt: minutesAgo(60) })
      const needsReviewExpired = await seedAnswer(orgId, { status: 'needs_review', expiresAt: minutesAgo(60) })
      const candidateExpired = await seedAnswer(orgId, { status: 'candidate', expiresAt: minutesAgo(60) })
      const alreadyRetired = await seedAnswer(orgId, { status: 'retired', retiredReason: 'owner', expiresAt: minutesAgo(60) })
      const activeNotYet = await seedAnswer(orgId, { status: 'active', expiresAt: new Date(NOW.getTime() + 60_000) })

      const result = await runSweepsDaily(boss, makeDeps())

      expect(result.answersExpired).toBeGreaterThanOrEqual(2)
      expect(await getAnswer(orgId, activeExpired)).toMatchObject({ status: 'retired', retiredReason: 'expired' })
      expect(await getAnswer(orgId, needsReviewExpired)).toMatchObject({ status: 'retired', retiredReason: 'expired' })
      expect(await getAnswer(orgId, candidateExpired)).toMatchObject({ status: 'candidate' }) // untouched — (e)'s job, not (d)'s
      expect(await getAnswer(orgId, alreadyRetired)).toMatchObject({ status: 'retired', retiredReason: 'owner' }) // untouched, not overwritten
      expect(await getAnswer(orgId, activeNotYet)).toMatchObject({ status: 'active' })
    })
  })

  describe('(e) stale candidate retirement', () => {
    it(`retires candidates older than ${MEMORY_CANDIDATE_MAX_AGE_DAYS} days (reason unsampled)`, async () => {
      const orgId = await newOrg()
      const oldCandidate = await seedAnswer(orgId, {
        status: 'candidate', createdAt: daysAgo(MEMORY_CANDIDATE_MAX_AGE_DAYS + 1), expiresAt: new Date(NOW.getTime() + 365 * 24 * 60 * 60_000),
      })
      const freshCandidate = await seedAnswer(orgId, {
        status: 'candidate', createdAt: daysAgo(1), expiresAt: new Date(NOW.getTime() + 365 * 24 * 60 * 60_000),
      })

      const result = await runSweepsDaily(boss, makeDeps())

      expect(result.candidatesRetired).toBeGreaterThanOrEqual(1)
      expect(await getAnswer(orgId, oldCandidate)).toMatchObject({ status: 'retired', retiredReason: 'unsampled' })
      expect(await getAnswer(orgId, freshCandidate)).toMatchObject({ status: 'candidate' })
    })
  })

  describe('(f) source-drift review', () => {
    it('parks an active answer in needs_review (source_changed) when any of its cited chunks no longer exists; an answer with no citations is untouched', async () => {
      const orgId = await newOrg()
      const chunkId = await seedChunk(orgId)
      const vanishedId = randomUUID()
      const withVanishedChunk = await seedAnswer(orgId, { status: 'active', citedChunkIds: [chunkId, vanishedId] })
      const withExistingOnly = await seedAnswer(orgId, { status: 'active', citedChunkIds: [chunkId] })
      const noCitations = await seedAnswer(orgId, { status: 'active', citedChunkIds: [] })

      const result = await runSweepsDaily(boss, makeDeps())

      expect(result.answersSourceChanged).toBeGreaterThanOrEqual(1)
      expect(await getAnswer(orgId, withVanishedChunk)).toMatchObject({ status: 'needs_review', reviewReason: 'source_changed' })
      expect(await getAnswer(orgId, withExistingOnly)).toMatchObject({ status: 'active' })
      expect(await getAnswer(orgId, noCitations)).toMatchObject({ status: 'active' })
    })
  })

  describe('memory retirement audit trail', () => {
    it('the three arms write ONE audit row per org per arm with the count', async () => {
      const orgId = await newOrg()
      await seedAnswer(orgId, { status: 'active', expiresAt: minutesAgo(60) })
      await seedAnswer(orgId, { status: 'needs_review', expiresAt: minutesAgo(60) })
      await seedAnswer(orgId, {
        status: 'candidate', createdAt: daysAgo(MEMORY_CANDIDATE_MAX_AGE_DAYS + 1), expiresAt: new Date(NOW.getTime() + 365 * 24 * 60 * 60_000),
      })
      await seedAnswer(orgId, { status: 'active', citedChunkIds: [randomUUID()] })

      await runSweepsDaily(boss, makeDeps())

      const retiredAudits = await withPlatform(app.db, 'test:audit', (tx) =>
        tx.select().from(auditLog).where(and(eq(auditLog.entityId, orgId), eq(auditLog.action, 'memory.retired'))))
      const needsReviewAudits = await withPlatform(app.db, 'test:audit', (tx) =>
        tx.select().from(auditLog).where(and(eq(auditLog.entityId, orgId), eq(auditLog.action, 'memory.needs_review'))))

      expect(retiredAudits).toHaveLength(2)
      const byArm = Object.fromEntries(retiredAudits.map((a) => [(a.detail as { arm: string }).arm, (a.detail as { count: number }).count]))
      expect(byArm).toEqual({ expired: 2, unsampled: 1 })

      expect(needsReviewAudits).toHaveLength(1)
      expect(needsReviewAudits[0]!.detail).toEqual({ arm: 'source_changed', count: 1 })
    })
  })
})
