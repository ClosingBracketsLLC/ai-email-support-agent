/**
 * `runKnowledgeEmbedBatch` against real Postgres with the deterministic hash embedder — no pg-boss,
 * no Voyage, no S3. One `it` per behavior in the task brief's `knowledge.embed-batch` bullet.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { eq, isNull } from 'drizzle-orm'
import pino from 'pino'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  auditLog, knowledgeChunks, knowledgeDocuments, knowledgeSources, orgSettings, usageCounters,
  user, withOrg, workspaces,
} from '@aesa/db'
import { createDb } from '@aesa/db/raw'
import { createTestDatabase, createTestOrganization } from '@aesa/db/testing'
import { createHashEmbedder, createMemoryStore, EmbedError, type Embedder } from '@aesa/knowledge'
import { knowledgeEmbedBatchJob, runKnowledgeEmbedBatch, type EmbedAttempt } from '../src/jobs/knowledge-embed-batch.ts'
import type { KnowledgeDeps } from '../src/knowledge-deps.ts'

const rand = () => randomBytes(4).toString('hex')
const NOW = new Date('2026-09-11T12:00:00Z')
const TODAY = '2026-09-11'

const CONTENTS = [
  'Returns are free within 30 days of delivery.',
  'Orders placed before two in the afternoon ship the same working day.',
  'Beds, leads and bowls are all covered by the same one-year warranty.',
]

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

/** One source + one document + `CONTENTS.length` unembedded chunks — what knowledge.ingest leaves
 *  behind, claim token included (it is still `processing`: the pipeline ends here, not there). */
async function seedDocument(over: Partial<typeof knowledgeSources.$inferInsert> = {}): Promise<{ sourceId: string; documentId: string }> {
  return withOrg(app.db, orgId, async (tx) => {
    const [source] = await tx.insert(knowledgeSources).values({
      orgId, kind: 'paste', status: 'processing', title: 'Returns FAQ', pastedText: CONTENTS.join('\n\n'),
      documentCount: 1, chunkCount: CONTENTS.length, createdBy: userId, claimToken: randomUUID(), ...over,
    }).returning({ id: knowledgeSources.id })
    const [doc] = await tx.insert(knowledgeDocuments).values({
      orgId, sourceId: source!.id, uri: `paste:${source!.id}`, title: 'Returns FAQ', contentHash: 'h'.repeat(64), chunkCount: CONTENTS.length,
    }).returning({ id: knowledgeDocuments.id })
    await tx.insert(knowledgeChunks).values(CONTENTS.map((content, ordinal) => ({
      orgId, documentId: doc!.id, ordinal, headingPath: ['Returns'], content, tokenCount: Math.ceil(content.length / 4),
    })))
    return { sourceId: source!.id, documentId: doc!.id }
  })
}

const getSource = async (sourceId: string) =>
  (await withOrg(app.db, orgId, (tx) => tx.select().from(knowledgeSources).where(eq(knowledgeSources.id, sourceId))))[0]!
const getDocument = async (documentId: string) =>
  (await withOrg(app.db, orgId, (tx) => tx.select().from(knowledgeDocuments).where(eq(knowledgeDocuments.id, documentId))))[0]!
const chunksFor = async (documentId: string) =>
  withOrg(app.db, orgId, (tx) => tx.select().from(knowledgeChunks).where(eq(knowledgeChunks.documentId, documentId)).orderBy(knowledgeChunks.ordinal))
const unembeddedCount = async (documentId: string) =>
  (await withOrg(app.db, orgId, (tx) => tx.select().from(knowledgeChunks).where(isNull(knowledgeChunks.embedding)))).filter((c) => c.documentId === documentId).length
const meter = async (name: string) =>
  (await withOrg(app.db, orgId, (tx) => tx.select().from(usageCounters).where(eq(usageCounters.meter, name))))[0]?.value ?? 0
const auditRows = async (entityId: string) =>
  withOrg(app.db, orgId, (tx) => tx.select().from(auditLog).where(eq(auditLog.entityId, entityId)))

function makeDeps(over: Partial<KnowledgeDeps> = {}): KnowledgeDeps {
  return {
    db: app.db,
    store: createMemoryStore(),
    embedder: createHashEmbedder(),
    logger: pino({ level: 'silent' }),
    enqueueEmbedBatch: async () => 'job-1',
    now: () => NOW,
    ...over,
  }
}

