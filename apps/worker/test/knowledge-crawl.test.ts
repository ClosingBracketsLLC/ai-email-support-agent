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
import { runKnowledgeCrawl } from '../src/jobs/knowledge-crawl.ts'
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
let userId: string
let orgId: string

beforeAll(async () => {
  t = await createTestDatabase()
  app = createDb(t.url, { role: 'app' })
  const [u] = await app.db.insert(user).values({ name: 'Owner', email: `owner-${rand()}@example.com` }).returning()
  userId = u!.id
})
afterAll(async () => {
  await app.pool.end()
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

const run = (deps: KnowledgeDeps, sourceId: string) =>
  runKnowledgeCrawl(deps, { orgId, sourceId }, new AbortController().signal)

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

    expect(await knowledgeVersion()).toBeGreaterThanOrEqual(1)
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

  it('re-enters a `processing` source whose lease has expired (the crashed-mid-crawl retry)', async () => {
    // The lease is measured against the database clock, so the stale stamp is a REAL-clock one.
    const sourceId = await seedCrawlSource({ status: 'processing', updatedAt: new Date(Date.now() - 2 * 3600_000) })
    const { deps } = makeDeps(site())

    await run(deps, sourceId)

    expect(await documentsFor(sourceId)).toHaveLength(3)
    expect((await getSource(sourceId)).status).toBe('ready')
  })
})
