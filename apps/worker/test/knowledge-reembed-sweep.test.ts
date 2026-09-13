/**
 * `runKnowledgeReembedSweep` against real Postgres with the deterministic hash embedder — no pg-boss
 * (the `enqueueEmbedBatch` seam is a spy), no S3, no Voyage. One `it` per behavior in the task
 * brief's `knowledge.reembed-sweep` bullet.
 */
import { randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type PgBoss from 'pg-boss'
import pino from 'pino'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  knowledgeChunks, knowledgeDocuments, knowledgeSources, orgSettings, resolvedAnswers, usageCounters,
  user, withOrg, workspaces,
} from '@aesa/db'
import { createDb } from '@aesa/db/raw'
import { createTestDatabase, createTestOrganization } from '@aesa/db/testing'
import { createHashEmbedder, createMemoryStore, type Embedder } from '@aesa/knowledge'
import { runKnowledgeEmbedBatch } from '../src/jobs/knowledge-embed-batch.ts'
import {
  REEMBED_ANSWERS_PER_RUN, REEMBED_DOCS_PER_RUN, runKnowledgeReembedSweep,
} from '../src/jobs/knowledge-reembed-sweep.ts'
import type { KnowledgeDeps } from '../src/knowledge-deps.ts'

const rand = () => randomBytes(4).toString('hex')
const NOW = new Date('2026-09-11T12:00:00Z')
const TODAY = '2026-09-11'
/** This job never sends through pg-boss directly (`deps.enqueueEmbedBatch` is the seam) — a stub is enough. */
const fakeBoss = {} as PgBoss

let t: Awaited<ReturnType<typeof createTestDatabase>>
let app: ReturnType<typeof createDb>
let userId: string
let orgId: string

