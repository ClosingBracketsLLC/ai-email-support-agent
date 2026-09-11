/** Reciprocal-rank fusion. Every list — one per query per leg — contributes `1 / (k + rank)` for
 * the position a chunk took in it, so a chunk that several questions or both legs agree on rises
 * without the two legs' incomparable scales (a cosine and a `ts_rank_cd`) ever being added
 * together. The entries' `score` is deliberately ignored here: fusion ORDERS, and the score the
 * caller finally sees comes from the leg that found the chunk (see `retriever.ts`). */
export const RRF_K = 60

export function fuseRanked(lists: { id: string; score: number }[][], k = RRF_K): Map<string, number> {
  const fused = new Map<string, number>()
  for (const list of lists) {
    list.forEach((entry, index) => {
      fused.set(entry.id, (fused.get(entry.id) ?? 0) + 1 / (k + index + 1))
    })
  }
  return fused
}
