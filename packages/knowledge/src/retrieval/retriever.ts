import { and, eq, inArray, sql } from 'drizzle-orm'
import { MEMORY_RETRIEVE_MIN_COSINE } from '@aesa/core'
import { knowledgeChunks, resolvedAnswers, withOrg, workspaces, type Db, type OrgTx } from '@aesa/db'
// type-only — erases at runtime; `@aesa/agent` is a devDependency on purpose (every consumer already depends on it)
import type { RetrievedAnswer, RetrievedChunk, Retriever } from '@aesa/agent'
import type { Embedder, Reranker } from '../embed/types.ts'
import { fuseRanked } from './fuse.ts'
import { rerankChunks } from './rerank.ts'
import { answerSearchSql, lexicalSearchSql, vectorSearchSql } from './sql.ts'

export interface RetrievalLimits {
  /** rows each leg returns for each query */
  perQuery: number
  /** chunks handed to the prompt */
  topK: number
  /** the combined `content` budget across the returned chunks */
  maxContentChars: number
  /** triage questions embedded for one ticket */
  maxQueries: number
  /** past resolved answers handed to the prompt, best cosine first (spec §Learning loop) */
  answersTopK: number
}

export const DEFAULT_RETRIEVAL_LIMITS: RetrievalLimits = { perQuery: 12, topK: 6, maxContentChars: 12_000, maxQueries: 6, answersTopK: 3 }

/** How many fused candidates the optional cross-encoder re-scores before `topK` survive. */
export const RERANK_CANDIDATES = 20

/** The first 1,000 characters of the inbound body stand in for the questions when triage produced none. */
const TEXT_QUERY_CHARS = 1_000

/**
 * Orgs already warned about an embedding-model mismatch, for the life of the process (seam review
 * D4). `KNOWLEDGE_EMBED_MODEL` must be identical on every `knowledge` and `agent` replica: the
 * vector leg filters `embedding_model = <this embedder's>`, so a replica configured with a
 * different model retrieves NOTHING from the vector leg while the source rows sit there fully
 * embedded, and the only symptom is quieter grounding. One warn per org per process is enough to
 * name it in the logs without turning a real empty corpus into a log flood.
 */
const modelMismatchWarned = new Set<string>()

export interface RetrievalResult {
  chunks: RetrievedChunk[]
  /** ACTIVE resolved answers only, org-scoped, cosine >= `MEMORY_RETRIEVE_MIN_COSINE`, best first,
   * capped at `answersTopK` (spec §Learning loop). Vector-only: the degraded/lexical path always
   * returns `[]` — memory is retrieved by cosine or not at all. */
  answers: RetrievedAnswer[]
  knowledgeVersion: number
  mode: 'hybrid' | 'lexical'
  degraded: boolean
}

export interface RetrieverDeps {
  db: Db
  embedder: Embedder
  reranker?: Reranker | null
  logger?: { warn(obj: object, msg: string): void }
  limits?: Partial<RetrievalLimits>
}

export interface RetrieveInput {
  orgId: string
  questions: string[]
  text: string
  signal: AbortSignal
}

export type DetailedRetriever = Retriever & { retrieveDetailed(input: RetrieveInput): Promise<RetrievalResult> }

/**
 * The tenancy backstop. Every leg already filters `org_id` in SQL and every read runs inside
 * `withOrg` (forced RLS), so this can only fire on a bug — which is exactly why it exists: a chunk
 * is about to be pasted into a model prompt, and a cross-tenant leak there is unrecoverable
 * (spec §Where tenancy is enforced). It throws rather than filtering: a set that contains a
 * foreign row is evidence the filter is broken, not a set to be cleaned up and used.
 */
export function assertSameOrg(orgId: string, rows: { orgId: string }[]): void {
  for (const row of rows) {
    if (row.orgId !== orgId) throw new Error('retrieval returned a row from another org')
  }
}

