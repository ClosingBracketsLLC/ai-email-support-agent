import { sql, type SQL } from 'drizzle-orm'
import { relaxedTsQuery } from './lexical-query.ts'

/**
 * The two retrieval legs, as drizzle fragments so the EXPLAIN test can plan the very SQL the
 * retriever runs rather than a copy of it.
 *
 * Both carry `org_id = <caller>` in their WHERE — the tenancy boundary is the SQL predicate, and
 * `assertSameOrg` in `retriever.ts` is the second, belt-and-braces check (spec §Tenancy).
 *
 * Everything that is not a number is a BOUND PARAMETER. The one interpolation is the pgvector
 * literal, and `vectorLiteral` proves every element is a finite number before building it.
 */

/**
 * A pgvector literal built ONLY from numbers. This is the single place in retrieval where a value
 * is interpolated into SQL text instead of bound, so it refuses anything that is not a finite
 * number rather than trusting its caller.
 */
export function vectorLiteral(vector: number[]): SQL {
  for (const value of vector) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new TypeError('vectorLiteral: every element of an embedding must be a finite number')
    }
  }
  return sql.raw(`'[${vector.join(',')}]'::vector`)
}

/**
 * Exact cosine over the org's own rows — NO global vector index (spec §Data model: no HNSW; the
 * `(org_id, document_id)` btree is the access path, asserted by the EXPLAIN test). `embedding_model`
 * keeps a workspace that was embedded by a different model out of the scores until Phase 6's
 * re-embed job runs.
 *
 * `id` is a deterministic tiebreak: on a corpus where most rows share a query's distance (an exact
 * scan returns `limit` rows whatever the distances are), the page would otherwise be at the
 * planner's mercy and two identical calls could disagree.
 */
export function vectorSearchSql(orgId: string, vector: number[], model: string, limit: number): SQL {
  const probe = vectorLiteral(vector)
  return sql`
    SELECT id, org_id, (embedding <=> ${probe}) AS distance
    FROM knowledge_chunks
    WHERE org_id = ${orgId}::uuid
      AND injection_flagged = false
      AND embedding IS NOT NULL
      AND embedding_model = ${model}
    ORDER BY embedding <=> ${probe}, id
    LIMIT ${limit}`
}

/**
 * The full-text leg, over the generated `tsv` (GIN). It deliberately does NOT filter
 * `embedding_model` or `embedding IS NOT NULL`: a lexical hit needs no vector, which is what keeps
 * retrieval useful while an embedding provider is down or a workspace is mid-re-embed.
 *
 * The query side is `relaxedTsQuery` — the question's content words, OR-ed, each a prefix match —
 * bound as one parameter into `to_tsquery('simple', $q)`. See `lexical-query.ts` for why
 * `websearch_to_tsquery` cannot be used here. `null` means the question had no content word left
 * and the caller skips the leg.
 *
 * `id` is a deterministic tiebreak, for the same reason as the vector leg.
 */
export function lexicalSearchSql(orgId: string, question: string, limit: number): SQL | null {
  const relaxed = relaxedTsQuery(question)
  if (relaxed === null) return null
  const tsquery = sql`to_tsquery('simple', ${relaxed})`
  return sql`
    SELECT id, org_id, ts_rank_cd(tsv, ${tsquery}) AS rank
    FROM knowledge_chunks
    WHERE org_id = ${orgId}::uuid
      AND injection_flagged = false
      AND tsv @@ ${tsquery}
    ORDER BY ts_rank_cd(tsv, ${tsquery}) DESC, id
    LIMIT ${limit}`
}
