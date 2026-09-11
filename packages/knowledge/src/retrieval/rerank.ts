// type-only — erases at runtime; `@aesa/agent` is a devDependency on purpose (every consumer already depends on it)
import type { RetrievedChunk } from '@aesa/agent'
import type { Reranker } from '../embed/types.ts'

/**
 * The optional cross-encoder pass (Voyage `rerank-2.5`, behind `KNOWLEDGE_RERANK`). It re-scores
 * the fused candidates against ONE query — the first, the ticket's primary question — and replaces
 * each surviving chunk's score with the reranker's `relevance_score`, which is on its own scale and
 * is never mixed with a cosine.
 *
 * This is network I/O: it runs after every `withOrg` transaction has closed, never inside one.
 *
 * A reranker that fails must not fail a draft: the caller catches and keeps the fused order (the
 * rerank is a refinement of a list that is already usable), which is why nothing here retries.
 */
export async function rerankChunks(
  reranker: Reranker,
  query: string,
  candidates: RetrievedChunk[],
  topK: number,
  signal?: AbortSignal,
): Promise<RetrievedChunk[]> {
  if (candidates.length === 0) return []
  const results = await reranker.rerank(query, candidates.map((c) => c.content), topK, signal)

  // A provider that repeats or invents an index must not duplicate or crash a chunk lookup.
  const seen = new Set<number>()
  const picked: { index: number; score: number }[] = []
  for (const result of results) {
    if (!Number.isInteger(result.index) || result.index < 0 || result.index >= candidates.length) continue
    if (seen.has(result.index)) continue
    seen.add(result.index)
    picked.push(result)
  }
  return picked
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((result) => ({ ...candidates[result.index]!, score: result.score }))
}
