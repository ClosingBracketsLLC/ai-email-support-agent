import { describe, expect, it } from 'vitest'
import { DEMOTION_RULES, evaluateDemotion, evaluateGraduation, evidenceScore, memoryBand, memoryScore } from '../src/evidence.ts'

describe('memory band (spec: ≥0.78→0.5, ≥0.84→0.8, ≥0.90→1.0, scaled by approvals up to 3)', () => {
  it.each([[0.77, 0], [0.78, 0.5], [0.839, 0.5], [0.84, 0.8], [0.899, 0.8], [0.90, 1], [1, 1], [Number.NaN, 0]])('memoryBand(%s) = %s', (cos, band) => {
    expect(memoryBand(cos)).toBe(band)
  })
  it.each([[0.92, 1, 1 / 3], [0.92, 2, 2 / 3], [0.92, 3, 1], [0.92, 7, 1], [0.85, 3, 0.8], [0.5, 3, 0], [0.92, 0, 0]])('memoryScore(%s, %s) ≈ %s', (cos, approvals, want) => {
    expect(memoryScore(cos, approvals)).toBeCloseTo(want, 6)
  })
})

describe('evidence = max(memory, grounding) × model', () => {
  it.each([
    [{ memory: 1, grounding: 0.4, model: 0.9 }, 0.9],
    [{ memory: 0, grounding: 0.7, model: 0.8 }, 0.56],
    [{ memory: 0, grounding: null, model: 0.95 }, 0],
    [{ memory: 0.5, grounding: 0.9, model: 1.2 }, 0.9],   // model clamped to 1
  ])('evidenceScore(%j) ≈ %s', (input, want) => {
    expect(evidenceScore(input)).toBeCloseTo(want, 6)
  })
})

describe('evaluateDemotion (spec §Learning loop, in order)', () => {
  const clear = { rejectionsInWindow: 0, flagsInWindow: 0, heldThenChanged: false, decisions: { unchanged: 10, edited: 0 } }
  it.each([
    ['two rejections', { rejectionsInWindow: 2 }, 'rejections'],
    ['two flags', { flagsInWindow: 2 }, 'flags'],
    ['hold then edit/reject', { heldThenChanged: true }, 'hold_then_edit'],
    ['edit rate > 30% over ≥ 8', { decisions: { unchanged: 5, edited: 3 } }, 'edit_rate'],
    ['edit rate > 30% but under 8 decisions', { decisions: { unchanged: 4, edited: 3 } }, null],
    ['edit rate exactly 30%', { decisions: { unchanged: 7, edited: 3 } }, null],
    ['one rejection, one flag', { rejectionsInWindow: 1, flagsInWindow: 1 }, null],
    ['rejections win over flags when both trip', { rejectionsInWindow: 2, flagsInWindow: 2 }, 'rejections'],
  ])('%s → %s', (_name, over, want) => {
    expect(evaluateDemotion({ ...clear, ...over })).toBe(want)
  })
  it('pins the rule numbers', () => {
    expect(DEMOTION_RULES).toEqual({ rejections: 2, rejectionWindowDays: 7, flags: 2, flagWindowDays: 30, editRate: 0.3, editRateMinDecisions: 8, decisionWindowDays: 30 })
  })
})

describe('evaluateGraduation (≥ 20 decisions, ≥ 90% unchanged, no rejection in 14 days)', () => {
  it.each([
    [{ unchanged: 18, edited: 2, rejected: 0, daysSinceLastRejection: null }, true],
    [{ unchanged: 19, edited: 0, rejected: 0, daysSinceLastRejection: null }, false],   // 19 < 20
    [{ unchanged: 17, edited: 3, rejected: 0, daysSinceLastRejection: null }, false],   // 85%
    [{ unchanged: 18, edited: 1, rejected: 1, daysSinceLastRejection: 13 }, false],
    [{ unchanged: 18, edited: 1, rejected: 1, daysSinceLastRejection: 14 }, true],
  ])('%j → %s', (s, want) => {
    expect(evaluateGraduation(s)).toBe(want)
  })
})
