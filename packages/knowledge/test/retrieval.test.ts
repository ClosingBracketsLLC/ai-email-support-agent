/**
 * `createRetriever` against Postgres with 100 synthetic orgs loaded with the SAME 50 chunks each
 * (20 golden pairs + 30 decoys) — the shape that makes "never another org's chunk" a real claim
 * rather than a coincidence of empty neighbours.
 *
 * Every org's chunk set is identical on purpose: if the SQL leaked across `org_id`, the fused list
 * would still look plausible, so the isolation case checks the returned ids against an RLS-scoped
 * read of the caller's own rows rather than against the headings.
 *
 * The embedder is the deterministic `hash-v1` one (lexical overlap drives cosine), so the golden
 * set exercises the plumbing — per-org filtering, fusion, the re-read, the EXPLAIN path — not
 * Voyage's quality.
 */
import { and, eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { knowledgeChunks, knowledgeDocuments, knowledgeSources, withOrg, workspaces } from '@aesa/db'
import { createDb } from '@aesa/db/raw'
import { createTestDatabase, createTestOrganization } from '@aesa/db/testing'
import { createHashEmbedder } from '../src/embed/hash.ts'
import { EmbedError, type Reranker } from '../src/embed/types.ts'
import { assertSameOrg, createRetriever, fuseRanked, vectorSearchSql } from '../src/index.ts'
import { DECOYS, GOLDEN } from './golden-set.ts'

const ORG_COUNT = 100
const CHUNKS = [...GOLDEN.map((g) => ({ heading: g.heading, content: g.content })), ...DECOYS]   // 50 per org

let t: Awaited<ReturnType<typeof createTestDatabase>>
let handle: ReturnType<typeof createDb>
let owner: ReturnType<typeof createDb>
let orgs: string[]
let retriever: ReturnType<typeof createRetriever>

const embedder = createHashEmbedder()
const signal = new AbortController().signal
const headings = (r: { chunks: { heading: string | null }[] }) => r.chunks.map((c) => c.heading)

beforeAll(async () => {
  t = await createTestDatabase()
  handle = createDb(t.url, { role: 'app' })
  owner = createDb(t.url, { role: 'owner' })   // ANALYZE needs the table owner; aesa_app is not it

  // One embed call for the 50 contents — every org stores the identical vectors, so the literals
  // are built once and reused across the 100 inserts (5,000 rows) instead of re-embedded per org.
  const { vectors } = await embedder.embed(CHUNKS.map((c) => c.content), 'document')
  const literals = vectors.map((v) => `'[${v.join(',')}]'::vector`)

  orgs = []
  for (let i = 0; i < ORG_COUNT; i++) {
    const orgId = await createTestOrganization(handle, `Org ${i}`)
    orgs.push(orgId)
    await withOrg(handle.db, orgId, async (tx) => {
      await tx.insert(workspaces).values({ orgId, businessName: `Org ${i}`, timezone: 'UTC' })
      const [src] = await tx.insert(knowledgeSources).values({ orgId, kind: 'paste', title: 'FAQ', pastedText: 'x' }).returning({ id: knowledgeSources.id })
      const [doc] = await tx.insert(knowledgeDocuments).values({ orgId, sourceId: src!.id, uri: `paste:${src!.id}`, contentHash: 'h' }).returning({ id: knowledgeDocuments.id })
      await tx.insert(knowledgeChunks).values(CHUNKS.map((c, ordinal) => ({
        orgId,
        documentId: doc!.id,
        ordinal,
        headingPath: [c.heading],
        content: c.content,
        tokenCount: Math.ceil(c.content.length / 4),
        embedding: sql.raw(literals[ordinal]!) as never,
        embeddingModel: embedder.model,
        embeddingVersion: embedder.version,
      })))
    })
  }
  await owner.pool.query('ANALYZE knowledge_chunks')

  retriever = createRetriever({ db: handle.db, embedder, logger: { warn: () => {} } })
})

afterAll(async () => {
  await handle.pool.end()
  await owner.pool.end()
  await t.drop()
})

describe('createRetriever', () => {
  it('golden set: every question retrieves its own chunk in the top 6, for the right org, in hybrid mode', async () => {
    let hits = 0
    const misses: string[] = []
    for (const g of GOLDEN) {
      const r = await retriever.retrieveDetailed({ orgId: orgs[7]!, questions: [g.question], text: '', signal: new AbortController().signal })
      expect(r.mode).toBe('hybrid')
      expect(r.chunks.length).toBeLessThanOrEqual(6)
      if (r.chunks.some((c) => c.heading === g.heading)) hits++
      else misses.push(`${g.question} → ${headings(r).join(' | ')}`)
    }
    expect(hits / GOLDEN.length, `golden hit rate ${hits}/${GOLDEN.length}; misses: ${misses.join(' ;; ')}`).toBeGreaterThanOrEqual(0.9)
  })

  it("never returns another org's chunk (100 orgs loaded)", async () => {
    const r = await retriever.retrieveDetailed({ orgId: orgs[3]!, questions: ['returns'], text: '', signal })
    expect(r.chunks.length).toBeGreaterThan(0)
    const ids = new Set(r.chunks.map((c) => c.id))
    const rows = await withOrg(handle.db, orgs[3]!, (tx) => tx.select({ id: knowledgeChunks.id }).from(knowledgeChunks))   // RLS-scoped read
    expect(rows.length).toBe(CHUNKS.length)
    for (const id of ids) expect(rows.some((x) => x.id === id)).toBe(true)
  })

  it('EXPLAIN takes the org btree, never a sequential scan over the table (spec: no global HNSW)', async () => {
    const { vectors } = await embedder.embed(['how long do I have to return an item'], 'query')
    const plan = await withOrg(handle.db, orgs[0]!, async (tx) =>
      (await tx.execute(sql`EXPLAIN ${vectorSearchSql(orgs[0]!, vectors[0]!, embedder.model, 12)}`)).rows.map((r) => String(Object.values(r)[0])).join('\n'))
    expect(plan).toMatch(/Index Scan using knowledge_chunks_org_document_idx|Bitmap Index Scan on knowledge_chunks_org_document_idx/)
    expect(plan).not.toMatch(/Seq Scan on knowledge_chunks/)
  })

  it('falls back to lexical-only when the embedder throws, and says so', async () => {
    const warns: string[] = []
    const broken = createRetriever({
      db: handle.db,
      embedder: { model: 'hash-v1', version: 1, dimensions: 1024, embed: async () => { throw new EmbedError('transient', 'voyage down') } },
      logger: { warn: (_obj, msg) => { warns.push(msg) } },
    })
    const r = await broken.retrieveDetailed({ orgId: orgs[1]!, questions: ['gift cards expire'], text: '', signal })
    expect(r).toMatchObject({ mode: 'lexical', degraded: true })
    expect(r.chunks.some((c) => c.heading === 'Gift cards')).toBe(true)
    expect(r.chunks.every((c) => c.score <= 0.5)).toBe(true)
    expect(warns).toHaveLength(1)
  })

  it('excludes injection-flagged chunks', async () => {
    const orgId = orgs[41]!
    const question = 'Do gift cards expire?'
    const before = await retriever.retrieveDetailed({ orgId, questions: [question], text: '', signal })
    expect(headings(before)).toContain('Gift cards')   // control: it is retrievable while unflagged

    await withOrg(handle.db, orgId, (tx) => tx.update(knowledgeChunks)
      .set({ injectionFlagged: true, injectionReason: 'instruction_pattern' })
      .where(and(eq(knowledgeChunks.orgId, orgId), eq(knowledgeChunks.ordinal, 6))))   // ordinal 6 == GOLDEN 'Gift cards'

    const after = await retriever.retrieveDetailed({ orgId, questions: [question], text: '', signal })
    expect(headings(after)).not.toContain('Gift cards')
    expect(after.chunks.length).toBeGreaterThan(0)

    // ...and the flag is per org: the identical chunk in a neighbour org is untouched.
    const neighbour = await retriever.retrieveDetailed({ orgId: orgs[40]!, questions: [question], text: '', signal })
    expect(headings(neighbour)).toContain('Gift cards')
  })

  it('excludes chunks written by another embedding model', async () => {
    const orgId = orgs[42]!
    // A natural-language question: `websearch_to_tsquery('simple', …)` ANDs every token (the simple
    // config strips no stop words), so the lexical leg matches nothing here and the case isolates
    // the vector leg — which is the only leg that filters on `embedding_model` (a lexical hit needs
    // no embedding at all).
    const question = 'Do gift cards expire?'
    const before = await retriever.retrieveDetailed({ orgId, questions: [question], text: '', signal })
    expect(headings(before)).toContain('Gift cards')

    await withOrg(handle.db, orgId, (tx) => tx.update(knowledgeChunks)
      .set({ embeddingModel: 'other-v9' })
      .where(and(eq(knowledgeChunks.orgId, orgId), eq(knowledgeChunks.ordinal, 6))))

    const after = await retriever.retrieveDetailed({ orgId, questions: [question], text: '', signal })
    expect(after.mode).toBe('hybrid')
    expect(headings(after)).not.toContain('Gift cards')
  })

  it('uses the inbound text when there are no questions', async () => {
    const r = await retriever.retrieveDetailed({ orgId: orgs[8]!, questions: [], text: 'How long do I have to return an item?', signal })
    expect(r.mode).toBe('hybrid')
    expect(headings(r)).toContain('Returns')
  })

  it('reports the workspace knowledgeVersion', async () => {
    const orgId = orgs[43]!
    await withOrg(handle.db, orgId, (tx) => tx.update(workspaces).set({ knowledgeVersion: 7 }).where(eq(workspaces.orgId, orgId)))
    const r = await retriever.retrieveDetailed({ orgId, questions: ['returns'], text: '', signal })
    expect(r.knowledgeVersion).toBe(7)
    const empty = await retriever.retrieveDetailed({ orgId, questions: [], text: '   ', signal })
    expect(empty).toMatchObject({ chunks: [], answers: [], knowledgeVersion: 7, mode: 'hybrid', degraded: false })
  })

  it('assertSameOrg throws on a foreign row', () => {
    expect(() => assertSameOrg('a', [{ orgId: 'a' }, { orgId: 'b' }])).toThrow(/another org/)
  })

  it('rerank: with a reranker the top-20 fused set is reranked by the first query and topK kept', async () => {
    const orgId = orgs[9]!
    const questions = ['returns', 'shipping', 'payment']
    const seen: { query: string; count: number; topK: number }[] = []
    // Reverses the candidate order: the reranked head must be the fused TAIL, which no ordering the
    // retriever produces on its own could yield — proof the reranker was consulted and obeyed.
    const reversing: Reranker = {
      rerank: async (q, docs, topK) => {
        seen.push({ query: q, count: docs.length, topK })
        return docs.map((_, i) => ({ index: docs.length - 1 - i, score: 1 - i / docs.length })).slice(0, topK)
      },
    }

    const fusedTop20 = await createRetriever({ db: handle.db, embedder, limits: { topK: 20 } })
      .retrieveDetailed({ orgId, questions, text: '', signal })
    const reranked = await createRetriever({ db: handle.db, embedder, reranker: reversing })
      .retrieveDetailed({ orgId, questions, text: '', signal })

    const n = fusedTop20.chunks.length
    expect(n).toBeGreaterThanOrEqual(6)
    expect(seen).toEqual([{ query: 'returns', count: n, topK: 6 }])
    expect(reranked.chunks.map((c) => c.id)).toEqual([...fusedTop20.chunks].reverse().slice(0, 6).map((c) => c.id))
    expect(reranked.chunks.map((c) => c.score)).toEqual(Array.from({ length: 6 }, (_, i) => 1 - i / n))
  })

  it('rerank: a reranker failure keeps the fused order instead of failing retrieval', async () => {
    const orgId = orgs[9]!
    const questions = ['returns', 'shipping', 'payment']
    const warns: string[] = []
    const broken: Reranker = { rerank: async () => { throw new Error('rerank-2.5 down') } }
    const fused = await retriever.retrieveDetailed({ orgId, questions, text: '', signal })
    const r = await createRetriever({ db: handle.db, embedder, reranker: broken, logger: { warn: (_o, m) => { warns.push(m) } } })
      .retrieveDetailed({ orgId, questions, text: '', signal })
    expect(r.chunks.map((c) => c.id)).toEqual(fused.chunks.map((c) => c.id))
    expect(warns).toHaveLength(1)
  })

  it('scores a vector hit above the lexical ceiling and caps the total content', async () => {
    const r = await retriever.retrieveDetailed({ orgId: orgs[5]!, questions: ['Do gift cards expire?'], text: '', signal })
    const gift = r.chunks.find((c) => c.heading === 'Gift cards')!
    expect(gift.score).toBeGreaterThan(0.5)     // a vector cosine, not the lexical ceiling
    expect(gift.score).toBeLessThanOrEqual(1)

    const capped = await createRetriever({ db: handle.db, embedder, limits: { maxContentChars: 200 } })
      .retrieveDetailed({ orgId: orgs[5]!, questions: ['Do gift cards expire?'], text: '', signal })
    expect(capped.chunks.length).toBeLessThan(r.chunks.length)
    expect(capped.chunks.reduce((n, c) => n + c.content.length, 0)).toBeLessThanOrEqual(200)
    expect(capped.chunks[0]!.id).toBe(r.chunks[0]!.id)   // the cap drops the lowest-fused first
  })

  it('retrieve() is retrieveDetailed() minus the extras', async () => {
    const plain = await retriever.retrieve({ orgId: orgs[6]!, questions: ['returns'], text: '', signal })
    const detailed = await retriever.retrieveDetailed({ orgId: orgs[6]!, questions: ['returns'], text: '', signal })
    expect(Object.keys(plain).sort()).toEqual(['answers', 'chunks'])
    expect(plain.answers).toEqual([])
    expect(plain.chunks.map((c) => c.id)).toEqual(detailed.chunks.map((c) => c.id))
  })

  it('the vector leg refuses a literal that is not all numbers', async () => {
    expect(() => vectorSearchSql(orgs[0]!, [1, Number.NaN], 'hash-v1', 12)).toThrow(/finite number/)
    expect(() => vectorSearchSql(orgs[0]!, ["0'); DROP TABLE knowledge_chunks; --" as unknown as number], 'hash-v1', 12)).toThrow(/finite number/)
  })
})

describe('fuseRanked', () => {
  it('sums reciprocal ranks across every list (k = 60) and ignores the scores', () => {
    const fused = fuseRanked([[{ id: 'a', score: 0.1 }, { id: 'b', score: 0.9 }], [{ id: 'b', score: 0.2 }]])
    expect(fused.get('a')).toBeCloseTo(1 / 61, 12)
    expect(fused.get('b')).toBeCloseTo(1 / 62 + 1 / 61, 12)
  })
})

describe('assertSameOrg', () => {
  it('passes a set that is all the caller org', () => {
    expect(() => assertSameOrg('a', [{ orgId: 'a' }, { orgId: 'a' }])).not.toThrow()
  })
})