beforeAll(async () => {
  t = await createTestDatabase()
  app = createDb(t.url)
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

/** hash-v2: the "new" configured model throughout this file; fixtures write chunks/answers as hash-v1. */
const hashV2: Embedder = { ...createHashEmbedder(), model: 'hash-v2' }

async function seedDocumentWithChunks(
  targetOrgId: string, chunkCount: number, embeddingModel: string | null,
): Promise<{ sourceId: string; documentId: string }> {
  return withOrg(app.db, targetOrgId, async (tx) => {
    const [source] = await tx.insert(knowledgeSources).values({
      orgId: targetOrgId, kind: 'paste', status: 'ready', title: 'Doc', pastedText: 'x', createdBy: userId,
      documentCount: 1, chunkCount,
    }).returning({ id: knowledgeSources.id })
    const [doc] = await tx.insert(knowledgeDocuments).values({
      orgId: targetOrgId, sourceId: source!.id, uri: `paste:${source!.id}`, title: 'Doc', contentHash: 'h'.repeat(64),
      chunkCount, embeddedCount: embeddingModel ? chunkCount : 0,
    }).returning({ id: knowledgeDocuments.id })
    const hasher = createHashEmbedder()
    for (let i = 0; i < chunkCount; i += 1) {
      const content = `Chunk ${i} of ${source!.id}`
      const embedding = embeddingModel ? (await hasher.embed([content], 'document')).vectors[0] : null
      await tx.insert(knowledgeChunks).values({
        orgId: targetOrgId, documentId: doc!.id, ordinal: i, content, tokenCount: 4,
        embedding: embedding ? (embedding as unknown as never) : null,
        embeddingModel, embeddingVersion: embeddingModel ? 1 : null,
      })
    }
    return { sourceId: source!.id, documentId: doc!.id }
  })
}

async function seedAnswer(targetOrgId: string, over: Partial<typeof resolvedAnswers.$inferInsert> = {}): Promise<string> {
  const hasher = createHashEmbedder()
  const question = over.questionText ?? `where is my order ${rand()}`
  const vector = (await hasher.embed([question], 'document')).vectors[0]!
  const [row] = await withOrg(app.db, targetOrgId, (tx) =>
    tx.insert(resolvedAnswers).values({
      orgId: targetOrgId, questionText: question, answerBody: 'It ships within two business days.',
      questionEmbedding: vector as unknown as never, embeddingModel: 'hash-v1', embeddingVersion: 1,
      status: 'active', approvals: 1, expiresAt: new Date(NOW.getTime() + 300 * 86_400_000),
      ...over,
    }).returning({ id: resolvedAnswers.id }))
  return row!.id
}

const getDocument = async (targetOrgId: string, documentId: string) =>
  (await withOrg(app.db, targetOrgId, (tx) => tx.select().from(knowledgeDocuments).where(eq(knowledgeDocuments.id, documentId))))[0]!
const chunksFor = async (targetOrgId: string, documentId: string) =>
  withOrg(app.db, targetOrgId, (tx) => tx.select().from(knowledgeChunks).where(eq(knowledgeChunks.documentId, documentId)).orderBy(knowledgeChunks.ordinal))
const getSource = async (targetOrgId: string, sourceId: string) =>
  (await withOrg(app.db, targetOrgId, (tx) => tx.select().from(knowledgeSources).where(eq(knowledgeSources.id, sourceId))))[0]!
const getAnswer = async (targetOrgId: string, id: string) =>
  (await withOrg(app.db, targetOrgId, (tx) => tx.select().from(resolvedAnswers).where(eq(resolvedAnswers.id, id))))[0]!
const knowledgeVersionOf = async (targetOrgId: string) =>
  (await withOrg(app.db, targetOrgId, (tx) => tx.select({ v: workspaces.knowledgeVersion }).from(workspaces).where(eq(workspaces.orgId, targetOrgId))))[0]!.v
const meter = async (targetOrgId: string, name: string) =>
  (await withOrg(app.db, targetOrgId, (tx) => tx.select().from(usageCounters).where(eq(usageCounters.meter, name))))[0]?.value ?? 0

async function setOrgSetting(targetOrgId: string, key: string, value: unknown): Promise<void> {
  await withOrg(app.db, targetOrgId, (tx) =>
    tx.insert(orgSettings).values({ orgId: targetOrgId, key, value })
      .onConflictDoUpdate({ target: [orgSettings.orgId, orgSettings.key], set: { value } }))
}
async function setEmbedTokens(targetOrgId: string, value: number): Promise<void> {
  await withOrg(app.db, targetOrgId, (tx) =>
    tx.insert(usageCounters).values({ orgId: targetOrgId, day: TODAY, meter: 'embed_tokens', value })
      .onConflictDoUpdate({ target: [usageCounters.orgId, usageCounters.day, usageCounters.meter], set: { value } }))
}

function makeDeps(over: Partial<KnowledgeDeps> = {}): KnowledgeDeps {
  return {
    db: app.db, store: createMemoryStore(), embedder: hashV2, logger: pino({ level: 'silent' }),
    enqueueEmbedBatch: async () => 'job-1', now: () => NOW, ...over,
  }
}

describe('knowledge.reembed-sweep', () => {
  it('constants match the brief', () => {
    expect(REEMBED_DOCS_PER_RUN).toBe(20)
    expect(REEMBED_ANSWERS_PER_RUN).toBe(128)
  })

  it('nulls a v1 document\'s chunks, resets embedded_count, enqueues embed-batch, leaves a v2 document untouched, and never bumps knowledge_version', async () => {
    const before = await knowledgeVersionOf(orgId)
    const docs = await Promise.all([
      seedDocumentWithChunks(orgId, 2, 'hash-v1'),
      seedDocumentWithChunks(orgId, 2, 'hash-v1'),
      seedDocumentWithChunks(orgId, 2, 'hash-v1'),
    ])
    const v2Doc = await seedDocumentWithChunks(orgId, 2, 'hash-v2')

    const enqueued: { orgId: string; documentId: string }[] = []
    const deps = makeDeps({ enqueueEmbedBatch: async (o, d) => { enqueued.push({ orgId: o, documentId: d }); return 'job-1' } })

    const result = await runKnowledgeReembedSweep(fakeBoss, deps)

    expect(result.documentsQueued).toBe(3)
    for (const { documentId } of docs) {
      const chunks = await chunksFor(orgId, documentId)
      for (const c of chunks) {
        expect(c.embedding).toBeNull()
        expect(c.embeddingModel).toBeNull()
        expect(c.embeddingVersion).toBeNull()
      }
      const doc = await getDocument(orgId, documentId)
      expect(doc.embeddedCount).toBe(0)
      expect(enqueued.some((e) => e.documentId === documentId)).toBe(true)
    }

    const v2Chunks = await chunksFor(orgId, v2Doc.documentId)
    for (const c of v2Chunks) expect(c.embeddingModel).toBe('hash-v2')
    expect(enqueued.some((e) => e.documentId === v2Doc.documentId)).toBe(false)

    // The retrievable set (CLAUDE.md "Knowledge bounds") is unchanged: nulling a vector only
    // degrades that leg's scoring, it never removes a chunk from the lexical leg.
    expect(await knowledgeVersionOf(orgId)).toBe(before)
  })

  it('after runKnowledgeEmbedBatch runs on a re-queued document, its chunks read the new model', async () => {
    const { sourceId, documentId } = await seedDocumentWithChunks(orgId, 2, 'hash-v1')
    await runKnowledgeReembedSweep(fakeBoss, makeDeps())

    await runKnowledgeEmbedBatch(makeDeps(), { orgId, documentId }, new AbortController().signal)

    const chunks = await chunksFor(orgId, documentId)
    for (const c of chunks) {
      expect(c.embedding).not.toBeNull()
      expect(c.embeddingModel).toBe('hash-v2')
    }
    const doc = await getDocument(orgId, documentId)
    expect(doc.embeddedCount).toBe(2)
    // knowledge.embed-batch itself flips an ingest/paste source to `ready` once every chunk is filled.
    expect((await getSource(orgId, sourceId)).status).toBe('ready')
  })

  it('re-embeds a v1 answer pair in place (question_embedding, embedding_model) and meters embed_tokens; a v2 answer is untouched', async () => {
    const v1a = await seedAnswer(orgId)
    const v1b = await seedAnswer(orgId)
    const v2 = await seedAnswer(orgId, { embeddingModel: 'hash-v2' })
    const before = { a: await getAnswer(orgId, v1a), b: await getAnswer(orgId, v1b) }

    const result = await runKnowledgeReembedSweep(fakeBoss, makeDeps())

    expect(result.answersReembedded).toBe(2)
    const afterA = await getAnswer(orgId, v1a)
    const afterB = await getAnswer(orgId, v1b)
    expect(afterA.embeddingModel).toBe('hash-v2')
    expect(afterB.embeddingModel).toBe('hash-v2')
    // The hash embedder's output is a pure function of the TEXT, not the model label, so the
    // vector value itself is unchanged — it is `embedding_model` that flips, which is the whole
    // point (the vector leg's WHERE filters on it). Both stay present and full-width.
    expect(afterA.questionEmbedding).toEqual(before.a.questionEmbedding)
    expect(afterA.questionEmbedding).toHaveLength(1024)
    expect(afterB.questionEmbedding).toHaveLength(1024)
    expect(await meter(orgId, 'embed_tokens')).toBeGreaterThan(0)

    const untouched = await getAnswer(orgId, v2)
    expect(untouched.embeddingModel).toBe('hash-v2')
  })

  it('at the embed-tokens cap, the answers arm is skipped and nothing is written', async () => {
    await setOrgSetting(orgId, 'knowledge.daily_embed_tokens_cap', 1000)
    await setEmbedTokens(orgId, 1000)
    const v1 = await seedAnswer(orgId)
    const before = await getAnswer(orgId, v1)

    const result = await runKnowledgeReembedSweep(fakeBoss, makeDeps())

    expect(result.skippedCap).toBe(1)
    expect(result.answersReembedded).toBe(0)
    const after = await getAnswer(orgId, v1)
    expect(after.embeddingModel).toBe(before.embeddingModel)
    expect(after.questionEmbedding).toEqual(before.questionEmbedding)
    expect(await meter(orgId, 'embed_tokens')).toBe(1000)
  })

  it('REEMBED_DOCS_PER_RUN bounds one run: the remainder is picked up on the next run', async () => {
    const many = await Promise.all(
      Array.from({ length: REEMBED_DOCS_PER_RUN + 1 }, () => seedDocumentWithChunks(orgId, 1, 'hash-v1')),
    )

    const first = await runKnowledgeReembedSweep(fakeBoss, makeDeps())
    expect(first.documentsQueued).toBe(REEMBED_DOCS_PER_RUN)

    const remainingStale = (await Promise.all(many.map((d) => chunksFor(orgId, d.documentId))))
      .filter((chunks) => chunks.some((c) => c.embeddingModel === 'hash-v1')).length
    expect(remainingStale).toBe(1)

    const second = await runKnowledgeReembedSweep(fakeBoss, makeDeps())
    expect(second.documentsQueued).toBe(1)
  })

  it('a second, untouched org is left completely alone', async () => {
    const orgB = await createTestOrganization(app)
    await withOrg(app.db, orgB, (tx) => tx.insert(workspaces).values({ orgId: orgB, businessName: 'Other Org', timezone: 'UTC' }))
    const { documentId: staleDoc } = await seedDocumentWithChunks(orgId, 2, 'hash-v1')
    const { documentId: quietDoc } = await seedDocumentWithChunks(orgB, 2, 'hash-v2')

    await runKnowledgeReembedSweep(fakeBoss, makeDeps())

    const staleChunks = await chunksFor(orgId, staleDoc)
    expect(staleChunks.every((c) => c.embedding === null)).toBe(true)
    const quietChunks = await chunksFor(orgB, quietDoc)
    expect(quietChunks.every((c) => c.embeddingModel === 'hash-v2')).toBe(true)
  })
})
