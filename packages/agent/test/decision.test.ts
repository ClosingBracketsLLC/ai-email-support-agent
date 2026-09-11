import { describe, expect, it } from 'vitest'
import { DRAFT_BODY_MAX } from '@aesa/contracts'
import { DraftDecision } from '../src/draft/decision.ts'

const REPLY = {
  outcome: 'reply' as const,
  categoryKey: 'order_status',
  body: 'Your order shipped on Monday and the carrier has it now.',
  confidence: 0.82,
  citedChunkIds: ['chunk-1'],
  usedAnswerIds: [],
  memoryConflictIds: [],
  unresolvedQuestions: ['Which carrier is handling this shipment?'],
  customerLanguage: 'en',
  rationale: 'The thread asks where the order is; the shipping chunk answers it.',
}

describe('DraftDecision', () => {
  it('parses a reply decision with every field', () => {
    const parsed = DraftDecision.parse(REPLY)
    expect(parsed).toEqual(REPLY)
  })

  it('parses an escalate decision', () => {
    const escalate = { outcome: 'escalate' as const, reason: 'legal_or_safety' as const, rationale: 'The customer mentions a lawyer.' }
    expect(DraftDecision.parse(escalate)).toEqual(escalate)
  })

  it('parses a no_reply decision', () => {
    const noReply = { outcome: 'no_reply' as const, reason: 'automated_sender' as const, rationale: 'A bounce notification, not a person.' }
    expect(DraftDecision.parse(noReply)).toEqual(noReply)
  })

  it('rejects a body one character over DRAFT_BODY_MAX', () => {
    const result = DraftDecision.safeParse({ ...REPLY, body: 'x'.repeat(DRAFT_BODY_MAX + 1) })
    expect(result.success).toBe(false)
  })

  it('rejects a confidence above 1', () => {
    const result = DraftDecision.safeParse({ ...REPLY, confidence: 1.2 })
    expect(result.success).toBe(false)
  })

  it('rejects an escalate reason that is not in ESCALATE_REASONS', () => {
    const result = DraftDecision.safeParse({ outcome: 'escalate', reason: 'because_i_said_so', rationale: 'nope' })
    expect(result.success).toBe(false)
  })

  it('rejects a no_reply decision carrying an escalate reason', () => {
    const result = DraftDecision.safeParse({ outcome: 'no_reply', reason: 'legal_or_safety', rationale: 'wrong union arm' })
    expect(result.success).toBe(false)
  })
})