/** Trimmed, deduped, capped; falls back to the head of the inbound body when triage asked nothing. */
function buildQueries(input: RetrieveInput, maxQueries: number): string[] {
  const seen = new Set<string>()
  const queries: string[] = []
  for (const question of input.questions) {
    const trimmed = question.trim()
    if (trimmed === '' || seen.has(trimmed)) continue
    seen.add(trimmed)
    queries.push(trimmed)
    if (queries.length >= maxQueries) break
  }
  if (queries.length > 0) return queries
  const text = input.text.slice(0, TEXT_QUERY_CHARS).trim()
  return text === '' ? [] : [text]
}

const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0)

/** Drops the lowest-ranked chunks (the tail of the ordered list) until the combined content fits. */
function capContent(chunks: RetrievedChunk[], maxContentChars: number): RetrievedChunk[] {
  const kept: RetrievedChunk[] = []
  let used = 0
  for (const chunk of chunks) {
    if (used + chunk.content.length > maxContentChars) break
    kept.push(chunk)
    used += chunk.content.length
  }
  return kept
}

/**
 * Hybrid per-org retrieval: exact cosine over the org's own vectors plus a `tsvector` leg, fused by
 * reciprocal rank, re-read for content, tenancy-checked, and optionally reranked.
 *
 * Two rules shape the control flow and are not negotiable:
 *  1. **No network I/O inside a `withOrg` transaction** (the app role dies after 5 s idle in one).
 *     So: embed FIRST, then one short transaction for the legs, then one for the re-read, then the
 *     rerank — each network call strictly between transactions.
 *  2. **Every SQL predicate carries `org_id`**, and `assertSameOrg` re-checks the rows that come
 *     back before any of them can reach a prompt.
 *
 * An embedder failure degrades to the lexical leg alone (`mode: 'lexical'`, `degraded: true`, one
 * warn) rather than failing the caller: a Voyage outage must cost grounding quality, never drafts
 * (spec §Launch risks).
 */
