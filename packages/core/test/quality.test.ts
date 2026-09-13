import { describe, expect, it } from 'vitest'
import { cappedModelConfidence, evidenceScore, graduationRulesFor, GRADUATION_RULES, QUALITY_CAPS } from '../src/index.ts'

describe('quality tiers', () => {
  it('caps are 1.0 / 0.9 / 0.6 and cap only the model term', () => {
    expect(QUALITY_CAPS).toEqual({ calibrated: 1, standard: 0.9, limited: 0.6 })
    expect(cappedModelConfidence(0.95, 'calibrated')).toBe(0.95)
    expect(cappedModelConfidence(0.95, 'standard')).toBe(0.9)
    expect(cappedModelConfidence(0.95, 'limited')).toBe(0.6)
    expect(cappedModelConfidence(0.4, 'limited')).toBe(0.4)
    expect(cappedModelConfidence(Number.NaN, 'limited')).toBe(0)
    // Worked example: grounding 0.9, memory 0, model 0.95 on a limited model → 0.9 × 0.6 = 0.54 < Eager's 0.70.
    expect(evidenceScore({ memory: 0, grounding: 0.9, model: cappedModelConfidence(0.95, 'limited') })).toBeCloseTo(0.54, 5)
  })

  it('graduation bars: calibrated keeps the spec numbers, standard doubles minDecisions, limited never graduates', () => {
    expect(graduationRulesFor('calibrated')).toEqual({ ...GRADUATION_RULES, canGraduate: true })
    expect(graduationRulesFor('standard')).toEqual({ ...GRADUATION_RULES, minDecisions: 40, canGraduate: true })
    expect(graduationRulesFor('limited')).toEqual({ ...GRADUATION_RULES, canGraduate: false })
  })
})
