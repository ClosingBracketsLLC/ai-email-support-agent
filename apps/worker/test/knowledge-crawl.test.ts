/**
 * `runKnowledgeCrawl` against real Postgres and `fakeSite` (an in-memory site: no network, no DNS)
 * — no pg-boss, no S3. One `it` per behavior in the task brief's `knowledge.crawl` bullet.
 *
 * The crawler's own politeness delay (250 ms between requests to one host) makes each of these a
 * second or so; that is the real engine running, which is the point — the job is only tested
 * through it, never around it.
 */
import { randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import pino from 'pino'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  auditLog, knowledgeChunks, knowledgeDocuments, knowledgeSources, orgSettings, usageCounters,
  user, withOrg, workspaces,
} from '@aesa/db'
import { createDb } from '@aesa/db/raw'
import { createTestDatabase, createTestOrganization } from '@aesa/db/testing'
import { createHashEmbedder, createMemoryStore } from '@aesa/knowledge'
import { fakeSite } from '@aesa/knowledge/testing'
import { CRAWL_LEASE_SECONDS, knowledgeCrawlJob, runKnowledgeCrawl } from '../src/jobs/knowledge-crawl.ts'
import { createWorkerLogger } from '../src/logging.ts'
import { guardedSourceWrite } from '../src/knowledge/sources.ts'
import type { KnowledgeDeps } from '../src/knowledge-deps.ts'

const rand = () => randomBytes(4).toString('hex')
const NOW = new Date('2026-09-11T12:00:00Z')
const START = 'https://shop.test/'

const page = (heading: string, body: string, links: string[] = []) =>
  `<html><head><title>${heading}</title></head><body><h1>${heading}</h1><p>${body}</p>${links.map((l) => `<a href="${l}">${l}</a>`).join('')}</body></html>`

function site() {
  return {
    '/': { body: page('Shop', 'Acme Dog Supplies sells beds, leads and bowls to customers across the country.', ['/a', '/b']) },
    '/a': { body: page('Returns', 'Returns are free within 30 days of delivery; email support with your order number.') },
    '/b': { body: page('Shipping', 'Orders placed before two in the afternoon ship the same working day.') },
  }
}

let t: Awaited<ReturnType<typeof createTestDatabase>>
let app: ReturnType<typeof createDb>
/** The table owner: one test revokes a privilege from `aesa_app` to make the batch transaction — and
 *  only that transaction — fail the way a dropped connection would. */
let owner: ReturnType<typeof createDb>
let userId: string
let orgId: string

beforeAll(async () => {
  t = await createTestDatabase()
  app = createDb(t.url, { role: 'app' })
  owner = createDb(t.url, { role: 'owner' })
  const [u] = await app.db.insert(user).values({ name: 'Owner', email: `owner-${rand()}@example.com` }).returning()
  userId = u!.id
})
afterAll(async () => {
  await app.pool.end()
  await owner.pool.end()
  await t.drop()
})
beforeEach(async () => {
  orgId = await createTestOrganization(app)
  await withOrg(app.db, orgId, (tx) => tx.insert(workspaces).values({ orgId, businessName: 'Acme Dog Supplies', timezone: 'UTC' }))
})

async function seedCrawlSource(values: Partial<typeof knowledgeSources.$inferInsert> = {}): Promise<string> {
  const [row] = await withOrg(app.db, orgId, (tx) =>
    tx.insert(knowledgeSources).values({
      orgId, kind: 'crawl', status: 'queued', title: 'shop.test', url: START,
      crawlConfig: { maxPages: 50 }, createdBy: userId, ...values,
    }).returning({ id: knowledgeSources.id }))
  return row!.id
}

const getSource = async (sourceId: string) =>
  (await withOrg(app.db, orgId, (tx) => tx.select().from(knowledgeSources).where(eq(knowledgeSources.id, sourceId))))[0]!
const documentsFor = async (sourceId: string) =>
  withOrg(app.db, orgId, (tx) => tx.select().from(knowledgeDocuments).where(eq(knowledgeDocuments.sourceId, sourceId)).orderBy(knowledgeDocuments.uri))
const chunksFor = async (documentId: string) =>
  withOrg(app.db, orgId, (tx) => tx.select().from(knowledgeChunks).where(eq(knowledgeChunks.documentId, documentId)).orderBy(knowledgeChunks.ordinal))