const failingEmbedder = (err: unknown): Embedder => ({
  model: 'hash-v1', version: 1, dimensions: 1024,
  embed: async () => { throw err },
})

const run = (deps: KnowledgeDeps, documentId: string, attempt?: EmbedAttempt) =>
  runKnowledgeEmbedBatch(deps, { orgId, documentId }, new AbortController().signal, attempt)

/** What `registerJob` hands the handler off pg-boss's job metadata on the attempt with nothing after it. */
const LAST_ATTEMPT: EmbedAttempt = { retryCount: 5, retryLimit: 5 }

describe('knowledge.embed-batch', () => {
  it('fills every null embedding, meters embed_tokens and flips the ingest source to `ready`', async () => {
    const { sourceId, documentId } = await seedDocument()
    const deps = makeDeps()

    await run(deps, documentId)

    const chunks = await chunksFor(documentId)
    expect(chunks).toHaveLength(3)
    expect(chunks.every((c) => c.embedding !== null)).toBe(true)
    expect(chunks.every((c) => c.embeddingModel === deps.embedder.model && c.embeddingVersion === deps.embedder.version)).toBe(true)

    expect((await getDocument(documentId)).embeddedCount).toBe(3)
    // The exact sum the embedder reported for this one batch — not "more than zero".
    const { tokens } = await createHashEmbedder().embed(CONTENTS, 'document')
    expect(await meter('embed_tokens')).toBe(tokens)

    const source = await getSource(sourceId)
    expect(source.status).toBe('ready')
    expect(source.completedAt?.toISOString()).toBe(NOW.toISOString())
    expect(source.claimToken).toBeNull()   // the pipeline's end releases the ingest run's claim
    expect((await auditRows(sourceId)).map((r) => ({ actor: r.actor, action: r.action }))).toEqual([
      { actor: 'system:knowledge.embed-batch', action: 'knowledge.source.ready' },
    ])
  })

  it('the queue gives the retries a real window: five, 30 s apart, with backoff', () => {
    // pg-boss's default base delay is 1 s, which put the five retries at ~1/2/4/8/16 s — one minute
    // of Voyage outage exhausted the whole budget. 30 s with backoff spans ~15 minutes instead, and
    // the LAST attempt lands a verdict rather than rethrowing (the two halves of final-B1).
    expect(knowledgeEmbedBatchJob.queue).toEqual({
      expireInSeconds: 300, retryLimit: 5, retryDelay: 30, retryBackoff: true, policy: 'short',
    })
  })

  it('a retryable EmbedError rethrows for pg-boss and leaves every row null', async () => {
    const { sourceId, documentId } = await seedDocument()
    const deps = makeDeps({ embedder: failingEmbedder(new EmbedError('rate_limit', 'voyage: 429')) })

    await expect(run(deps, documentId)).rejects.toThrow(EmbedError)

    expect(await unembeddedCount(documentId)).toBe(3)
    expect(await meter('embed_tokens')).toBe(0)
    expect((await getSource(sourceId)).status).toBe('processing')
  })

  it('the LAST attempt records `embed_failed` instead of rethrowing — an ingest source never strands `processing`', async () => {
    const { sourceId, documentId } = await seedDocument()
    const deps = makeDeps({ embedder: failingEmbedder(new EmbedError('rate_limit', 'voyage: 429 rate limited')) })

    // Second to last: still rethrows, because there is another attempt coming.
    await expect(run(deps, documentId, { retryCount: 4, retryLimit: 5 })).rejects.toThrow(EmbedError)
    expect((await getSource(sourceId)).status).toBe('processing')

    await expect(run(deps, documentId, LAST_ATTEMPT)).resolves.toBeUndefined()

    const source = await getSource(sourceId)
    expect(source.status).toBe('failed')
    expect(source.failureReason).toBe('embed_failed')
    expect(source.failureDetail).toContain('429')
    // The claim the ingest run took is released with the landing — nothing else would ever clear it.
    expect(source.claimToken).toBeNull()
    expect(await unembeddedCount(documentId)).toBe(3)
  })

  it('the last attempt on a NON-EmbedError records a detail with no provider internals', async () => {
    const { sourceId, documentId } = await seedDocument()
    const deps = makeDeps({ embedder: failingEmbedder(new Error('ECONNRESET https://api.voyageai.com/v1/embeddings?key=shh')) })

    await expect(run(deps, documentId, LAST_ATTEMPT)).resolves.toBeUndefined()

    const source = await getSource(sourceId)
    expect(source.status).toBe('failed')
    expect(source.failureReason).toBe('embed_failed')
    expect(source.failureDetail).toBe('the embedding provider could not be reached')
  })

  it('a non-retryable EmbedError fails the source `embed_failed` — no throw', async () => {
    const { sourceId, documentId } = await seedDocument()
    const deps = makeDeps({ embedder: failingEmbedder(new EmbedError('auth', 'voyage: 401 invalid key')) })

    await expect(run(deps, documentId)).resolves.toBeUndefined()

    const source = await getSource(sourceId)
    expect(source.status).toBe('failed')
    expect(source.failureReason).toBe('embed_failed')
    expect(source.failureDetail).toContain('401')
    expect(await unembeddedCount(documentId)).toBe(3)
  })

  it("the org's daily embed-token cap fails the source `cap_reached` before a single call", async () => {
    const { sourceId, documentId } = await seedDocument()
    await withOrg(app.db, orgId, async (tx) => {
      await tx.insert(orgSettings).values({ orgId, key: 'knowledge.daily_embed_tokens_cap', value: 100 })
      await tx.insert(usageCounters).values({ orgId, day: TODAY, meter: 'embed_tokens', value: 100 })
    })
    let calls = 0
    const deps = makeDeps({ embedder: { ...createHashEmbedder(), embed: async (...args) => { calls++; return createHashEmbedder().embed(...args) } } })

    await run(deps, documentId)

    expect(calls).toBe(0)
    const source = await getSource(sourceId)
    expect(source.status).toBe('failed')
    expect(source.failureReason).toBe('cap_reached')
    expect(await unembeddedCount(documentId)).toBe(3)
  })

  it('a crawl source is never flipped to `ready` here — the crawl job owns that', async () => {
    const { sourceId, documentId } = await seedDocument({ kind: 'crawl', url: 'https://shop.test/', pastedText: null })
    const deps = makeDeps()

    await run(deps, documentId)

    expect(await unembeddedCount(documentId)).toBe(0)
    expect((await getSource(sourceId)).status).toBe('processing')
    expect(await auditRows(sourceId)).toHaveLength(0)
  })

  it("a crawl source's embed failure records the REASON and leaves the status to the crawl job", async () => {
    const { sourceId, documentId } = await seedDocument({ kind: 'crawl', url: 'https://shop.test/', pastedText: null })
    const deps = makeDeps({ embedder: failingEmbedder(new EmbedError('auth', 'voyage: 401 invalid key')) })

    await run(deps, documentId)

    const source = await getSource(sourceId)
    // Still `processing`: the crawl may well still be walking, and flipping it `failed` here would
    // strand a live crawl whose claim this job does not hold. The crawl's end transition reads this
    // reason and lands `failed` with it.
    expect(source.status).toBe('processing')
    expect(source.failureReason).toBe('embed_failed')
    expect(source.failureDetail).toContain('401')
    expect(source.completedAt).toBeNull()
    expect((await auditRows(sourceId)).map((r) => r.action)).toEqual(['knowledge.source.embed_failed'])
  })

  it("a crawl source's cap_reached is recorded the same way — reason only, status untouched", async () => {
    const { sourceId, documentId } = await seedDocument({ kind: 'crawl', url: 'https://shop.test/', pastedText: null })
    await withOrg(app.db, orgId, async (tx) => {
      await tx.insert(orgSettings).values({ orgId, key: 'knowledge.daily_embed_tokens_cap', value: 10 })
      await tx.insert(usageCounters).values({ orgId, day: TODAY, meter: 'embed_tokens', value: 10 })
    })

    await run(makeDeps(), documentId)

    const source = await getSource(sourceId)
    expect(source.status).toBe('processing')
    expect(source.failureReason).toBe('cap_reached')
    expect(await unembeddedCount(documentId)).toBe(3)
  })

  it("a verdict arriving AFTER the crawl landed `ready` flips it to `failed` (the last batch's embed jobs)", async () => {
    // The crawl's end transition runs as soon as its last batch is enqueued, so those documents'
    // embed jobs can report after it. Guarding on `processing` alone matched nothing and left the
    // source `ready` with chunks that never got vectors (final-B2).
    const completedAt = new Date('2026-09-11T11:59:00Z')
    const { sourceId, documentId } = await seedDocument({
      kind: 'crawl', url: 'https://shop.test/', pastedText: null, status: 'ready', claimToken: null, completedAt,
    })
    const deps = makeDeps({ embedder: failingEmbedder(new EmbedError('auth', 'voyage: 401 invalid key')) })

    await run(deps, documentId)

    const source = await getSource(sourceId)
    expect(source.status).toBe('failed')
    expect(source.failureReason).toBe('embed_failed')
    expect(source.failureDetail).toContain('401')
    // The walk really did finish then — only the verdict changed.
    expect(source.completedAt?.toISOString()).toBe(completedAt.toISOString())
    expect((await auditRows(sourceId)).map((r) => r.action)).toEqual(['knowledge.source.embed_failed'])
  })

  it('records a crawl source\'s FIRST verdict only — 200 failing documents write one audit row', async () => {
    const { sourceId, documentId } = await seedDocument({ kind: 'crawl', url: 'https://shop.test/', pastedText: null })
    const deps = makeDeps({ embedder: failingEmbedder(new EmbedError('auth', 'voyage: 401 invalid key')) })

    await run(deps, documentId)
    await run(deps, documentId)
    await run(deps, documentId)

    expect((await getSource(sourceId)).failureReason).toBe('embed_failed')
    expect(await auditRows(sourceId)).toHaveLength(1)
  })

  it('checks the daily cap before EVERY Voyage call, not once per job', async () => {
    // 130 chunks is two batches (batchTexts caps a batch at 128 texts). The cap is untouched when
    // the first one starts and used up by the time the second would, so exactly one call happens.
    const { sourceId, documentId } = await seedDocument()
    await withOrg(app.db, orgId, async (tx) => {
      await tx.insert(orgSettings).values({ orgId, key: 'knowledge.daily_embed_tokens_cap', value: 100 })
      await tx.insert(knowledgeChunks).values(
        Array.from({ length: 130 }, (_, i) => ({
          orgId, documentId, ordinal: i + CONTENTS.length,
          content: `Gift card number ${i} never expires and can be topped up at any time.`, tokenCount: 18,
        })),
      )
      await tx.update(knowledgeDocuments).set({ chunkCount: 130 + CONTENTS.length }).where(eq(knowledgeDocuments.id, documentId))
    })
    let calls = 0
    const hash = createHashEmbedder()
    const deps = makeDeps({ embedder: { ...hash, embed: async (...args) => { calls++; return hash.embed(...args) } } })

    await run(deps, documentId)

    expect(calls).toBe(1)
    const source = await getSource(sourceId)
    expect(source.status).toBe('failed')
    expect(source.failureReason).toBe('cap_reached')
    // The first batch's vectors stand — the rows already written are never rolled back.
    expect(await unembeddedCount(documentId)).toBe(130 + CONTENTS.length - 128)
  })

  it('a source whose OTHER document still has unembedded chunks is not flipped yet', async () => {
    const { sourceId, documentId } = await seedDocument()
    const otherId = await withOrg(app.db, orgId, async (tx) => {
      const [doc] = await tx.insert(knowledgeDocuments).values({
        orgId, sourceId, uri: `paste:${sourceId}#2`, contentHash: 'g'.repeat(64), chunkCount: 1,
      }).returning({ id: knowledgeDocuments.id })
      await tx.insert(knowledgeChunks).values({ orgId, documentId: doc!.id, ordinal: 0, content: 'Gift cards never expire.', tokenCount: 6 })
      return doc!.id
    })

    await run(makeDeps(), documentId)

    expect(await unembeddedCount(documentId)).toBe(0)
    expect(await unembeddedCount(otherId)).toBe(1)
    expect((await getSource(sourceId)).status).toBe('processing')
  })

  it('is a clean no-op when every chunk already carries a vector and the source is already ready', async () => {
    const { sourceId, documentId } = await seedDocument()
    await run(makeDeps(), documentId)
    const before = (await chunksFor(documentId)).map((c) => c.embedding)

    await run(makeDeps(), documentId)

    expect((await chunksFor(documentId)).map((c) => c.embedding)).toEqual(before)
    expect((await getSource(sourceId)).status).toBe('ready')
    expect((await auditRows(sourceId)).filter((r) => r.action === 'knowledge.source.ready')).toHaveLength(1)
  })
})
