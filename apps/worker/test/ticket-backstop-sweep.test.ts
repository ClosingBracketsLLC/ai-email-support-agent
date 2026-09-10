/**
 * `ticket.backstop-sweep` against Postgres + a real (test) pg-boss. One `describe` per sub-sweep,
 * mirroring `mailbox-poll-sweep.test.ts`'s style: seed the exact row shape one case needs, run the
 * sweep, assert the enqueue/write happened (or didn't).
 *
 * This file's tables are shared across every `it` in the suite (one throwaway database for the
 * whole file, not per test) — like `mailbox-poll-sweep.test.ts`, a ticket seeded `triaged` and
 * left eligible by one test is a candidate for every LATER sweep call in the file too. Tests that
 * assert EXACT counts (the cap tests, the fairness test) either use a dedicated fresh org and
 * filter every assertion down to their OWN ids (never a raw count), or clean up their own rows
 * before the next test runs. Tests that only assert membership ("ticket X is/isn't enqueued") are
 * unaffected by a few unrelated leftover rows either way.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import type PgBoss from 'pg-boss'
import pino from 'pino'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { INVARIANTS } from '@aesa/core'
import {
  agentRuns, auditLog, drafts, escalateTicket, mailboxConnections, notifications, outboundSends, tickets, user, withOrg, withPlatform,
  type EscalateTicketParams, type OrgTx,
} from '@aesa/db'
import { createDb } from '@aesa/db/raw'
import { createTestDatabase, createTestOrganization } from '@aesa/db/testing'
import { JOB_NAMES } from '@aesa/queue'
import { utcDayString } from '../src/date-utils.ts'
import { STUCK_AFTER_MINUTES } from '../src/drafting/claim.ts'
import {
  DUE_SEND_GRACE_SECONDS, ESCALATIONS_CAP_PER_CYCLE, ORPHAN_AFTER_MINUTES, runTicketBackstopSweep,
  SELECT_CAP_PER_CYCLE, type TicketBackstopDeps,
} from '../src/jobs/ticket-backstop-sweep.ts'
import { deleteJobsForOrgs, queryJobs, startTestBoss } from './helpers/boss.ts'

const rand = () => randomBytes(4).toString('hex')
const NOW = new Date('2026-09-09T12:00:00Z')
const DAY = utcDayString(NOW)
const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60_000)
const secondsAgo = (n: number) => new Date(NOW.getTime() - n * 1000)

describe('ticket.backstop-sweep', () => {
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
    await boss.createQueue(JOB_NAMES.ticketDraft)
    await boss.createQueue(JOB_NAMES.sendExecute)
    await boss.createQueue(JOB_NAMES.notifyDispatch)
    const [u] = await app.db.insert(user).values({ name: 'Owner', email: `owner-${rand()}@example.com` }).returning()
    userId = u!.id
  })
  afterAll(async () => {
    await deleteJobsForOrgs(JOB_NAMES.ticketDraft, createdOrgIds)
    await deleteJobsForOrgs(JOB_NAMES.sendExecute, createdOrgIds)
    await deleteJobsForOrgs(JOB_NAMES.notifyDispatch, createdOrgIds)
    await boss.stop({ graceful: false, wait: true })
    await app.pool.end()
    await t.drop()
  })

  function makeDeps(overrides: Partial<TicketBackstopDeps> = {}): TicketBackstopDeps {
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
        .values({ orgId, connectionId, providerThreadId: `thread-${rand()}`, status: 'triaged', ...overrides })
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
          status: 'pending', threadSnapshotAt: NOW, expiresAt: new Date(NOW.getTime() + 86_400_000), ...overrides,
        })
        .returning({ id: drafts.id }))
    return row!.id
  }

  async function seedAgentRun(orgId: string, overrides: Partial<typeof agentRuns.$inferInsert> = {}): Promise<string> {
    const [row] = await withOrg(app.db, orgId, (tx) =>
      tx
        .insert(agentRuns)
        .values({ orgId, kind: 'draft', provider: 'anthropic', model: 'claude-x', status: 'running', startedAt: NOW, ...overrides })
        .returning({ id: agentRuns.id }))
    return row!.id
  }

  async function getAgentRun(orgId: string, runId: string) {
    const [row] = await withOrg(app.db, orgId, (tx) => tx.select().from(agentRuns).where(eq(agentRuns.id, runId)))
    return row!
  }

  async function seedSendChain(
    orgId: string, overrides: Partial<typeof outboundSends.$inferInsert> = {},
  ): Promise<{ ticketId: string; draftId: string; sendId: string }> {
    const connectionId = connectionByOrg.get(orgId)!
    const ticketId = await seedTicket(orgId, { status: 'awaiting_review' })
    const draftId = await seedDraft(orgId, ticketId, { status: 'approved', decidedBy: userId, decidedAt: NOW })
    const [row] = await withOrg(app.db, orgId, (tx) =>
      tx
        .insert(outboundSends)
        .values({ orgId, draftId, ticketId, connectionId, status: 'queued', sendAfter: NOW, ...overrides })
        .returning({ id: outboundSends.id }))
    return { ticketId, draftId, sendId: row!.id }
  }

  async function resolveTicket(orgId: string, ticketId: string): Promise<void> {
    await withOrg(app.db, orgId, (tx) => tx.update(tickets).set({ status: 'resolved' }).where(eq(tickets.id, ticketId)))
  }

  async function draftJobs() {
    return queryJobs(JOB_NAMES.ticketDraft)
  }
  async function sendJobs() {
    return queryJobs(JOB_NAMES.sendExecute)
  }
  async function notifyJobs() {
    return queryJobs(JOB_NAMES.notifyDispatch)
  }

  async function auditRowsFor(entityId: string, action: string) {
    return withPlatform(app.db, 'test:audit', (tx) => tx.select().from(auditLog).where(and(eq(auditLog.entityId, entityId), eq(auditLog.action, action))))
  }

  async function notificationById(id: string) {
    const [row] = await withPlatform(app.db, 'test:notification', (tx) => tx.select().from(notifications).where(eq(notifications.id, id)))
    return row
  }

  describe('(a) missed/stuck drafts', () => {
    it('a never-run ticket is enqueued; a recently-claimed ticket with no new inbound is not', async () => {
      const orgId = await newOrg()
      const neverRun = await seedTicket(orgId, { lastAgentRunAt: null, lastInboundAt: minutesAgo(5) })
      const liveClaim = await seedTicket(orgId, {
        lastAgentRunAt: minutesAgo(5), lastAgentFinishedAt: null, lastInboundAt: minutesAgo(30),
      })

      const result = await runTicketBackstopSweep(boss, makeDeps())

      const ids = (await draftJobs()).map((j) => (j.data as { ticketId?: string }).ticketId)
      expect(ids).toContain(neverRun)
      expect(ids).not.toContain(liveClaim)
      expect(result.draftsEnqueued).toBeGreaterThanOrEqual(1)

      // Clean up: an eligible `triaged` ticket left behind would otherwise be a permanent candidate
      // for every later sweep in this file, including the cap/fairness tests' exact-count assertions.
      await resolveTicket(orgId, neverRun)
    })

    it('new inbound since the last run is enqueued', async () => {
      const orgId = await newOrg()
      const ticketId = await seedTicket(orgId, {
        lastAgentRunAt: minutesAgo(60), lastAgentFinishedAt: minutesAgo(59), lastInboundAt: minutesAgo(2),
      })

      await runTicketBackstopSweep(boss, makeDeps())

      const ids = (await draftJobs()).map((j) => (j.data as { ticketId?: string }).ticketId)
      expect(ids).toContain(ticketId)

      await resolveTicket(orgId, ticketId) // see the cleanup note on the test above
    })

    it(`stuck ${STUCK_AFTER_MINUTES}+ minutes with no finish is enqueued; a claim within the window is not`, async () => {
      const orgId = await newOrg()
      const stuck = await seedTicket(orgId, {
        lastAgentRunAt: minutesAgo(STUCK_AFTER_MINUTES + 1), lastAgentFinishedAt: null, lastInboundAt: minutesAgo(STUCK_AFTER_MINUTES + 30),
      })
      const withinWindow = await seedTicket(orgId, {
        lastAgentRunAt: minutesAgo(STUCK_AFTER_MINUTES - 1), lastAgentFinishedAt: null, lastInboundAt: minutesAgo(STUCK_AFTER_MINUTES + 30),
      })

      await runTicketBackstopSweep(boss, makeDeps())

      const ids = (await draftJobs()).map((j) => (j.data as { ticketId?: string }).ticketId)
      expect(ids).toContain(stuck)
      expect(ids).not.toContain(withinWindow)

      await resolveTicket(orgId, stuck) // see the cleanup note above
    })

    it('a ticket at the failure ceiling is skipped even though it is otherwise never-run', async () => {
      const orgId = await newOrg()
      const ticketId = await seedTicket(orgId, {
        agentFailureCount: INVARIANTS.AGENT_FAILURE_ESCALATE_AT, lastAgentRunAt: null, lastInboundAt: minutesAgo(5),
      })

      await runTicketBackstopSweep(boss, makeDeps())

      const ids = (await draftJobs()).map((j) => (j.data as { ticketId?: string }).ticketId)
      expect(ids).not.toContain(ticketId)
    })

    it('a non-triaged ticket is skipped', async () => {
      const orgId = await newOrg()
      const ticketId = await seedTicket(orgId, { status: 'new', lastAgentRunAt: null, lastInboundAt: minutesAgo(5) })

      await runTicketBackstopSweep(boss, makeDeps())

      const ids = (await draftJobs()).map((j) => (j.data as { ticketId?: string }).ticketId)
      expect(ids).not.toContain(ticketId)
    })

    it(`caps at SELECT_CAP_PER_CYCLE (${SELECT_CAP_PER_CYCLE}), oldest inbound first`, async () => {
      const orgId = await newOrg()
      // Deliberately ancient, mutually distinct timestamps so this test's own 60 candidates always
      // rank ahead of any realistic (minutes-old) leftover from the tests above.
      const base = new Date('2001-01-01T00:00:00Z').getTime()
      const ids = await Promise.all(
        Array.from({ length: SELECT_CAP_PER_CYCLE + 10 }, (_, n) =>
          seedTicket(orgId, { lastAgentRunAt: null, lastInboundAt: new Date(base + n * 60_000) })),
      )

      const originalSend = boss.send.bind(boss)
      const sendOrder: string[] = []
      boss.send = (async (name: string, data: unknown, opts?: unknown) => {
        if (name === JOB_NAMES.ticketDraft) sendOrder.push((data as { ticketId: string }).ticketId)
        return originalSend(name as never, data as never, opts as never)
      }) as typeof boss.send
      try {
        await runTicketBackstopSweep(boss, makeDeps())
      } finally {
        boss.send = originalSend
      }

      const own = sendOrder.filter((id) => ids.includes(id))
      expect(own).toHaveLength(SELECT_CAP_PER_CYCLE)
      // The oldest SELECT_CAP_PER_CYCLE (by inbound) survive; the newest 10 do not.
      const expectedIncluded = ids.slice(0, SELECT_CAP_PER_CYCLE)
      const expectedExcluded = ids.slice(SELECT_CAP_PER_CYCLE)
      for (const id of expectedIncluded) expect(own).toContain(id)
      for (const id of expectedExcluded) expect(own).not.toContain(id)

      // Clean up: resolve every seeded ticket so this test's 60 rows never compete for a later
      // sweep's own cap (the fairness test below asserts exact interleaving for its OWN two orgs).
      await Promise.all(ids.map((id) => resolveTicket(orgId, id)))
    })

    it('NULLS FIRST — a never-inbound ticket is not starved behind one with a concrete (but newer) inbound', async () => {
      const orgId = await newOrg()
      const noInbound = await seedTicket(orgId, { lastAgentRunAt: null, lastInboundAt: null })
      const withInbound = await seedTicket(orgId, { lastAgentRunAt: null, lastInboundAt: minutesAgo(1) })

      const originalSend = boss.send.bind(boss)
      const sendOrder: string[] = []
      boss.send = (async (name: string, data: unknown, opts?: unknown) => {
        if (name === JOB_NAMES.ticketDraft) sendOrder.push((data as { ticketId: string }).ticketId)
        return originalSend(name as never, data as never, opts as never)
      }) as typeof boss.send
      try {
        await runTicketBackstopSweep(boss, makeDeps())
      } finally {
        boss.send = originalSend
      }

      const noInboundIndex = sendOrder.indexOf(noInbound)
      const withInboundIndex = sendOrder.indexOf(withInbound)
      expect(noInboundIndex).toBeGreaterThanOrEqual(0)
      expect(withInboundIndex).toBeGreaterThanOrEqual(0)
      expect(noInboundIndex).toBeLessThan(withInboundIndex)

      await resolveTicket(orgId, noInbound)
      await resolveTicket(orgId, withInbound)
    })

    it('fair-select interleaves two orgs with 40 eligible tickets each — the first 50 enqueues alternate orgs', async () => {
      const orgA = await newOrg()
      const orgB = await newOrg()
      const aIds = await Promise.all(
        Array.from({ length: 40 }, (_, n) => seedTicket(orgA, { lastAgentRunAt: null, lastInboundAt: minutesAgo(n + 1) })),
      )
      const bIds = await Promise.all(
        Array.from({ length: 40 }, (_, n) => seedTicket(orgB, { lastAgentRunAt: null, lastInboundAt: minutesAgo(n + 1) })),
      )

      const originalSend = boss.send.bind(boss)
      const sendOrder: string[] = []
      boss.send = (async (name: string, data: unknown, opts?: unknown) => {
        if (name === JOB_NAMES.ticketDraft) sendOrder.push((data as { ticketId: string }).ticketId)
        return originalSend(name as never, data as never, opts as never)
      }) as typeof boss.send
      try {
        await runTicketBackstopSweep(boss, makeDeps())
      } finally {
        boss.send = originalSend
      }

      const aSet = new Set(aIds)
      const bSet = new Set(bIds)
      const own = sendOrder.filter((id) => aSet.has(id) || bSet.has(id))
      // Fair round-robin: one ticket from EACH org before either org gets a second.
      const firstTwo = own.slice(0, 2)
      expect(firstTwo.some((id) => aSet.has(id))).toBe(true)
      expect(firstTwo.some((id) => bSet.has(id))).toBe(true)
      expect(own.length).toBeGreaterThan(0)

      await Promise.all([...aIds, ...bIds].map((id) => resolveTicket(aIds.includes(id) ? orgA : orgB, id)))
    })
  })

  describe('(b) stuck runs', () => {
    it('a running run older than the cutoff is aborted and audited; a fresh one is untouched', async () => {
      const orgId = await newOrg()
      const cutoffAgeSeconds = INVARIANTS.DRAFT_JOB_EXPIRE_SECONDS + 60 + 30
      const stuckRunId = await seedAgentRun(orgId, { status: 'running', startedAt: secondsAgo(cutoffAgeSeconds) })
      const freshRunId = await seedAgentRun(orgId, { status: 'running', startedAt: NOW })

      const result = await runTicketBackstopSweep(boss, makeDeps())

      const stuckRun = await getAgentRun(orgId, stuckRunId)
      expect(stuckRun.status).toBe('aborted')
      expect(stuckRun.errorCode).toBe('stuck')
      expect(stuckRun.finishedAt).not.toBeNull()

      const freshRun = await getAgentRun(orgId, freshRunId)
      expect(freshRun.status).toBe('running')

      const audits = await auditRowsFor(stuckRunId, 'agent_run.stuck')
      expect(audits).toHaveLength(1)
      expect(audits[0]!.actor).toBe('system:cron:ticket.backstop-sweep')
      expect(audits[0]!.orgId).toBe(orgId)
      expect(result.stuckRuns).toBeGreaterThanOrEqual(1)
    })
  })

  describe('(c) orphans', () => {
    const TERMINAL_STATUSES = ['sent', 'rejected', 'superseded', 'expired', 'failed'] as const
    const LIVE_STATUSES = ['pending', 'approved', 'held', 'sending'] as const

    it.each(TERMINAL_STATUSES)('a ticket whose only draft is terminal (%s), aged past ORPHAN_AFTER_MINUTES, is escalated orphaned', async (status) => {
      const orgId = await newOrg()
      const ticketId = await seedTicket(orgId, { status: 'awaiting_review', updatedAt: minutesAgo(ORPHAN_AFTER_MINUTES + 30) })
      await seedDraft(orgId, ticketId, { status, createdAt: minutesAgo(ORPHAN_AFTER_MINUTES + 5) })

      await runTicketBackstopSweep(boss, makeDeps())

      const ticket = await getTicket(orgId, ticketId)
      expect(ticket.status).toBe('needs_owner')
      expect(ticket.needsOwnerReason).toBe('orphaned')
      const notifs = await notifyJobs()
      const job = notifs.find((j) => (j.data as { orgId?: string }).orgId === orgId)
      expect(job).toBeDefined()
      const notification = await notificationById((job!.data as { notificationId: string }).notificationId)
      expect(notification?.dedupeKey).toBe(`orphaned:${ticketId}:${DAY}`)
      expect(notification?.payload).toMatchObject({ ticketId })
    })

    it.each(LIVE_STATUSES)('a ticket with a live draft (%s) is left alone regardless of age', async (status) => {
      const orgId = await newOrg()
      const ticketId = await seedTicket(orgId, { status: 'awaiting_review', updatedAt: minutesAgo(ORPHAN_AFTER_MINUTES + 30) })
      await seedDraft(orgId, ticketId, { status, createdAt: minutesAgo(ORPHAN_AFTER_MINUTES + 5) })

      await runTicketBackstopSweep(boss, makeDeps())

      const ticket = await getTicket(orgId, ticketId)
      expect(ticket.status).toBe('awaiting_review')
    })

    it('a fresh newest draft (< ORPHAN_AFTER_MINUTES old) protects the ticket even with an old updated_at', async () => {
      const orgId = await newOrg()
      const ticketId = await seedTicket(orgId, { status: 'awaiting_review', updatedAt: minutesAgo(999) })
      await seedDraft(orgId, ticketId, { status: 'rejected', createdAt: minutesAgo(ORPHAN_AFTER_MINUTES - 5) })

      await runTicketBackstopSweep(boss, makeDeps())

      const ticket = await getTicket(orgId, ticketId)
      expect(ticket.status).toBe('awaiting_review')
    })

    it('a chasing customer (fresh updated_at, old draft) does NOT reset the clock — still escalated', async () => {
      const orgId = await newOrg()
      const ticketId = await seedTicket(orgId, { status: 'awaiting_review', updatedAt: minutesAgo(1) })
      await seedDraft(orgId, ticketId, { status: 'rejected', createdAt: minutesAgo(ORPHAN_AFTER_MINUTES + 5) })

      await runTicketBackstopSweep(boss, makeDeps())

      const ticket = await getTicket(orgId, ticketId)
      expect(ticket.status).toBe('needs_owner')
      expect(ticket.needsOwnerReason).toBe('orphaned')
    })

    it('no draft but a fresh last_agent_run_at is untouched', async () => {
      const orgId = await newOrg()
      const ticketId = await seedTicket(orgId, {
        status: 'awaiting_review', lastAgentRunAt: minutesAgo(1), updatedAt: minutesAgo(999),
      })

      await runTicketBackstopSweep(boss, makeDeps())

      const ticket = await getTicket(orgId, ticketId)
      expect(ticket.status).toBe('awaiting_review')
    })

    it('no draft and no run falls back to the updated_at floor — old enough escalates', async () => {
      const orgId = await newOrg()
      const ticketId = await seedTicket(orgId, {
        status: 'awaiting_review', lastAgentRunAt: null, updatedAt: minutesAgo(ORPHAN_AFTER_MINUTES + 5),
      })

      await runTicketBackstopSweep(boss, makeDeps())

      const ticket = await getTicket(orgId, ticketId)
      expect(ticket.status).toBe('needs_owner')
      expect(ticket.needsOwnerReason).toBe('orphaned')
    })

    it(`caps at ESCALATIONS_CAP_PER_CYCLE (${ESCALATIONS_CAP_PER_CYCLE}), oldest anchor first`, async () => {
      const orgId = await newOrg()
      const count = ESCALATIONS_CAP_PER_CYCLE + 5
      const ticketIds = await Promise.all(
        Array.from({ length: count }, async (_, n) => {
          const ticketId = await seedTicket(orgId, { status: 'awaiting_review', updatedAt: minutesAgo(999) })
          await seedDraft(orgId, ticketId, { status: 'rejected', createdAt: minutesAgo(ORPHAN_AFTER_MINUTES + count - n) })
          return ticketId
        }),
      )

      const result = await runTicketBackstopSweep(boss, makeDeps())

      expect(result.orphans).toBe(ESCALATIONS_CAP_PER_CYCLE)
      const escalatedCount = await Promise.all(ticketIds.map((id) => getTicket(orgId, id))).then(
        (rows) => rows.filter((r) => r.status === 'needs_owner').length,
      )
      expect(escalatedCount).toBe(ESCALATIONS_CAP_PER_CYCLE)
      // The oldest anchors (n=0..ESCALATIONS_CAP_PER_CYCLE-1, largest offset) are the ones escalated.
      const oldest = ticketIds.slice(0, ESCALATIONS_CAP_PER_CYCLE)
      for (const id of oldest) expect((await getTicket(orgId, id)).status).toBe('needs_owner')

      // Clean up: the newest 5 stayed `awaiting_review` with an eligible anchor and would otherwise
      // remain live candidates for every later sweep in this file (including the very next test's
      // aggregate `orphans` count).
      await Promise.all(ticketIds.map((id) => resolveTicket(orgId, id)))
    })

    it('a row whose escalation throws does not abort the others in the same pass', async () => {
      const orgId = await newOrg()
      const failing = await seedTicket(orgId, { status: 'awaiting_review', updatedAt: minutesAgo(999) })
      await seedDraft(orgId, failing, { status: 'rejected', createdAt: minutesAgo(ORPHAN_AFTER_MINUTES + 10) })
      const healthy = await seedTicket(orgId, { status: 'awaiting_review', updatedAt: minutesAgo(999) })
      await seedDraft(orgId, healthy, { status: 'rejected', createdAt: minutesAgo(ORPHAN_AFTER_MINUTES + 5) })

      let calls = 0
      const escalate = async (tx: OrgTx, p: EscalateTicketParams) => {
        calls += 1
        if (p.ticketId === failing) throw new Error('injected failure')
        return escalateTicket(tx, p)
      }

      const result = await runTicketBackstopSweep(boss, makeDeps({ escalate }))

      expect(calls).toBe(2)
      const failedTicket = await getTicket(orgId, failing)
      expect(failedTicket.status).toBe('awaiting_review') // rolled back by its own SAVEPOINT
      const healthyTicket = await getTicket(orgId, healthy)
      expect(healthyTicket.status).toBe('needs_owner')
      expect(result.orphans).toBe(1)
    })
  })

  describe('(d) due sends', () => {
    it('an overdue queued send and an expired claimed send are enqueued; a fresh one is not', async () => {
      const orgId = await newOrg()
      const overdueGraceSeconds = DUE_SEND_GRACE_SECONDS + 30
      const { sendId: overdueQueued } = await seedSendChain(orgId, { status: 'queued', sendAfter: secondsAgo(overdueGraceSeconds) })
      const { sendId: expiredClaimed } = await seedSendChain(orgId, {
        status: 'claimed', sendAfter: secondsAgo(overdueGraceSeconds), claimedAt: secondsAgo(overdueGraceSeconds),
        claimExpiresAt: secondsAgo(overdueGraceSeconds), claimToken: randomUUID(),
      })
      const { sendId: fresh } = await seedSendChain(orgId, { status: 'queued', sendAfter: NOW })

      const result = await runTicketBackstopSweep(boss, makeDeps())

      const ids = (await sendJobs()).map((j) => (j.data as { sendId?: string }).sendId)
      expect(ids).toContain(overdueQueued)
      expect(ids).toContain(expiredClaimed)
      expect(ids).not.toContain(fresh)
      expect(result.sendsEnqueued).toBeGreaterThanOrEqual(2)
    })
  })
})