const knowledgeVersion = async () =>
  (await withOrg(app.db, orgId, (tx) => tx.select({ v: workspaces.knowledgeVersion }).from(workspaces).where(eq(workspaces.orgId, orgId))))[0]!.v
const meter = async (name: string) =>
  (await withOrg(app.db, orgId, (tx) => tx.select().from(usageCounters).where(eq(usageCounters.meter, name))))[0]?.value ?? 0
const auditRows = async (entityId: string) =>
  withOrg(app.db, orgId, (tx) => tx.select().from(auditLog).where(eq(auditLog.entityId, entityId)))

interface Harness {
  deps: KnowledgeDeps
  embedded: string[]
  hits: string[]
}

function makeDeps(pages: Record<string, { body: string }>, over: Partial<KnowledgeDeps> = {}): Harness {
  const fake = fakeSite(pages)
  const embedded: string[] = []
  const deps: KnowledgeDeps = {
    db: app.db,
    store: createMemoryStore(),
    embedder: createHashEmbedder(),
    logger: pino({ level: 'silent' }),
    enqueueEmbedBatch: async (_org, documentId) => { embedded.push(documentId); return 'job-1' },
    now: () => NOW,
    crawlFetch: fake.fetch,
    resolver: fake.resolver,
    ...over,
  }
  return { deps, embedded, hits: fake.hits }
}

const run = (deps: KnowledgeDeps, sourceId: string, signal = new AbortController().signal) =>
  runKnowledgeCrawl(deps, { orgId, sourceId }, signal)

