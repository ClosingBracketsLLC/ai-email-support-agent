import { z } from 'zod'

/** Mirrors @aesa/core's DRAFT_STATUSES — the app cannot import @aesa/core (ESLint); Task 4 pins equality. */
export const DRAFT_STATUSES = ['pending', 'approved', 'held', 'sending', 'sent', 'rejected', 'superseded', 'expired', 'failed'] as const
export type DraftStatus = (typeof DRAFT_STATUSES)[number]
export const OUTBOUND_SEND_STATUSES = ['queued', 'held', 'claimed', 'sent', 'failed'] as const
export type OutboundSendStatus = (typeof OUTBOUND_SEND_STATUSES)[number]
export const AGENT_RUN_KINDS = ['triage', 'draft', 'sandbox'] as const
export const AGENT_RUN_STATUSES = ['running', 'succeeded', 'failed', 'aborted'] as const
export const DECISION_ACTIONS = ['send', 'review', 'escalate', 'no_action'] as const
export type DecisionAction = (typeof DECISION_ACTIONS)[number]
/** In decide()'s evaluation order (spec §Decision). 'ok' is the send branch. */
export const DECISION_REASONS = [
  'platform_killswitch', 'workspace_killswitch', 'agent_disabled', 'subscription_inactive',
  'tripwire', 'agent_escalate', 'no_reply', 'redraft_unfulfilled', 'guardrail_failed',
  'dmarc_fail', 'category_off', 'category_review', 'redraft', 'guardrail_warning', 'cold_start',
  'below_threshold', 'attachments', 'allowance_exhausted', 'auto_send_cap', 'mailbox_unhealthy', 'ok',
] as const
export type DecisionReason = (typeof DECISION_REASONS)[number]
export const DECISION_SOURCES = ['app', 'email', 'auto'] as const
export const REJECT_ACTIONS = ['redraft', 'handle'] as const
export type RejectAction = (typeof REJECT_ACTIONS)[number]
export const GUARDRAIL_CODES = [
  'empty_body', 'body_too_long', 'html_not_allowed', 'invisible_chars', 'contact_channel', 'url_not_allowed',
  'promised_action', 'secret_leak', 'trusted_text_leak', 'unbacked_number', 'language_mismatch',
] as const
export type GuardrailCode = (typeof GUARDRAIL_CODES)[number]
export const DRAFT_BODY_MAX = 4000
export const REJECT_REASON_MAX = 2000
export const SANDBOX_QUESTION_MAX = 4000
/** The undo window a human approval gets before send.execute may claim the send (spec §Send: 15 s). */
export const APPROVE_UNDO_SECONDS = 15
export const DRAFT_EXPIRE_DAYS = 7

export const DraftIdInput = z.object({ draftId: z.uuid() })
export const ApproveDraftInput = z.object({
  draftId: z.uuid(),
  /** Present = the owner edited the body; absent = approved unchanged. Validated by the guardrails at the approve gate. */
  body: z.string().trim().min(1).max(DRAFT_BODY_MAX).optional(),
})
export const RejectDraftInput = z.object({
  draftId: z.uuid(),
  action: z.enum(REJECT_ACTIONS),
  reason: z.string().trim().max(REJECT_REASON_MAX).default(''),
})
export const ActivitySummaryInput = z.object({ days: z.union([z.literal(7), z.literal(30)]).default(7) })
export const SandboxStartInput = z.object({
  agentId: z.uuid(),
  subject: z.string().trim().max(200).default('Question'),
  question: z.string().trim().min(1).max(SANDBOX_QUESTION_MAX),
})
export const SandboxRunInput = z.object({ runId: z.uuid() })
