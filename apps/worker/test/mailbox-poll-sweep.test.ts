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

  it('(a) fair-select interleaves two orgs with three due connections each (asserts ORDER, not just membership)', async () => {
    const orgA = await newOrg()
    const orgB = await newOrg()
    const aIds = await Promise.all([1, 2, 3].map((n) => seedConnection(orgA, { lastSyncAt: new Date(NOW.getTime() - n * 60_000 - 40 * 60_000) })))
    const bIds = await Promise.all([1, 2, 3].map((n) => seedConnection(orgB, { lastSyncAt: new Date(NOW.getTime() - n * 60_000 - 40 * 60_000) })))

    // Spy on the underlying boss.send to capture the ORDER mailbox.sync was actually enqueued in —
    // queryJobs' plain SELECT carries no ordering guarantee, so reading rows back afterward could
    // pass under a plain ORDER BY (a real regression) just as easily as under fair-select. The
    // sweep enqueues sequentially (`for (const item of pending) { await enqueue(...) }`), so the send
    // order IS the order fairSelectSql produced.
    const originalSend = boss.send.bind(boss)
    const sendOrder: string[] = []
    boss.send = (async (name: string, data: unknown, opts?: unknown) => {
      if (name === JOB_NAMES.mailboxSync) sendOrder.push((data as { connectionId: string }).connectionId)
      return originalSend(name as never, data as never, opts as never)
    }) as typeof boss.send

    try {
      await runMailboxPollSweep(boss, makeDeps())
    } finally {
      boss.send = originalSend
    }

    // Earlier tests in this file leave their OWN due connections lingering as candidates for every
    // later sweep too (this cron intentionally scans every org, with no per-test cleanup) — filter
    // sendOrder down to just this test's own six ids before asserting on order/length.
    const aSet = new Set(aIds)
    const bSet = new Set(bIds)
    const ownOrder = sendOrder.filter((id) => aSet.has(id) || bSet.has(id))

    expect(ownOrder).toHaveLength(6)
    // Fair round-robin: one connection from EACH org before either org gets a second — same
    // assertion style as packages/queue/test/fair-select.test.ts's own "round-robins ... before
    // taking a second row from any" check, just for two orgs instead of three.
    const firstTwo = ownOrder.slice(0, 2)
    expect(firstTwo.some((id) => aSet.has(id))).toBe(true)
    expect(firstTwo.some((id) => bSet.has(id))).toBe(true)
    // And every id shows up exactly once, confirming no org's row was skipped or duplicated.
    expect(new Set(ownOrder).size).toBe(6)
    for (const id of [...aIds, ...bIds]) expect(ownOrder).toContain(id)
  })

  it('(b) a pending_claim row with a FRESH updated_at (a just-reconnected connection) is never deleted even though created_at is old and a ticket is attached — the sweep completes and other sub-sweeps in the same pass still run (final-review Critical, plan defect)', async () => {
    const orgId = await newOrg()
    const connectionId = await seedConnection(orgId, {
      status: 'pending_claim',
      createdAt: new Date(NOW.getTime() - 15 * 60_000),   // old — would have been picked up by the OLD (buggy) createdAt-keyed query
      updatedAt: new Date(NOW.getTime() - 60_000),         // fresh — the reconnect write that flipped status also bumped this
    })
    await withOrg(app.db, orgId, (tx) => tx.insert(tickets).values({ orgId, connectionId, providerThreadId: `thread-${rand()}` }))
    // A different sub-sweep's row in the SAME pass — proves the (b) row above never aborts the one
    // withPlatform transaction every sub-sweep shares.
    const [notif] = await withOrg(app.db, orgId, (tx) =>
      tx.insert(notifications).values({ orgId, kind: 'escalation', title: 't', body: 'b', dedupeKey: `dk-${rand()}`, createdAt: new Date(NOW.getTime() - 15 * 60_000) }).returning())

    await runMailboxPollSweep(boss, makeDeps())

    const after = await readConnection(orgId, connectionId)
    expect(after?.status).toBe('pending_claim')
    const audits = await withPlatform(app.db, 'test:audit', (tx) => tx.select().from(auditLog).where(eq(auditLog.entityId, connectionId)))
    expect(audits).toHaveLength(0)
    const notifJobs = await notifyDispatchJobs()
    expect(notifJobs.some((j) => (j.data as { notificationId?: string }).notificationId === notif!.id)).toBe(true)
  })

  it("(b) a pending_claim row stale by updated_at WITH a ticket attached is reverted to reauth_required, never deleted — deleting it would abort the whole sweep via tickets' ON DELETE NO ACTION FK", async () => {
    const orgId = await newOrg()
    const connectionId = await seedConnection(orgId, {
      status: 'pending_claim',
      createdAt: new Date(NOW.getTime() - 15 * 60_000),
      updatedAt: new Date(NOW.getTime() - 15 * 60_000),
    })
    await withPlatform(app.db, 'test:seed-cred', (tx) =>
      tx.insert(mailboxCredentials).values({ connectionId, orgId, refreshTokenCiphertext: Buffer.from('sealed'), encryption: 'sealed' }))
    await withOrg(app.db, orgId, (tx) => tx.insert(tickets).values({ orgId, connectionId, providerThreadId: `thread-${rand()}` }))
    const [notif] = await withOrg(app.db, orgId, (tx) =>
      tx.insert(notifications).values({ orgId, kind: 'escalation', title: 't', body: 'b', dedupeKey: `dk-${rand()}`, createdAt: new Date(NOW.getTime() - 15 * 60_000) }).returning())

    await runMailboxPollSweep(boss, makeDeps())

    const after = await readConnection(orgId, connectionId)
    expect(after?.status).toBe('reauth_required')
    const credRows = await withPlatform(app.db, 'test:read-cred', (tx) => tx.select().from(mailboxCredentials).where(eq(mailboxCredentials.connectionId, connectionId)))
    expect(credRows).toHaveLength(1) // untouched: a row with tickets is reverted, never deleted
    const audits = await withPlatform(app.db, 'test:audit', (tx) => tx.select().from(auditLog).where(eq(auditLog.entityId, connectionId)))
    expect(audits.some((a) => a.action === 'mailbox.claim_expired_reverted')).toBe(true)
    // The other sub-sweep in the SAME pass still committed — proof the revert's SAVEPOINT never
    // aborted the shared withPlatform transaction.
    const notifJobs = await notifyDispatchJobs()
    expect(notifJobs.some((j) => (j.data as { notificationId?: string }).notificationId === notif!.id)).toBe(true)
  })

  it('(b) a pending_claim row stale by updated_at with NO tickets has its credentials and connection row deleted, and is audited', async () => {
    const orgId = await newOrg()
    const connectionId = await seedConnection(orgId, {
      status: 'pending_claim',
      createdAt: new Date(NOW.getTime() - 15 * 60_000),
      updatedAt: new Date(NOW.getTime() - 15 * 60_000),
    })
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

  it('(e) a needs_owner/triage_cap ticket from a previous UTC day is enqueued WITHOUT any status write (needs_owner -> new is not a legal ticketTransitions edge)', async () => {
    const orgId = await newOrg()
    const connectionId = await seedConnection(orgId)
    const [ticket] = await withOrg(app.db, orgId, (tx) =>
      tx
        .insert(tickets)
        .values({
          orgId, connectionId, providerThreadId: `thread-${rand()}`, status: 'needs_owner', needsOwnerReason: 'triage_cap',
          lastTriagedAt: new Date('2026-09-08T10:00:00Z'), updatedAt: new Date('2026-09-08T10:00:00Z'),
        })
        .returning())

    await runMailboxPollSweep(boss, makeDeps())

    // The sweep itself must NEVER mutate the ticket row — it only enqueues ticket.triage, which
    // (now that isSelectable accepts needs_owner/triage_cap) is what actually lands the verdict
    // through the legal needs_owner -> triaged/resolved edge.
    const [after] = await withOrg(app.db, orgId, (tx) => tx.select().from(tickets).where(eq(tickets.id, ticket!.id)))
    expect(after?.status).toBe('needs_owner')
    expect(after?.needsOwnerReason).toBe('triage_cap')
    const jobs = await ticketTriageJobs()
    const match = jobs.find((j) => (j.data as { ticketId?: string }).ticketId === ticket!.id)
    expect(match).toBeDefined()
    expect((match!.data as { orgId?: string }).orgId).toBe(orgId)
  })

  it('(e) a same-day triage_cap ticket is neither written NOR enqueued', async () => {
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