describe('knowledge.crawl', () => {
  it('the three-page site becomes three documents, meters crawl_pages, writes progress and lands `ready`', async () => {
    const sourceId = await seedCrawlSource()
    const { deps, embedded } = makeDeps(site())

    await run(deps, sourceId)

    const source = await getSource(sourceId)
    expect(source.status).toBe('ready')
    expect(source.completedAt?.toISOString()).toBe(NOW.toISOString())
    expect(source.documentCount).toBe(3)
    const docs = await documentsFor(sourceId)
    expect(docs.map((d) => d.uri)).toEqual(['https://shop.test/', 'https://shop.test/a', 'https://shop.test/b'])
    expect(docs.every((d) => d.version === 1)).toBe(true)
    expect(docs[1]!.title).toBe('Returns')
    const chunkCounts = await Promise.all(docs.map(async (d) => (await chunksFor(d.id)).length))
    expect(chunkCounts.every((n) => n > 0)).toBe(true)
    expect(source.chunkCount).toBe(chunkCounts.reduce((a, b) => a + b, 0))

    expect(await meter('crawl_pages')).toBe(3)
    // The progress the owner's Knowledge screen polls, written while the crawl was still running.
    const progress = (source.crawlConfig as { progress?: { fetched: number; ingested: number; skipped: number } }).progress
    expect(progress?.ingested).toBe(3)
    expect(progress?.fetched).toBeGreaterThanOrEqual(3)
    expect((source.crawlConfig as { maxPages?: number }).maxPages).toBe(50)

    // Exactly one bump: three pages under the 20-page first batch is ONE onBatch transaction.
    expect(await knowledgeVersion()).toBe(1)
    expect(embedded.sort()).toEqual(docs.map((d) => d.id).sort())
    const finished = (await auditRows(sourceId)).filter((r) => r.action === 'knowledge.crawl.finished')
    expect(finished).toHaveLength(1)
    expect(finished[0]!.actor).toBe('system:knowledge.crawl')
    expect(finished[0]!.detail).toMatchObject({ ingested: 3, refused: 0 })
  })

  it('a second crawl re-chunks only the page whose content changed (version 2) and leaves the rest untouched', async () => {
    const sourceId = await seedCrawlSource()
    const pages = site()
    const { deps, embedded } = makeDeps(pages)

    await run(deps, sourceId)
    const first = await documentsFor(sourceId)
    const unchangedChunkIds = (await chunksFor(first[1]!.id)).map((c) => c.id)
    const changedChunkIds = (await chunksFor(first[2]!.id)).map((c) => c.id)
    embedded.length = 0

    pages['/b'] = { body: page('Shipping', 'Orders now ship twice a day, at noon and at five in the afternoon, worldwide.') }
    await withOrg(app.db, orgId, (tx) => tx.update(knowledgeSources).set({ status: 'queued' }).where(eq(knowledgeSources.id, sourceId)))
    await run(deps, sourceId)

    const docs = await documentsFor(sourceId)
    expect(docs).toHaveLength(3)
    expect(docs[1]!.version).toBe(1)
    expect((await chunksFor(docs[1]!.id)).map((c) => c.id)).toEqual(unchangedChunkIds)
    expect(docs[2]!.version).toBe(2)
    const rechunked = await chunksFor(docs[2]!.id)
    expect(rechunked.map((c) => c.id).some((id) => changedChunkIds.includes(id))).toBe(false)
    expect(rechunked[0]!.content).toContain('twice a day')
    // Only the changed document is re-embedded.
    expect(embedded).toEqual([docs[2]!.id])
    expect((await getSource(sourceId)).status).toBe('ready')

    // A THIRD walk with nothing changed persists nothing, so it does not bump the version either:
    // every draft's `knowledge_version` stamp stays valid (final-B minor).
    const version = await knowledgeVersion()
    await withOrg(app.db, orgId, (tx) => tx.update(knowledgeSources).set({ status: 'queued' }).where(eq(knowledgeSources.id, sourceId)))
    await run(deps, sourceId)

    expect(await knowledgeVersion()).toBe(version)
    expect(embedded).toEqual([docs[2]!.id])       // nothing new to embed
    expect((await getSource(sourceId)).status).toBe('ready')
  })

  it("clamps crawl_config.maxPages to the org's knowledge.max_crawl_pages setting", async () => {
    await withOrg(app.db, orgId, (tx) => tx.insert(orgSettings).values({ orgId, key: 'knowledge.max_crawl_pages', value: 2 }))
    const sourceId = await seedCrawlSource({ crawlConfig: { maxPages: 500 } })
    const { deps } = makeDeps(site())

    await run(deps, sourceId)

    const docs = await documentsFor(sourceId)
    expect(docs).toHaveLength(2)
    expect(docs.map((d) => d.uri)).toEqual(['https://shop.test/', 'https://shop.test/a'])
    expect((await getSource(sourceId)).status).toBe('ready')
    expect(await meter('crawl_pages')).toBe(2)
  })

  it('a site that yields no page at all fails `crawl_no_pages`', async () => {
    const sourceId = await seedCrawlSource()
    const { deps, embedded } = makeDeps({})

    await run(deps, sourceId)

    const source = await getSource(sourceId)
    expect(source.status).toBe('failed')
    expect(source.failureReason).toBe('crawl_no_pages')
    expect(source.documentCount).toBe(0)
    expect(embedded).toHaveLength(0)
  })

  it('a start URL the SSRF guard refuses fails `crawl_failed` terminally — no throw', async () => {
    const sourceId = await seedCrawlSource({ url: 'https://api.internal/docs' })
    const { deps, hits } = makeDeps(site())

    await expect(run(deps, sourceId)).resolves.toBeUndefined()

    const source = await getSource(sourceId)
    expect(source.status).toBe('failed')
    expect(source.failureReason).toBe('crawl_failed')
    expect(hits).toHaveLength(0)
  })

  it('two concurrent runs for one org serialize: the second sees `processing` and returns', async () => {
    const sourceId = await seedCrawlSource()
    const a = makeDeps(site())
    const b = makeDeps(site())

    await Promise.all([run(a.deps, sourceId), run(b.deps, sourceId)])

    expect(await documentsFor(sourceId)).toHaveLength(3)
    expect((await auditRows(sourceId)).filter((r) => r.action === 'knowledge.crawl.finished')).toHaveLength(1)
    // Exactly one of the two ever reached the site.
    expect([a.hits.length === 0, b.hits.length === 0].filter(Boolean)).toHaveLength(1)
  })

  it('the queue options keep the single retry BEHIND the lease, so it can actually re-claim', () => {
    // A retry that fires before `CRAWL_LEASE_SECONDS` has lapsed finds the source still `processing`,
    // cannot claim, and silently does nothing — the delay and the lease are one mechanism.
    expect(knowledgeCrawlJob.queue).toEqual({ expireInSeconds: 1800, retryLimit: 1, retryDelay: 300, retryBackoff: false, policy: 'short' })
    expect(CRAWL_LEASE_SECONDS).toBe(300)
    expect(knowledgeCrawlJob.queue.retryDelay).toBe(CRAWL_LEASE_SECONDS)
  })

  it('an abort mid-walk re-queues the source and FAILS the job — a partial site is never `ready`', async () => {
    const sourceId = await seedCrawlSource()
    const controller = new AbortController()
    const fake = fakeSite(site())
    const { deps } = makeDeps(site(), {
      // Abort once the first real page has been fetched: the walk stops between waves and returns a
      // PARTIAL summary, which must never be mistaken for a finished crawl.
      crawlFetch: async (url, init) => {
        const res = await fake.fetch(url, init)
        if (!url.endsWith('/robots.txt') && !url.endsWith('/sitemap.xml')) controller.abort()
        return res
      },
      resolver: fake.resolver,
    })

    await expect(run(deps, sourceId, controller.signal)).rejects.toThrow(/aborted before completion/)

    const source = await getSource(sourceId)
    expect(source.status).toBe('queued')
    expect(source.claimToken).toBeNull()
    expect(source.failureReason).toBeNull()
    expect(source.completedAt).toBeNull()
    // Progress survives the hand-back — it is what the owner's screen has been showing.
    expect((source.crawlConfig as { progress?: { fetched: number } }).progress?.fetched).toBeGreaterThanOrEqual(1)
    const aborted = (await auditRows(sourceId)).filter((r) => r.action === 'knowledge.crawl.aborted')
    expect(aborted).toHaveLength(1)
    expect(aborted[0]!.detail).toMatchObject({ ingested: expect.any(Number), fetched: expect.any(Number) })
    expect((await auditRows(sourceId)).some((r) => r.action === 'knowledge.crawl.finished')).toBe(false)
  })

  it("OUR persistence failing (a consumer-origin CrawlError) re-queues and rethrows — the owner's site is never blamed", async () => {
    const sourceId = await seedCrawlSource()
    const lines: string[] = []
    const { deps } = makeDeps(site(), { logger: createWorkerLogger('info', { write: (line: string) => void lines.push(line) }) })
    // The batch transaction — and only it — fails: the chunk insert loses its privilege. The
    // document insert and every `knowledge_sources` write still work, so this is precisely the
    // "onBatch threw" path, not a progress-write failure.
    await owner.pool.query('REVOKE INSERT ON knowledge_chunks FROM aesa_app')
    let thrown: unknown
    try {
      thrown = await run(deps, sourceId).then(() => null, (err: unknown) => err)
    } finally {
      await owner.pool.query('GRANT INSERT ON knowledge_chunks TO aesa_app')
    }
    // The ORIGINAL error reaches pg-boss, not the CrawlError wrapper: drizzle's own
    // `DrizzleQueryError` ("Failed query: insert into knowledge_chunks …") with pg's
    // "permission denied" on its `cause`.
    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toMatch(/insert into "knowledge_chunks"/)
    expect(String(((thrown as { cause?: { message?: string } }).cause)?.message)).toMatch(/permission denied/)

    // Nor does the page text reach the LOG: a `DrizzleQueryError`'s message is
    // `Failed query: … params: <the page's own text>`, and pino's `err` serializer would copy its
    // enumerable `query`/`params` too (final-B5). The driver's own message and code stand in.
    const warn = lines.map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l.level === 40)!
    expect(warn.msg).toMatch(/batch persistence failed/)
    expect(warn.error).toBe('batch persistence failed')
    expect(warn.driver).toMatchObject({ name: 'DrizzleQueryError', code: '42501', message: expect.stringMatching(/permission denied/) })
    expect(JSON.stringify(warn)).not.toContain('Acme Dog Supplies sells beds')

    const source = await getSource(sourceId)
    expect(source.status).toBe('queued')          // re-queued for pg-boss's retry, NOT failed
    expect(source.claimToken).toBeNull()
    expect(source.failureReason).toBeNull()
    expect(source.failureDetail).toBeNull()       // no driver message ever reaches the owner
  })

  it('a crawl carrying an embed failure reason lands `failed` with that reason, not `ready`', async () => {
    const sourceId = await seedCrawlSource()
    const fake = fakeSite(site())
    const { deps } = makeDeps(site(), {
      // What `knowledge.embed-batch` does to a crawl source: records the reason, touches no status.
      crawlFetch: async (url, init) => {
        const res = await fake.fetch(url, init)
        if (url.endsWith('/b')) {
          await withOrg(app.db, orgId, (tx) =>
            tx.update(knowledgeSources).set({ failureReason: 'cap_reached', failureDetail: 'budget used up' }).where(eq(knowledgeSources.id, sourceId)))
        }
        return res
      },
      resolver: fake.resolver,
    })

    await run(deps, sourceId)

    const source = await getSource(sourceId)
    expect(source.status).toBe('failed')
    expect(source.failureReason).toBe('cap_reached')
    expect(source.failureDetail).toBe('budget used up')
    expect(source.completedAt?.toISOString()).toBe(NOW.toISOString())
    expect((await auditRows(sourceId)).find((r) => r.action === 'knowledge.crawl.finished')!.detail).toMatchObject({ failureReason: 'cap_reached' })
  })

  it("a lapsed attempt's late writes no-op: the claim token, isolated from the status guard", async () => {
    const sourceId = await seedCrawlSource({ status: 'processing' })
    const tokenA = crypto.randomUUID()
    const tokenB = crypto.randomUUID()
    await withOrg(app.db, orgId, (tx) => tx.update(knowledgeSources).set({ claimToken: tokenA }).where(eq(knowledgeSources.id, sourceId)))
    // Attempt B re-claims after A's lease lapsed. The STATUS is `processing` throughout, so only the
    // token can tell A's late writes apart from B's.
    await withOrg(app.db, orgId, (tx) => guardedSourceWrite(tx, sourceId, ['processing'], { claimToken: tokenB }, tokenA))

    // Sequential, not Promise.all: one transaction is one connection, and pg refuses to run two
    // queries on it at once.
    const [handBack, ready, progress] = await withOrg(app.db, orgId, async (tx) => [
      await guardedSourceWrite(tx, sourceId, ['processing'], { status: 'queued', claimToken: null }, tokenA),
      await guardedSourceWrite(tx, sourceId, ['processing'], { status: 'ready', completedAt: NOW }, tokenA),
      await guardedSourceWrite(tx, sourceId, ['processing'], { documentCount: 99 }, tokenA),
    ])
    expect([handBack, ready, progress]).toEqual([false, false, false])

    const source = await getSource(sourceId)
    expect(source.status).toBe('processing')
    expect(source.claimToken).toBe(tokenB)
    expect(source.documentCount).toBe(0)
    // B still owns it, and its own write lands.
    expect(await withOrg(app.db, orgId, (tx) => guardedSourceWrite(tx, sourceId, ['processing'], { status: 'ready', claimToken: null }, tokenB))).toBe(true)
  })

  it("a re-claim while attempt A is still walking: A's landing never overwrites B's", async () => {
    const sourceId = await seedCrawlSource()
    const fake = fakeSite(site())
    const b = makeDeps({})   // B crawls a site with no pages at all, so it lands `crawl_no_pages`
    const { deps } = makeDeps(site(), {
      crawlFetch: async (url, init) => {
        const res = await fake.fetch(url, init)
        if (url.endsWith('/robots.txt')) {
          // A's lease lapses and B takes the source over while A is still walking.
          await withOrg(app.db, orgId, (tx) =>
            tx.update(knowledgeSources).set({ updatedAt: new Date(Date.now() - 2 * CRAWL_LEASE_SECONDS * 1000) }).where(eq(knowledgeSources.id, sourceId)))
          await run(b.deps, sourceId)
        }
        return res
      },
      resolver: fake.resolver,
    })

    await run(deps, sourceId)

    const source = await getSource(sourceId)
    expect(source.status).toBe('failed')             // B's verdict stands
    expect(source.failureReason).toBe('crawl_no_pages')
    expect(source.claimToken).toBeNull()
    expect(source.documentCount).toBe(0)             // A's count updates no-opped too
    expect((await auditRows(sourceId)).some((r) => r.action === 'knowledge.crawl.finished')).toBe(false)
  })

  it('re-enters a `processing` source whose lease has expired (the crashed-mid-crawl retry)', async () => {
    // The lease is measured against the database clock, so the stale stamp is a REAL-clock one.
    const sourceId = await seedCrawlSource({ status: 'processing', updatedAt: new Date(Date.now() - 2 * 3600_000) })
    const { deps } = makeDeps(site())

    await run(deps, sourceId)

    expect(await documentsFor(sourceId)).toHaveLength(3)
    expect((await getSource(sourceId)).status).toBe('ready')
  })
})
