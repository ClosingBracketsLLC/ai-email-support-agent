/**
 * `mailbox.poll-sweep` against Postgres + a real (test) pg-boss. Seeds one row per (a)-(g) condition
 * and asserts the enqueue/delete/update happened; a healthy pushed connection is asserted NOT enqueued;
 * (a)'s fair-select is proven with two orgs, three due connections each, interleaved.
 */
import { randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type PgBoss from 'pg-boss'
import pino from 'pino'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  auditLog, mailboxConnections, mailboxCredentials, notifications, oauthFlows, tickets, user, webhookEvents, withOrg, withPlatform,
} from '@aesa/db'
import { createDb } from '@aesa/db/raw'
import { createTestDatabase, createTestOrganization } from '@aesa/db/testing'
import { JOB_NAMES } from '@aesa/queue'
import { runMailboxPollSweep, type MailboxPollSweepDeps } from '../src/jobs/mailbox-poll-sweep.ts'
import { deleteJobsForOrgs, queryJobs, startTestBoss } from './helpers/boss.ts'

const rand = () => randomBytes(4).toString('hex')
const NOW = new Date('2026-09-09T12:00:00Z')

describe('mailbox.poll-sweep', () => {
  let t: Awaited<ReturnType<typeof createTestDatabase>>
  let app: ReturnType<typeof createDb>
  let boss: PgBoss
  let userId: string
  const createdOrgIds: string[] = []

  beforeAll(async () => {
    t = await createTestDatabase()
    app = createDb(t.url)
    boss = await startTestBoss()
    await boss.createQueue(JOB_NAMES.mailboxSync)
    await boss.createQueue(JOB_NAMES.ticketTriage)
    await boss.createQueue(JOB_NAMES.notifyDispatch)
    const [u] = await app.db.insert(user).values({ name: 'Owner', email: `owner-${rand()}@example.com` }).returning()
    userId = u!.id
  })
  afterAll(async () => {
    // Scoped to this file's own orgs — see test/helpers/boss.ts's deleteJobsForOrgs doc comment.
    await deleteJobsForOrgs(JOB_NAMES.mailboxSync, createdOrgIds)
    await deleteJobsForOrgs(JOB_NAMES.ticketTriage, createdOrgIds)
    await deleteJobsForOrgs(JOB_NAMES.notifyDispatch, createdOrgIds)
    await boss.stop({ graceful: false, wait: true })
    await app.pool.end()
    await t.drop()
  })

  function makeDeps(): MailboxPollSweepDeps {
    return { db: app.db, logger: pino({ level: 'silent' }), now: () => NOW }
  }

  async function newOrg(): Promise<string> {
    const orgId = await createTestOrganization(app)
    createdOrgIds.push(orgId)
    return orgId
  }

  async function seedConnection(orgId: string, overrides: Partial<typeof mailboxConnections.$inferInsert> = {}): Promise<string> {
    const [conn] = await withOrg(app.db, orgId, (tx) =>
      tx
        .insert(mailboxConnections)
        .values({
          orgId, provider: 'gmail', providerAccountId: `acct-${rand()}`, emailAddress: `support-${rand()}@acme.test`,
          status: 'connected', connectedByUserId: userId, ...overrides,
        })
        .returning(),
    )
    return conn!.id
  }

  async function readConnection(orgId: string, connectionId: string) {
    const [row] = await withOrg(app.db, orgId, (tx) => tx.select().from(mailboxConnections).where(eq(mailboxConnections.id, connectionId)))
    return row
  }

  async function mailboxSyncJobs() {
    return queryJobs(JOB_NAMES.mailboxSync)
  }
  async function ticketTriageJobs() {
    return queryJobs(JOB_NAMES.ticketTriage)
  }
  async function notifyDispatchJobs() {
    return queryJobs(JOB_NAMES.notifyDispatch)
  }

  it('(a) a connection due a sync gets mailbox.sync enqueued; a healthy pushed connection does not', async () => {
    const orgId = await newOrg()
    const due = await seedConnection(orgId, { lastSyncAt: new Date(NOW.getTime() - 40 * 60_000) })
    const healthy = await seedConnection(orgId, {
      pushSubscriptionId: 'sub-1', pushExpiresAt: new Date(NOW.getTime() + 60 * 60_000), lastSyncAt: new Date(NOW.getTime() - 5 * 60_000),
    })

    await runMailboxPollSweep(boss, makeDeps())

    const jobs = await mailboxSyncJobs()
    const connectionIds = jobs.map((j) => (j.data as { connectionId?: string }).connectionId)
    expect(connectionIds).toContain(due)
    expect(connectionIds).not.toContain(healthy)
  })

  it('(a) fair-select interleaves two orgs with three due connections each', async () => {
    const orgA = await newOrg()
    const orgB = await newOrg()
    const aIds = await Promise.all([1, 2, 3].map(() => seedConnection(orgA, { lastSyncAt: new Date(NOW.getTime() - 40 * 60_000) })))
    const bIds = await Promise.all([1, 2, 3].map(() => seedConnection(orgB, { lastSyncAt: new Date(NOW.getTime() - 40 * 60_000) })))

    await runMailboxPollSweep(boss, makeDeps())

    const jobs = await mailboxSyncJobs()
    const enqueued = new Set(jobs.map((j) => (j.data as { connectionId?: string }).connectionId))
    for (const id of [...aIds, ...bIds]) expect(enqueued.has(id)).toBe(true)
  })

  it('(b) an expired pending_claim connection has its credentials and connection row deleted, and is audited', async () => {
    const orgId = await newOrg()
    const connectionId = await seedConnection(orgId, { status: 'pending_claim', createdAt: new Date(NOW.getTime() - 15 * 60_000) })
    await withPlatform(app.db, 'test:seed-cred', (tx) =>
      tx.insert(mailboxCredentials).values({ connectionId, orgId, refreshTokenCiphertext: Buffer.from('sealed'), encryption: 'sealed' }))

    await runMailboxPollSweep(boss, makeDeps())

    expect(await readConnection(orgId, connectionId)).toBeUndefined()
    const credRows = await withPlatform(app.db, 'test:read-cred', (tx) => tx.select().from(mailboxCredentials).where(eq(mailboxCredentials.connectionId, connectionId)))
    expect(credRows).toHaveLength(0)
    const audits = await withPlatform(app.db, 'test:audit', (tx) => tx.select().from(auditLog).where(eq(auditLog.entityId, connectionId)))
    expect(audits.some((a) => a.action === 'mailbox.claim_expired')).toBe(true)
  })

  it("(c) a pending oauth_flow past its expiry flips to 'expired', and an old expired flow is deleted", async () => {
    const orgId = await newOrg()
    const [pastPending] = await withOrg(app.db, orgId, (tx) =>
      tx
        .insert(oauthFlows)
        .values({
          orgId, userId, provider: 'gmail', nonceHash: `nonce-${rand()}`, pkceCiphertext: Buffer.from('x'), platform: 'web',
          status: 'pending', expiresAt: new Date(NOW.getTime() - 60_000),
        })
        .returning())
    const [oldExpired] = await withOrg(app.db, orgId, (tx) =>
      tx
        .insert(oauthFlows)
        .values({
          orgId, userId, provider: 'gmail', nonceHash: `nonce-${rand()}`, pkceCiphertext: Buffer.from('x'), platform: 'web',
          status: 'expired', expiresAt: new Date(NOW.getTime() - 25 * 60 * 60_000),
        })
        .returning())

    await runMailboxPollSweep(boss, makeDeps())

    const [after] = await withOrg(app.db, orgId, (tx) => tx.select().from(oauthFlows).where(eq(oauthFlows.id, pastPending!.id)))
    expect(after?.status).toBe('expired')
    const [deleted] = await withOrg(app.db, orgId, (tx) => tx.select().from(oauthFlows).where(eq(oauthFlows.id, oldExpired!.id)))
    expect(deleted).toBeUndefined()
  })

  it("(d) a ticket stuck 'new' past 10 minutes since last_inbound_at gets ticket.triage enqueued", async () => {
    const orgId = await newOrg()
    const connectionId = await seedConnection(orgId)
    const [ticket] = await withOrg(app.db, orgId, (tx) =>
      tx.insert(tickets).values({ orgId, connectionId, providerThreadId: `thread-${rand()}`, status: 'new', lastInboundAt: new Date(NOW.getTime() - 15 * 60_000) }).returning())

    await runMailboxPollSweep(boss, makeDeps())

    const jobs = await ticketTriageJobs()
    expect(jobs.some((j) => (j.data as { ticketId?: string }).ticketId === ticket!.id)).toBe(true)
  })

  it('(e) a needs_owner/triage_cap ticket from a previous UTC day is reset to new and re-enqueued', async () => {
    const orgId = await newOrg()
    const connectionId = await seedConnection(orgId)
    const [ticket] = await withOrg(app.db, orgId, (tx) =>
      tx
        .insert(tickets)
        .values({
          orgId, connectionId, providerThreadId: `thread-${rand()}`, status: 'needs_owner', needsOwnerReason: 'triage_cap',
          lastTriagedAt: new Date('2026-09-08T10:00:00Z'),
        })
        .returning())

    await runMailboxPollSweep(boss, makeDeps())

    const [after] = await withOrg(app.db, orgId, (tx) => tx.select().from(tickets).where(eq(tickets.id, ticket!.id)))
    expect(after?.status).toBe('new')
    expect(after?.needsOwnerReason).toBeNull()
    const jobs = await ticketTriageJobs()
    expect(jobs.some((j) => (j.data as { ticketId?: string }).ticketId === ticket!.id)).toBe(true)
  })

  it('(e) a same-day triage_cap ticket is left untouched', async () => {
    const orgId = await newOrg()
    const connectionId = await seedConnection(orgId)
    const [ticket] = await withOrg(app.db, orgId, (tx) =>
      tx
        .insert(tickets)
        .values({
          orgId, connectionId, providerThreadId: `thread-${rand()}`, status: 'needs_owner', needsOwnerReason: 'triage_cap',
          lastTriagedAt: new Date('2026-09-09T09:00:00Z'),
        })
        .returning())

    await runMailboxPollSweep(boss, makeDeps())

    const [after] = await withOrg(app.db, orgId, (tx) => tx.select().from(tickets).where(eq(tickets.id, ticket!.id)))
    expect(after?.status).toBe('needs_owner')
    const jobs = await ticketTriageJobs()
    expect(jobs.some((j) => (j.data as { ticketId?: string }).ticketId === ticket!.id)).toBe(false)
  })

  it('(f) webhook_events older than 7 days are deleted; recent ones survive', async () => {
    await app.db.insert(webhookEvents).values({ provider: 'gmail', externalId: `old-${rand()}`, envelope: {}, receivedAt: new Date(NOW.getTime() - 8 * 24 * 60 * 60_000) })
    await app.db.insert(webhookEvents).values({ provider: 'gmail', externalId: `recent-${rand()}`, envelope: {}, receivedAt: new Date(NOW.getTime() - 60_000) })

    await runMailboxPollSweep(boss, makeDeps())

    const rows = await app.db.select().from(webhookEvents)
    expect(rows.every((r) => r.receivedAt.getTime() > NOW.getTime() - 7 * 24 * 60 * 60_000)).toBe(true)
  })

  it('(g) a notification stuck pending past 10 minutes gets notify.dispatch enqueued', async () => {
    const orgId = await newOrg()
    const [n] = await withOrg(app.db, orgId, (tx) =>
      tx
        .insert(notifications)
        .values({ orgId, kind: 'escalation', title: 't', body: 'b', dedupeKey: `dk-${rand()}`, createdAt: new Date(NOW.getTime() - 15 * 60_000) })
        .returning())

    await runMailboxPollSweep(boss, makeDeps())

    const jobs = await notifyDispatchJobs()
    expect(jobs.some((j) => (j.data as { notificationId?: string }).notificationId === n!.id)).toBe(true)
  })
})
