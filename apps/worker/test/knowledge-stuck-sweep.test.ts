/**
 * `runKnowledgeStuckSweep` against real Postgres and a real (test) pg-boss — no S3, no Voyage. One
 * `it` per behavior in the task brief's `knowledge.stuck-sweep` bullet list. Staleness is measured
 * against the DATABASE's own `now()` (the same convention `knowledge-crawl.ts`'s `CRAWL_LEASE_SECONDS`
 * check uses), so every "N minutes/hours ago" fixture below is relative to the real wall clock
 * (`Date.now()`), never a fixed test constant.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import type PgBoss from 'pg-boss'
import pino from 'pino'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { auditLog, knowledgeSources, user, withOrg, workspaces } from '@aesa/db'
import { createDb } from '@aesa/db/raw'
import { createTestDatabase, createTestOrganization } from '@aesa/db/testing'
import { createMemoryStore } from '@aesa/knowledge'
import { JOB_NAMES } from '@aesa/queue'
import { runKnowledgeIngest } from '../src/jobs/knowledge-ingest.ts'
import {
  QUEUED_STALE_MINUTES, STUCK_LEASE_SECONDS, STUCK_MAX_ATTEMPTS, UPLOAD_ABANDON_HOURS,
  runKnowledgeStuckSweep, type KnowledgeStuckSweepDeps,
} from '../src/jobs/knowledge-stuck-sweep.ts'
import { deleteJobsForOrgs, queryJobs, startTestBoss } from './helpers/boss.ts'

const rand = () => randomBytes(4).toString('hex')
const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000)
const hoursAgo = (n: number) => new Date(Date.now() - n * 3_600_000)

describe('knowledge.stuck-sweep', () => {
  let t: Awaited<ReturnType<typeof createTestDatabase>>
  let app: ReturnType<typeof createDb>
  let boss: PgBoss
  let userId: string
  const createdOrgIds: string[] = []

  beforeAll(async () => {
    t = await createTestDatabase()
    app = createDb(t.url)
    boss = await startTestBoss()
    await boss.createQueue(JOB_NAMES.knowledgeIngest)
    await boss.createQueue(JOB_NAMES.knowledgeCrawl)
    const [u] = await app.db.insert(user).values({ name: 'Owner', email: `owner-${rand()}@example.com` }).returning()
    userId = u!.id
  })
  afterAll(async () => {
    await deleteJobsForOrgs(JOB_NAMES.knowledgeIngest, createdOrgIds)
    await deleteJobsForOrgs(JOB_NAMES.knowledgeCrawl, createdOrgIds)
    await boss.stop({ graceful: false, wait: true })
    await app.pool.end()
    await t.drop()
  })

  async function newOrg(): Promise<string> {
    const orgId = await createTestOrganization(app)
    createdOrgIds.push(orgId)
    // knowledge.ingest's persist step bumps `workspaces.knowledge_version` — required for test (e),
    // which runs the real job end to end.
    await withOrg(app.db, orgId, (tx) => tx.insert(workspaces).values({ orgId, businessName: 'Acme Dog Supplies', timezone: 'UTC' }))
    return orgId
  }

  async function seedSource(orgId: string, over: Partial<typeof knowledgeSources.$inferInsert> = {}): Promise<string> {
    const [row] = await withOrg(app.db, orgId, (tx) =>
      tx.insert(knowledgeSources).values({
        orgId, kind: 'paste', status: 'queued', title: 'Doc', pastedText: 'Returns are free within 30 days.',
        createdBy: userId, ...over,
      }).returning({ id: knowledgeSources.id }))
    return row!.id
  }

  const getSource = async (orgId: string, sourceId: string) =>
    (await withOrg(app.db, orgId, (tx) => tx.select().from(knowledgeSources).where(eq(knowledgeSources.id, sourceId))))[0]!
  const auditRows = async (orgId: string, sourceId: string, action: string) =>
    withOrg(app.db, orgId, (tx) => tx.select().from(auditLog).where(and(eq(auditLog.entityId, sourceId), eq(auditLog.action, action))))

  function makeDeps(over: Partial<KnowledgeStuckSweepDeps> = {}): KnowledgeStuckSweepDeps {
    return { db: app.db, store: createMemoryStore(), logger: pino({ level: 'silent' }), ...over }
  }

  it('constants match the brief', () => {
    expect(STUCK_LEASE_SECONDS).toBe(600)
    expect(STUCK_MAX_ATTEMPTS).toBe(3)
    expect(QUEUED_STALE_MINUTES).toBe(10)
    expect(UPLOAD_ABANDON_HOURS).toBe(24)
  })

  it('(a) a processing CRAWL source stuck past the lease, first attempt, is requeued: queued, claim_token null, sweep_attempts 1, a knowledge.crawl job enqueued', async () => {
    const orgId = await newOrg()
    const sourceId = await seedSource(orgId, {
      kind: 'crawl', status: 'processing', url: 'https://acme.test/', pastedText: null,
      claimToken: randomUUID(), sweepAttempts: 0, updatedAt: minutesAgo(11),
    })

    const result = await runKnowledgeStuckSweep(boss, makeDeps())

    expect(result.requeued).toBe(1)
    expect(result.failed).toBe(0)
    const row = await getSource(orgId, sourceId)
    expect(row.status).toBe('queued')
    expect(row.claimToken).toBeNull()
    expect(row.sweepAttempts).toBe(1)

    const jobs = await queryJobs(JOB_NAMES.knowledgeCrawl)
    expect(jobs.some((j) => (j.data as { sourceId: string }).sourceId === sourceId)).toBe(true)

    const rows = await auditRows(orgId, sourceId, 'knowledge.source.requeued')
    expect(rows).toHaveLength(1)
  })

  it('(b) a processing UPLOAD source stuck past the lease is requeued and a knowledge.ingest job is enqueued', async () => {
    const orgId = await newOrg()
    const sourceId = await seedSource(orgId, {
      kind: 'upload', status: 'processing', pastedText: null, storageKey: `orgs/${orgId}/uploads/x/f.txt`,
      mime: 'text/plain', claimToken: randomUUID(), sweepAttempts: 0, updatedAt: minutesAgo(11),
    })

    const result = await runKnowledgeStuckSweep(boss, makeDeps())

    expect(result.requeued).toBe(1)
    const row = await getSource(orgId, sourceId)
    expect(row.status).toBe('queued')
    expect(row.claimToken).toBeNull()
    expect(row.sweepAttempts).toBe(1)

    const jobs = await queryJobs(JOB_NAMES.knowledgeIngest)
    expect(jobs.some((j) => (j.data as { sourceId: string }).sourceId === sourceId)).toBe(true)
  })

  it('(c) a processing source already at sweep_attempts 3, stale again, is failed with reason stuck (not requeued a 4th time)', async () => {
    const orgId = await newOrg()
    const sourceId = await seedSource(orgId, {
      status: 'processing', claimToken: randomUUID(), sweepAttempts: STUCK_MAX_ATTEMPTS, updatedAt: minutesAgo(11),
    })

    const result = await runKnowledgeStuckSweep(boss, makeDeps())

    expect(result.failed).toBe(1)
    expect(result.requeued).toBe(0)
    const row = await getSource(orgId, sourceId)
    expect(row.status).toBe('failed')
    expect(row.failureReason).toBe('stuck')
    expect(row.claimToken).toBeNull()

    const rows = await auditRows(orgId, sourceId, 'knowledge.source.failed')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.detail).toMatchObject({ reason: 'stuck' })

    const jobs = await queryJobs(JOB_NAMES.knowledgeIngest)
    expect(jobs.some((j) => (j.data as { sourceId: string }).sourceId === sourceId)).toBe(false)
  })

  it('(d) a processing source updated only 4 minutes ago is untouched', async () => {
    const orgId = await newOrg()
    const sourceId = await seedSource(orgId, { status: 'processing', claimToken: randomUUID(), updatedAt: minutesAgo(4) })

    const result = await runKnowledgeStuckSweep(boss, makeDeps())

    expect(result.requeued).toBe(0)
    expect(result.failed).toBe(0)
    const row = await getSource(orgId, sourceId)
    expect(row.status).toBe('processing')
    expect(row.claimToken).not.toBeNull()
  })

  it('(e) a queued PASTE source created 11 minutes ago with no job is re-enqueued, and running the real ingest job once claims it cleanly', async () => {
    const orgId = await newOrg()
    const sourceId = await seedSource(orgId, { kind: 'paste', status: 'queued', createdAt: minutesAgo(11) })

    const result = await runKnowledgeStuckSweep(boss, makeDeps())

    expect(result.requeued).toBe(1)
    const stillQueued = await getSource(orgId, sourceId)
    expect(stillQueued.status).toBe('queued') // the sweep only re-enqueues; it never writes the source itself here

    const jobs = await queryJobs(JOB_NAMES.knowledgeIngest)
    expect(jobs.some((j) => (j.data as { sourceId: string }).sourceId === sourceId)).toBe(true)

    const rows = await auditRows(orgId, sourceId, 'knowledge.source.requeued')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.detail).toMatchObject({ reason: 'queued_stale' })

    // The claim token is what makes a duplicate harmless: running the re-enqueued job for real
    // claims the source exactly once, landing `processing` (knowledge.ingest's own terminal
    // transition to `ready` is knowledge.embed-batch's job, not this one's).
    await runKnowledgeIngest(
      { db: app.db, store: createMemoryStore(), embedder: { model: 'hash-v1', version: 1, dimensions: 1024, embed: async () => ({ vectors: [], tokens: 0 }) }, logger: pino({ level: 'silent' }), enqueueEmbedBatch: async () => null },
      { orgId, sourceId },
      new AbortController().signal,
    )
    const afterIngest = await getSource(orgId, sourceId)
    expect(afterIngest.status).toBe('processing')
  })

  it('a queued CRAWL source is also subject to the stale-queued re-enqueue arm', async () => {
    const orgId = await newOrg()
    const sourceId = await seedSource(orgId, { kind: 'crawl', status: 'queued', url: 'https://acme.test/', pastedText: null, createdAt: minutesAgo(11) })

    await runKnowledgeStuckSweep(boss, makeDeps())

    const jobs = await queryJobs(JOB_NAMES.knowledgeCrawl)
    expect(jobs.some((j) => (j.data as { sourceId: string }).sourceId === sourceId)).toBe(true)
    const rows = await auditRows(orgId, sourceId, 'knowledge.source.requeued')
    expect(rows).toHaveLength(1)

    // Nothing in production ever claims this source (no fakeSite crawl runs here) — its `created_at`
    // never moves, so left as `queued` it would keep matching this SAME arm on every later sweep
    // call in this shared-database file. Simulate the real claim a `knowledge.crawl` run would make,
    // so later tests' aggregate counts are not inflated by this fixture (the same discipline
    // `ticket-backstop-sweep.test.ts`'s header describes for a shared-database test file).
    await withOrg(app.db, orgId, (tx) => tx.update(knowledgeSources).set({ status: 'processing', claimToken: randomUUID() }).where(eq(knowledgeSources.id, sourceId)))
  })

  it('a queued UPLOAD source stale past QUEUED_STALE_MINUTES is NOT re-enqueued by the paste/crawl arm (it waits on the browser, not a lost job)', async () => {
    const orgId = await newOrg()
    const sourceId = await seedSource(orgId, {
      kind: 'upload', status: 'queued', pastedText: null, storageKey: `orgs/${orgId}/uploads/y/f.txt`,
      mime: 'text/plain', createdAt: minutesAgo(11),
    })

    const result = await runKnowledgeStuckSweep(boss, makeDeps())

    expect(result.requeued).toBe(0)
    const jobs = await queryJobs(JOB_NAMES.knowledgeIngest)
    expect(jobs.some((j) => (j.data as { sourceId: string }).sourceId === sourceId)).toBe(false)
  })

  it('(f) a queued upload created 25 hours ago whose object is missing is failed reason abandoned', async () => {
    const orgId = await newOrg()
    const key = `orgs/${orgId}/uploads/z/missing.txt`
    const sourceId = await seedSource(orgId, {
      kind: 'upload', status: 'queued', pastedText: null, storageKey: key, mime: 'text/plain', createdAt: hoursAgo(25),
    })
    const store = createMemoryStore() // nothing ever `put` at `key` — store.head(key) resolves null

    const result = await runKnowledgeStuckSweep(boss, makeDeps({ store }))

    expect(result.abandoned).toBe(1)
    const row = await getSource(orgId, sourceId)
    expect(row.status).toBe('failed')
    expect(row.failureReason).toBe('abandoned')

    const rows = await auditRows(orgId, sourceId, 'knowledge.source.failed')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.detail).toMatchObject({ reason: 'abandoned' })
  })

  it('(f) a queued upload created only 2 hours ago is untouched, even with a missing object', async () => {
    const orgId = await newOrg()
    const key = `orgs/${orgId}/uploads/w/missing.txt`
    const sourceId = await seedSource(orgId, {
      kind: 'upload', status: 'queued', pastedText: null, storageKey: key, mime: 'text/plain', createdAt: hoursAgo(2),
    })
    const store = createMemoryStore()

    const result = await runKnowledgeStuckSweep(boss, makeDeps({ store }))

    expect(result.abandoned).toBe(0)
    const row = await getSource(orgId, sourceId)
    expect(row.status).toBe('queued')
  })

  it('a queued upload created 25 hours ago whose object IS present is left alone', async () => {
    const orgId = await newOrg()
    const key = `orgs/${orgId}/uploads/v/present.txt`
    const sourceId = await seedSource(orgId, {
      kind: 'upload', status: 'queued', pastedText: null, storageKey: key, mime: 'text/plain', createdAt: hoursAgo(25),
    })
    const store = createMemoryStore()
    await store.put(key, new TextEncoder().encode('hello'), 'text/plain')

    const result = await runKnowledgeStuckSweep(boss, makeDeps({ store }))

    expect(result.abandoned).toBe(0)
    const row = await getSource(orgId, sourceId)
    expect(row.status).toBe('queued')
    expect(row.failureReason).toBeNull()
  })

  it('a second, untouched org is left completely alone by a sweep acting on the first org', async () => {
    const orgA = await newOrg()
    const orgB = await newOrg()
    const stuckId = await seedSource(orgA, { status: 'processing', claimToken: randomUUID(), updatedAt: minutesAgo(11) })
    const quietId = await seedSource(orgB, { status: 'processing', claimToken: randomUUID(), updatedAt: minutesAgo(4) })

    await runKnowledgeStuckSweep(boss, makeDeps())

    expect((await getSource(orgA, stuckId)).status).toBe('queued')
    const quiet = await getSource(orgB, quietId)
    expect(quiet.status).toBe('processing')
    expect(await auditRows(orgB, quietId, 'knowledge.source.requeued')).toHaveLength(0)
  })
})
