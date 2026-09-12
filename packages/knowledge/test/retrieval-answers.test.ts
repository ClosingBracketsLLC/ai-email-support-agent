/**
 * The answers leg of `createRetriever` (spec §Learning loop): ACTIVE `resolved_answers` only,
 * exact cosine within the org, gated at `MEMORY_RETRIEVE_MIN_COSINE`, capped at `answersTopK`.
 * Same throwaway-db + `createHashEmbedder()` harness as `retrieval.test.ts`. Each test mints its
 * own org (`createTestOrganization`) rather than sharing one across `it` blocks: the leg's SQL is a
 * nearest-N `LIMIT`, not a threshold, so a row left over from an earlier test could otherwise ride
 * back in as one of another test's "nearest" candidates.
 */
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MEMORY_RETRIEVE_MIN_COSINE } from '@aesa/core'
import { resolvedAnswers, withOrg } from '@aesa/db'
import { createDb } from '@aesa/db/raw'
import { createTestDatabase, createTestOrganization } from '@aesa/db/testing'
import { createHashEmbedder } from '../src/embed/hash.ts'
import { EmbedError } from '../src/embed/types.ts'
import { answerSearchSql, createRetriever } from '../src/index.ts'

const embedder = createHashEmbedder()
const cosine = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i]!, 0)
const signal = new AbortController().signal

let t: Awaited<ReturnType<typeof createTestDatabase>>
let handle: ReturnType<typeof createDb>

beforeAll(async () => {
  t = await createTestDatabase()
  handle = createDb(t.url, { role: 'app' })
})
afterAll(async () => {
  await handle.pool.end()
  await t.drop()
})

/** Embeds `questionText` and inserts one `resolved_answers` row carrying that vector, returning its id. */
async function seedAnswer(org: string, opts: { status: string; questionText: string; approvals: number; answerBody?: string }): Promise<string> {
  const [vec] = (await embedder.embed([opts.questionText], 'document')).vectors
  const [row] = await withOrg(handle.db, org, (tx) =>
    tx.insert(resolvedAnswers).values({
      orgId: org,
      questionText: opts.questionText,
      answerBody: opts.answerBody ?? `answer for ${opts.status}`,
      status: opts.status,
      approvals: opts.approvals,
      questionEmbedding: sql.raw(`'[${vec!.join(',')}]'::vector`) as never,
      embeddingModel: embedder.model,
      embeddingVersion: 1,
      expiresAt: new Date('2027-01-01'),
    }).returning({ id: resolvedAnswers.id }))
  return row!.id
}

