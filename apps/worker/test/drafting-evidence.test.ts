/**
 * `computeEvidence` — the ONE home of the evidence maths `ticket.draft` and `agent.sandbox` both
 * read (Phase 6 lifted the block out of both jobs). Pure: no database, no provider.
 */
import { describe, expect, it } from 'vitest'
import type { DraftDecision, RetrievedAnswer, RetrievedChunk } from '@aesa/agent'
import { computeEvidence } from '../src/drafting/evidence.ts'

const chunk = (id: string, score: number): RetrievedChunk => ({ id, heading: null, content: 'c', score })
const answer = (id: string, score: number, approvals: number): RetrievedAnswer =>
  ({ id, question: 'q', answer: 'a', score, approvals })

type Reply = Extract<DraftDecision, { outcome: 'reply' }>
const reply = (over: Partial<Reply> = {}): Reply => ({
  outcome: 'reply', body: 'b', categoryKey: 'other', confidence: 0.95, rationale: '', customerLanguage: 'en',
  unresolvedQuestions: [], citedChunkIds: [], usedAnswerIds: [], memoryConflictIds: [], ...over,
})

describe('computeEvidence', () => {
  it('filters invented ids, takes the best validated citation and the best USED answer, and multiplies by the CAPPED model term', () => {
    const r = computeEvidence({
      knowledge: { chunks: [chunk('c1', 0.7), chunk('c2', 0.9)], answers: [answer('a1', 0.92, 3), answer('a2', 0.85, 1)] },
      reply: reply({ citedChunkIds: ['c2', 'ghost'], usedAnswerIds: ['a2', 'ghost'], memoryConflictIds: ['c1', 'nope'], confidence: 0.95 }),
      tier: 'limited',
    })
    expect(r.retrievedChunkIds).toEqual(['c1', 'c2'])
    expect(r.retrievedAnswerIds).toEqual(['a1', 'a2'])
    expect(r.citedChunkIds).toEqual(['c2'])
    expect(r.usedAnswerIds).toEqual(['a2'])
    expect(r.memoryConflictIds).toEqual(['c1'])
    expect(r.groundingScore).toBe(0.9)
    expect(r.memory).toMatchObject({ answerId: 'a2', cosine: 0.85, approvals: 1 })
    expect(r.memory!.score).toBeCloseTo(0.8 / 3, 5)
    expect(r.modelRaw).toBe(0.95)
    expect(r.modelCapped).toBe(0.6)
    expect(r.evidence).toBeCloseTo(0.9 * 0.6, 5)          // max(0.267, 0.9) × 0.6
  })

  it('picks the highest-scoring USED answer, not the highest-scoring retrieved one', () => {
    const r = computeEvidence({
      knowledge: { chunks: [], answers: [answer('a1', 0.95, 3), answer('a2', 0.91, 3)] },
      reply: reply({ usedAnswerIds: ['a2'] }),
      tier: 'calibrated',
    })
    expect(r.memory).toMatchObject({ answerId: 'a2', cosine: 0.91, approvals: 3 })
    expect(r.memory!.score).toBeCloseTo(1, 5)
    expect(r.groundingScore).toBeNull()
    expect(r.evidence).toBeCloseTo(0.95, 5)
  })

  it('calibrated leaves the model term alone; a non-reply yields nulls and empty lists', () => {
    expect(
      computeEvidence({
        knowledge: { chunks: [chunk('c1', 0.8)], answers: [] },
        reply: reply({ citedChunkIds: ['c1'], confidence: 0.95 }),
        tier: 'calibrated',
      }).evidence,
    ).toBeCloseTo(0.76, 5)

    const none = computeEvidence({ knowledge: { chunks: [chunk('c1', 0.8)], answers: [] }, reply: null, tier: 'standard' })
    expect(none).toMatchObject({
      citedChunkIds: [], usedAnswerIds: [], memoryConflictIds: [], groundingScore: null, memory: null,
      modelRaw: null, modelCapped: null, evidence: null, retrievedChunkIds: ['c1'], retrievedAnswerIds: [],
    })
  })
})