export function createRetriever(deps: RetrieverDeps): DetailedRetriever {
  const limits = { ...DEFAULT_RETRIEVAL_LIMITS, ...deps.limits }

  /** `OrgTx`, not a structural `{ select }`: only `withOrg` mints one, so a read that escaped a
   * tenant transaction cannot typecheck. */
  async function readKnowledgeVersion(tx: OrgTx, orgId: string): Promise<number> {
    const [row] = await tx.select({ knowledgeVersion: workspaces.knowledgeVersion }).from(workspaces).where(eq(workspaces.orgId, orgId)).limit(1)
    return row?.knowledgeVersion ?? 0
  }

  async function retrieveDetailed(input: RetrieveInput): Promise<RetrievalResult> {
    const { orgId, signal } = input
    const queries = buildQueries(input, limits.maxQueries)

    if (queries.length === 0) {
      const knowledgeVersion = await withOrg(deps.db, orgId, (tx) => readKnowledgeVersion(tx, orgId))
      return { chunks: [], answers: [], knowledgeVersion, mode: 'hybrid', degraded: false }
    }

    // ── network, before any transaction opens ────────────────────────────────────────────────
    let vectors: number[][] | null = null
    let degraded = false
    try {
      const embedded = await deps.embedder.embed(queries, 'query', signal)
      // A provider that returns the wrong number of vectors is a provider fault, not a reason to
      // mis-pair a query with someone else's vector.
      vectors = embedded.vectors.length === queries.length ? embedded.vectors : null
      degraded = vectors === null
      if (degraded) deps.logger?.warn({ orgId, expected: queries.length, got: embedded.vectors.length }, 'knowledge retrieval degraded to lexical: the embedder returned the wrong number of vectors')
    } catch (err) {
      // The caller's watchdog firing is a cancellation, not an outage — let it through.
      if (signal.aborted) throw err
      // Deliberately wider than `EmbedError`: a real provider outage surfaces as fetch's own
      // TypeError or an AbortError from the adapter's request timeout, neither of which is an
      // EmbedError, and the spec's promise is that an outage degrades rather than fails a draft.
      degraded = true
      deps.logger?.warn({ orgId, err: err instanceof Error ? err.message : String(err), code: err instanceof Error ? err.name : 'unknown' }, 'knowledge retrieval degraded to lexical: the embedder failed')
    }
    const mode: RetrievalResult['mode'] = degraded ? 'lexical' : 'hybrid'

    // ── the two legs, one short transaction, no network I/O ──────────────────────────────────
    const lists: { id: string; score: number }[][] = []
    const vectorBest = new Map<string, number>()
    const lexicalBest = new Map<string, number>()
    /** The answers leg's own best cosine per resolved-answer id, across every query — never mixed
     * into `lists`/`fuseRanked`: chunks and past answers are two separate prompt sections, never
     * one fused ranking (spec §Learning loop). */
    const answerBest = new Map<string, number>()
    /** Set when the vector leg ran for a query and came back with nothing — the symptom a model
     * mismatch produces, checked for once (below) rather than diagnosed per query. */
    let vectorLegEmpty = false

    await withOrg(deps.db, orgId, async (tx) => {
      for (const [index, query] of queries.entries()) {
        signal.throwIfAborted()
        const vector = vectors?.[index]
        if (vector) {
          const { rows } = await tx.execute(vectorSearchSql(orgId, vector, deps.embedder.model, limits.perQuery))
          if (rows.length === 0) vectorLegEmpty = true
          const list = rows.map((row) => ({ id: String(row.id), score: clamp01(1 - Number(row.distance)) }))
          for (const entry of list) vectorBest.set(entry.id, Math.max(vectorBest.get(entry.id) ?? 0, entry.score))
          if (list.length > 0) lists.push(list)

          // The answers leg: same probe, its own table, its own (unfused) best-score map.
          const { rows: answerRows } = await tx.execute(answerSearchSql(orgId, vector, deps.embedder.model, limits.answersTopK))
          for (const row of answerRows) {
            const score = clamp01(1 - Number(row.distance))
            answerBest.set(String(row.id), Math.max(answerBest.get(String(row.id)) ?? 0, score))
          }
        }
        // `null` when the question is all stop words and short tokens: there is no tsquery to run.
        const lexical = lexicalSearchSql(orgId, query, limits.perQuery)
        if (!lexical) continue
        const { rows } = await tx.execute(lexical)
        // `ts_rank_cd` has no fixed range, so the leg's own best row normalizes it — and the 0.5
        // ceiling keeps a lexical-only hit below any vector hit, which is what lets one score
        // field carry both legs honestly.
        const topRank = Number(rows[0]?.rank ?? 0)
        const list = rows.map((row) => ({ id: String(row.id), score: topRank > 0 ? Math.min(0.5, (Number(row.rank) / topRank) * 0.5) : 0 }))
        for (const entry of list) lexicalBest.set(entry.id, Math.max(lexicalBest.get(entry.id) ?? 0, entry.score))
        if (list.length > 0) lists.push(list)
      }
    })

    const fused = fuseRanked(lists)
    const candidateCount = deps.reranker ? Math.max(RERANK_CANDIDATES, limits.topK) : limits.topK
    const ordered = [...fused.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))   // fused score, then id: a stable page
      .slice(0, candidateCount)
    const ids = ordered.map(([id]) => id)

    // ── the re-read (content + heading + org_id) and the version, one short transaction ───────
    // The mismatch probe rides along inside this SAME transaction (seam review D4) — no extra
    // round trip of its own, and only when the vector leg came back empty for a query and this
    // process has not already warned about this org.
    const probeForModelMismatch = vectorLegEmpty && !modelMismatchWarned.has(orgId)
    const answerIds = [...answerBest.keys()]
    const { rows, models, knowledgeVersion, answerRows } = await withOrg(deps.db, orgId, async (tx) => {
      const rows = ids.length === 0
        ? []
        : await tx
            .select({ id: knowledgeChunks.id, orgId: knowledgeChunks.orgId, headingPath: knowledgeChunks.headingPath, content: knowledgeChunks.content })
            .from(knowledgeChunks)
            // `injection_flagged` is re-applied here, not just on the legs that produced these ids:
            // this is the set that becomes prompt text, and a quarantined chunk must not reach a
            // model because one leg's filter was wrong or an owner flagged it mid-run. Same
            // defense-in-depth rationale as `assertSameOrg` below.
            .where(and(eq(knowledgeChunks.orgId, orgId), eq(knowledgeChunks.injectionFlagged, false), inArray(knowledgeChunks.id, ids)))
      const models = probeForModelMismatch
        ? (await tx.execute<{ embedding_model: string | null }>(
            sql`SELECT DISTINCT embedding_model FROM knowledge_chunks WHERE org_id = ${orgId}::uuid AND embedding IS NOT NULL`,
          )).rows.map((row) => row.embedding_model)
        : []
      // Re-read + re-guard, same rationale as the chunks re-read above: `status = 'active'` is
      // re-applied here, not just on the leg that produced these ids, so an answer demoted between
      // the leg and the re-read can never reach a prompt.
      const answerRows = answerIds.length === 0
        ? []
        : await tx
            .select({ id: resolvedAnswers.id, orgId: resolvedAnswers.orgId, questionText: resolvedAnswers.questionText, answerBody: resolvedAnswers.answerBody, approvals: resolvedAnswers.approvals })
            .from(resolvedAnswers)
            .where(and(eq(resolvedAnswers.orgId, orgId), eq(resolvedAnswers.status, 'active'), inArray(resolvedAnswers.id, answerIds)))
      return { rows, models, knowledgeVersion: await readKnowledgeVersion(tx, orgId), answerRows }
    })
    assertSameOrg(orgId, rows)
    assertSameOrg(orgId, answerRows)

    // A query's vector leg came back empty AND the org holds vectors under a model this replica
    // does not query with — the signature of a replica whose `KNOWLEDGE_EMBED_MODEL` differs from
    // the one that wrote the corpus. A workspace caught mid-re-embed can trip it once too, which
    // is harmless: it is a warn, once per org per process, not a behaviour change.
    const otherModels = models.filter((model) => model !== null && model !== deps.embedder.model)
    if (otherModels.length > 0 && !modelMismatchWarned.has(orgId)) {
      modelMismatchWarned.add(orgId)
      deps.logger?.warn(
        { orgId, queryModel: deps.embedder.model, storedModels: otherModels },
        'knowledge vector leg returned nothing and the org has chunks embedded under a different model: KNOWLEDGE_EMBED_MODEL differs across replicas',
      )
    }

    const byId = new Map(rows.map((row) => [row.id, row]))
    let chunks: RetrievedChunk[] = []
    for (const id of ids) {
      const row = byId.get(id)
      if (!row) continue   // deleted between the legs and the re-read; the caller sees one fewer chunk
      chunks.push({
        id,
        heading: row.headingPath.join(' › ') || null,
        // A vector cosine wins when the chunk had one: it is the comparable, absolute number, and
        // the lexical score is a per-query relative rank capped at 0.5.
        score: vectorBest.get(id) ?? lexicalBest.get(id) ?? 0,
        content: row.content,
      })
    }

    // Vector-only, gated at `MEMORY_RETRIEVE_MIN_COSINE`, best cosine first, capped at
    // `answersTopK` — the degraded/lexical path never reaches here (`answerBest` stays empty when
    // no query embedded), so a Voyage outage costs memory the same way it costs grounding: quality,
    // never a wrong or stale reuse (spec §Learning loop).
    const answers: RetrievedAnswer[] = answerRows
      .map((row) => ({ id: row.id, question: row.questionText, answer: row.answerBody, score: answerBest.get(row.id) ?? 0, approvals: row.approvals }))
      .filter((answer) => answer.score >= MEMORY_RETRIEVE_MIN_COSINE)
      .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1))
      .slice(0, limits.answersTopK)

    // ── the optional rerank: network again, and again outside every transaction ──────────────
    if (deps.reranker && chunks.length > 0) {
      try {
        chunks = await rerankChunks(deps.reranker, queries[0]!, chunks, limits.topK, signal)
      } catch (err) {
        if (signal.aborted) throw err
        deps.logger?.warn({ orgId, err: err instanceof Error ? err.message : String(err) }, 'knowledge rerank failed; keeping the fused order')
        chunks = chunks.slice(0, limits.topK)
      }
    } else {
      chunks = chunks.slice(0, limits.topK)
    }

    return { chunks: capContent(chunks, limits.maxContentChars), answers, knowledgeVersion, mode, degraded }
  }

  return {
    retrieveDetailed,
    async retrieve(input) {
      const { chunks, answers } = await retrieveDetailed(input)
      return { chunks, answers }
    },
  }
}
