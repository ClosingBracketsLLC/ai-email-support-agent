/**
 * The evidence maths, in ONE place. `ticket.draft` and `agent.sandbox` computed the identical block
 * side by side until Phase 6 (which added a term to it); both now import this, and neither keeps a
 * copy — a drift between them would mean the number the owner reads on a "Try it" run is not the
 * number the auto gate would actually have compared against the threshold.
 *
 * Pure: no database, no provider, no clock. Three things happen here.
 *
 *  1. **Re-check every id that crossed the prompt boundary** (spec §Tenancy). An id retrieval never
 *     returned cannot be a citation — a model that invents one must not be able to make a draft look
 *     grounded — so the cited/used/conflict lists are filtered against what retrieval ACTUALLY
 *     returned before anything is scored or stored.
 *  2. `grounding` is the best VALIDATED citation's retrieval score; `memory` is the best answer the
 *     model actually USED, banded by its cosine and scaled by human approvals (spec §Learning loop).
 *     An answer that was retrieved but not used lends phrasing, never confidence.
 *  3. The quality tier's ONE touch on the maths (plan Global Constraints): the model's own
 *     self-assessment is clamped to `QUALITY_CAPS[tier]` before it multiplies the evidence. A
 *     `limited` model saying 0.99 about itself is worth 0.6 here. `drafts.confidence` still stores
 *     the RAW number (deviation 1) — `modelRaw` is what goes there, `modelCapped` is what the gate
 *     and `confidence_breakdown.model` see.
 */
import type { DraftDecision, RetrievedAnswer, RetrievedChunk } from '@aesa/agent'
import type { QualityTier } from '@aesa/contracts'
import { cappedModelConfidence, evidenceScore, memoryScore } from '@aesa/core'

export interface EvidenceResult {
  retrievedChunkIds: string[]
  retrievedAnswerIds: string[]
  /** Cited ids that retrieval actually returned — anything the model invented is dropped. */
  citedChunkIds: string[]
  usedAnswerIds: string[]
  memoryConflictIds: string[]
  /** The best validated citation's retrieval score; null when nothing was cited at all. */
  groundingScore: number | null
  /** The best USED answer and what it scored — the owner's "why did it auto-send?" answer. */
  memory: { score: number; answerId: string; cosine: number; approvals: number } | null
  /** The model's own self-assessment, uncapped — what `drafts.confidence` stores. */
  modelRaw: number | null
  /** `min(modelRaw, QUALITY_CAPS[tier])` — the term the evidence score is built from. */
  modelCapped: number | null
  /** `max(memory, grounding) × modelCapped`; null for every outcome but `reply`. */
  evidence: number | null
}

export interface EvidenceInput {
  knowledge: { chunks: RetrievedChunk[]; answers: RetrievedAnswer[] }
  /** Null for `escalate`/`no_reply`: no citations, no memory, no threshold to clear. */
  reply: Extract<DraftDecision, { outcome: 'reply' }> | null
  tier: QualityTier
}

export function computeEvidence(input: EvidenceInput): EvidenceResult {
  const retrievedChunkIds = input.knowledge.chunks.map((c) => c.id)
  const retrievedAnswerIds = input.knowledge.answers.map((a) => a.id)
  const reply = input.reply

  const citedChunkIds = reply ? reply.citedChunkIds.filter((id) => retrievedChunkIds.includes(id)) : []
  const usedAnswerIds = reply ? reply.usedAnswerIds.filter((id) => retrievedAnswerIds.includes(id)) : []
  const memoryConflictIds = reply
    ? reply.memoryConflictIds.filter((id) => retrievedChunkIds.includes(id) || retrievedAnswerIds.includes(id))
    : []

  const citedScores = input.knowledge.chunks.filter((c) => citedChunkIds.includes(c.id)).map((c) => c.score)
  const groundingScore = citedScores.length > 0 ? Math.max(...citedScores) : null

  const bestUsed = input.knowledge.answers
    .filter((a) => usedAnswerIds.includes(a.id))
    .reduce<{ answer: RetrievedAnswer; score: number } | null>((best, a) => {
      const score = memoryScore(a.score, a.approvals)
      return best === null || score > best.score ? { answer: a, score } : best
    }, null)
  const memory = bestUsed
    ? { score: bestUsed.score, answerId: bestUsed.answer.id, cosine: bestUsed.answer.score, approvals: bestUsed.answer.approvals }
    : null

  const modelRaw = reply ? reply.confidence : null
  const modelCapped = reply ? cappedModelConfidence(reply.confidence, input.tier) : null
  const evidence = modelCapped === null ? null : evidenceScore({ memory: memory?.score ?? 0, grounding: groundingScore, model: modelCapped })

  return {
    retrievedChunkIds, retrievedAnswerIds, citedChunkIds, usedAnswerIds, memoryConflictIds,
    groundingScore, memory, modelRaw, modelCapped, evidence,
  }
}
