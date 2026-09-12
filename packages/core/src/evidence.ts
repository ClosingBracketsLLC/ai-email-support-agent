import type { DemotionReason } from '@aesa/contracts'

/** Spec §Learning loop, mechanism 2 — every number here is the spec's. */
export const MEMORY_BANDS: readonly (readonly [minCosine: number, band: number])[] = [[0.90, 1], [0.84, 0.8], [0.78, 0.5]]
export const MEMORY_MAX_APPROVALS = 3
/** Answers below this cosine are not even shown to the model — below the first band, so a near miss
 * still lends phrasing while contributing nothing to `memory`. */
export const MEMORY_RETRIEVE_MIN_COSINE = 0.70
export const MEMORY_EXPIRY_DAYS = 365
export const MEMORY_CANDIDATE_MAX_AGE_DAYS = 30
export const MEMORY_STRIKES_TO_RETIRE = 2
/** Spec blockers: "thread longer than 6 messages" — inclusive of the message being answered. */
export const THREAD_MAX_MESSAGES_FOR_AUTO = 6
/** An auto-send with no flag and no hold-then-edit within this many days counts as confirmed. */
export const AUTO_SENT_CONFIRM_DAYS = 7

const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0)

export function memoryBand(cosine: number): number {
  if (!Number.isFinite(cosine)) return 0
  for (const [min, band] of MEMORY_BANDS) if (cosine >= min) return band
  return 0
}

export function memoryScore(cosine: number, approvals: number): number {
  const scaled = Math.min(Math.max(Math.floor(approvals), 0), MEMORY_MAX_APPROVALS) / MEMORY_MAX_APPROVALS
  return memoryBand(cosine) * scaled
}

export function evidenceScore(p: { memory: number; grounding: number | null; model: number }): number {
  return clamp01(Math.max(clamp01(p.memory), clamp01(p.grounding ?? 0)) * clamp01(p.model))
}

export const DEMOTION_RULES = {
  rejections: 2, rejectionWindowDays: 7,
  flags: 2, flagWindowDays: 30,
  editRate: 0.3, editRateMinDecisions: 8, decisionWindowDays: 30,
} as const

export interface DemotionSignals {
  rejectionsInWindow: number
  flagsInWindow: number
  /** An auto-send the owner held and then edited or rejected, inside the rejection window. */
  heldThenChanged: boolean
  decisions: { unchanged: number; edited: number }
}

/** Spec order: two rejections; two flags; hold → edit/reject; edit rate > 30% over ≥ 8 decisions. */
export function evaluateDemotion(s: DemotionSignals): DemotionReason | null {
  if (s.rejectionsInWindow >= DEMOTION_RULES.rejections) return 'rejections'
  if (s.flagsInWindow >= DEMOTION_RULES.flags) return 'flags'
  if (s.heldThenChanged) return 'hold_then_edit'
  const total = s.decisions.unchanged + s.decisions.edited
  if (total >= DEMOTION_RULES.editRateMinDecisions && s.decisions.edited / total > DEMOTION_RULES.editRate) return 'edit_rate'
  return null
}

export const GRADUATION_RULES = { minDecisions: 20, minUnchangedRate: 0.9, rejectionFreeDays: 14, sampleSize: 20 } as const

export interface GraduationSignals {
  unchanged: number
  edited: number
  rejected: number
  daysSinceLastRejection: number | null
}

/** The three rule fields `evaluateGraduation` reads, widened to `number` — `GRADUATION_RULES` itself
 *  is `as const`, so picking straight from it would fossilize each value as its own literal type
 *  (e.g. `minDecisions: 20`), rejecting `graduationRulesFor`'s `standard`-tier override of 40. */
export interface GraduationRuleInputs { minDecisions: number; minUnchangedRate: number; rejectionFreeDays: number }

/** `rules` defaults to `GRADUATION_RULES` — every existing caller passes nothing. `stats.rollup`
 *  passes `@aesa/core`'s `graduationRulesFor(tier)` result instead, so a `standard`-tier agent's
 *  higher `minDecisions` bar is enforced by the SAME function, not a duplicated copy of it. */
export function evaluateGraduation(s: GraduationSignals, rules: GraduationRuleInputs = GRADUATION_RULES): boolean {
  const total = s.unchanged + s.edited + s.rejected
  if (total < rules.minDecisions) return false
  if (s.unchanged / total < rules.minUnchangedRate) return false
  if (s.daysSinceLastRejection !== null && s.daysSinceLastRejection < rules.rejectionFreeDays) return false
  return true
}
