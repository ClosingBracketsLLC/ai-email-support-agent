import { z } from 'zod'

export const CATEGORY_MODES = ['off', 'review', 'auto'] as const
export type CategoryMode = (typeof CATEGORY_MODES)[number]

/** Percent thresholds on the EVIDENCE score (spec §Learning loop: "82% · would auto-send at 85%"). */
export const AUTONOMY_THRESHOLD_PRESETS = { cautious: 90, balanced: 80, eager: 70 } as const
export type ThresholdPreset = keyof typeof AUTONOMY_THRESHOLD_PRESETS
export const DEFAULT_AUTO_SEND_THRESHOLD = AUTONOMY_THRESHOLD_PRESETS.balanced
export const AUTO_SEND_THRESHOLD_MIN = 50
export const AUTO_SEND_THRESHOLD_MAX = 99
/** The Hold window choices the Autopilot screen offers, in minutes (spec §Send: default 2). */
export const AUTO_SEND_DELAY_CHOICES = [2, 5, 15] as const

export const SetCategoryPolicyInput = z.object({
  agentId: z.uuid(),
  categoryId: z.uuid(),
  mode: z.enum(CATEGORY_MODES),
  autoSendMinConfidence: z.number().int().min(AUTO_SEND_THRESHOLD_MIN).max(AUTO_SEND_THRESHOLD_MAX).optional(),
})
export type SetCategoryPolicyInput = z.infer<typeof SetCategoryPolicyInput>

/** Why a category went Auto → Review (spec §Learning loop "Demotion is automatic"), in evaluation order. */
export const DEMOTION_REASONS = ['rejections', 'flags', 'hold_then_edit', 'edit_rate', 'model_changed'] as const
export type DemotionReason = (typeof DEMOTION_REASONS)[number]

/** The push category whose device actions are Review / Hold (`draft_review` keeps Review only). */
export const AUTO_SEND_PUSH_CATEGORY = 'auto_send'
