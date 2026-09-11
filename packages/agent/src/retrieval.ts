/**
 * The retrieval seam. Phase 3 ships `emptyRetriever` — the knowledge block renders its
 * "nothing connected yet" copy and every answer is grounded in the workspace profile and the
 * operating guidance alone. Phase 4 implements this interface over the knowledge tables (embed
 * each triage question, exact cosine scan within the org) without touching a caller.
 *
 * `orgId` rides in the input on purpose: an implementation filters `org_id` in SQL, and the
 * caller re-checks every id it gets back before anything enters a prompt (spec §Tenancy).
 */
export interface RetrievedChunk {
  id: string
  heading: string | null
  content: string
  score: number
}

export interface RetrievedAnswer {
  id: string
  question: string
  answer: string
  score: number
  /** Human approvals so far (0 for an unsampled auto-send — which is never retrieved anyway);
   * `memoryScore(score, approvals)` is what the draft job computes from it. */
  approvals: number
}

export interface Retriever {
  retrieve(input: { orgId: string; questions: string[]; text: string; signal: AbortSignal }): Promise<{ chunks: RetrievedChunk[]; answers: RetrievedAnswer[] }>
}

export const emptyRetriever: Retriever = {
  async retrieve() {
    return { chunks: [], answers: [] }
  },
}