describe("createRetriever: the answers leg", () => {
  it('returns ACTIVE answers only, org-scoped, with their approvals and a cosine score; candidate/needs_review/retired never appear', async () => {
    const orgId = await createTestOrganization(handle, 'Answers Org A')
    const otherOrgId = await createTestOrganization(handle, 'Answers Org A (foreign)')
    const q = 'Where is my order? It was due yesterday.'

    const activeId = await seedAnswer(orgId, { status: 'active', questionText: q, approvals: 2 })
    await seedAnswer(orgId, { status: 'candidate', questionText: q, approvals: 0 })
    await seedAnswer(orgId, { status: 'needs_review', questionText: q, approvals: 3 })
    await seedAnswer(orgId, { status: 'retired', questionText: q, approvals: 3 })
    await seedAnswer(otherOrgId, { status: 'active', questionText: q, approvals: 3 })

    const retriever = createRetriever({ db: handle.db, embedder })
    const result = await retriever.retrieveDetailed({ orgId, questions: [q], text: '', signal })

    expect(result.answers).toEqual([
      expect.objectContaining({ id: activeId, question: q, answer: 'answer for active', approvals: 2 }),
    ])
    expect(result.answers[0]!.score).toBeCloseTo(1, 4)
  })

  it('drops answers below MEMORY_RETRIEVE_MIN_COSINE and caps at answersTopK, best first', async () => {
    const orgId = await createTestOrganization(handle, 'Answers Org B')
    const q = 'Where is my order? It was due yesterday.'
    // Empirically spaced (hash-v1 bag-of-words cosine against `q`, see task-4-report.md): four
    // paraphrases score >= 0.70 (the cap the SQL LIMIT and the post-filter both have to enforce
    // together, since answersTopK=3 < 4 qualifiers here), two score below it, and one is unrelated.
    const above = [
      { text: q, body: 'exact' },
      { text: 'Where is my order? It was due yesterday, I am worried.', body: 'worried' },
      { text: 'Where is my order? It was due yesterday, please help.', body: 'please-help' },
      { text: 'Where is my order, it was due yesterday and still not here.', body: 'still-not-here' },
    ]
    const below = [
      { text: 'my order was due yesterday and has not arrived', body: 'below-1' },
      { text: 'order status update please', body: 'below-2' },
    ]
    const unrelated = { text: 'Do you ship internationally to Canada or Mexico?', body: 'unrelated' }

    const idByBody = new Map<string, string>()
    for (const c of [...above, ...below, unrelated]) {
      idByBody.set(c.body, await seedAnswer(orgId, { status: 'active', questionText: c.text, approvals: 1, answerBody: c.body }))
    }

    // The expectation, computed independently of the retriever with the SAME embedder: every
    // candidate's cosine against `q`, filtered at the shared threshold, sorted best first, capped.
    const { vectors: qv } = await embedder.embed([q], 'query')
    const allCandidates = [...above, ...below, unrelated]
    const { vectors: cv } = await embedder.embed(allCandidates.map((c) => c.text), 'document')
    const scored = allCandidates.map((c, i) => ({ body: c.body, score: cosine(qv[0]!, cv[i]!) }))
    const expectedOrder = scored
      .filter((c) => c.score >= MEMORY_RETRIEVE_MIN_COSINE)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
    expect(expectedOrder.length).toBe(3)   // the test is only proving the cap if > answersTopK qualify
    expect(expectedOrder.map((c) => c.body)).not.toContain(unrelated.body)
    for (const b of below) expect(expectedOrder.map((c) => c.body)).not.toContain(b.body)

    const retriever = createRetriever({ db: handle.db, embedder })
    const result = await retriever.retrieveDetailed({ orgId, questions: [q], text: '', signal })

    expect(result.answers.map((a) => a.id)).toEqual(expectedOrder.map((c) => idByBody.get(c.body)))
    for (const a of result.answers) expect(a.score).toBeGreaterThanOrEqual(MEMORY_RETRIEVE_MIN_COSINE)
    const scores = result.answers.map((a) => a.score)
    expect(scores).toEqual([...scores].sort((x, y) => y - x))   // best first
  })

  it('returns no answers when the embedder is down (lexical mode) — memory is vector-only by design', async () => {
    const orgId = await createTestOrganization(handle, 'Answers Org C')
    const q = 'Where is my order? It was due yesterday.'
    await seedAnswer(orgId, { status: 'active', questionText: q, approvals: 2 })

    const broken = createRetriever({
      db: handle.db,
      embedder: { model: 'hash-v1', version: 1, dimensions: 1024, embed: async () => { throw new EmbedError('transient', 'voyage down') } },
      logger: { warn: () => {} },
    })
    const result = await broken.retrieveDetailed({ orgId, questions: [q], text: '', signal })
    expect(result.mode).toBe('lexical')
    expect(result.answers).toEqual([])
  })

  it('EXPLAIN takes the org btree for the answers leg, never a vector index', async () => {
    const orgId = await createTestOrganization(handle, 'Answers Org D')
    const q = 'Where is my order? It was due yesterday.'
    const [vec] = (await embedder.embed([q], 'query')).vectors
    const plan = await withOrg(handle.db, orgId, (tx) => tx.execute(sql`EXPLAIN ${answerSearchSql(orgId, vec!, embedder.model, 3)}`))
    const text = plan.rows.map((r) => Object.values(r)[0]).join('\n')
    expect(text).not.toMatch(/hnsw|ivfflat/i)
  })
})
