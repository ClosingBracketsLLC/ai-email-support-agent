import { z } from 'zod'

export const RESOLVED_ANSWER_STATUSES = ['candidate', 'active', 'needs_review', 'retired'] as const
export type ResolvedAnswerStatus = (typeof RESOLVED_ANSWER_STATUSES)[number]
export const RETIRED_REASONS = ['owner', 'strikes', 'expired', 'unsampled', 'sampled_bad', 'source_changed'] as const
export type RetiredReason = (typeof RETIRED_REASONS)[number]
/** Why an `active` answer was parked in `needs_review` for the owner. */
export const REVIEW_REASONS = ['model_conflict', 'edited_reuse', 'source_changed'] as const
export type ReviewReason = (typeof REVIEW_REASONS)[number]

export const MEMORY_TABS = ['to_check', 'active', 'retired'] as const
export type MemoryTab = (typeof MEMORY_TABS)[number]
export const MemoryListInput = z.object({ tab: z.enum(MEMORY_TABS).default('to_check'), limit: z.number().int().min(1).max(100).default(50) })
export type MemoryListInput = z.infer<typeof MemoryListInput>
export const AnswerIdInput = z.object({ answerId: z.uuid() })
export const DeleteByCustomerInput = z.object({ email: z.email().max(254) })

export const GUIDANCE_SUGGESTION_STATUSES = ['pending', 'accepted', 'dismissed'] as const
export const GUIDANCE_SUGGESTION_MAX = 300
export const SuggestionIdInput = z.object({ suggestionId: z.uuid() })
