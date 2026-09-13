import type { QualityTier } from '@aesa/contracts'
import { GRADUATION_RULES } from './evidence.ts'

/** Spec §Risks ("local/small models capped at 0.6"), the other two fixed by plan deviation 6. The
 * cap clamps ONE input of `evidenceScore` — the model's self-assessment — so a weaker model's
 * confidence can never outrun its grounding. */
export const QUALITY_CAPS: Record<QualityTier, number> = { calibrated: 1, standard: 0.9, limited: 0.6 }

export function cappedModelConfidence(model: number, tier: QualityTier): number {
  if (!Number.isFinite(model)) return 0
  return Math.min(Math.max(model, 0), QUALITY_CAPS[tier])
}

export type GraduationRules = Omit<typeof GRADUATION_RULES, 'minDecisions'> & { minDecisions: number; canGraduate: boolean }

/** "Graduation streak requirements scale with a model-quality tier" (spec §Risks): the same rules,
 * a higher bar for `standard`, and no self-graduation at all for `limited` (the owner can still flip
 * Auto by hand; the 0.6 cap keeps every preset threshold unreachable there). */
export function graduationRulesFor(tier: QualityTier): GraduationRules {
  if (tier === 'standard') return { ...GRADUATION_RULES, minDecisions: 40, canGraduate: true }
  if (tier === 'limited') return { ...GRADUATION_RULES, canGraduate: false }
  return { ...GRADUATION_RULES, canGraduate: true }
}
