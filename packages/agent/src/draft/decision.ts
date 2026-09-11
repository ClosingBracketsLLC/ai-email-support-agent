/**
 * The model's structured output for one drafting run (spec §Draft). This shape never crosses to
 * the app — `drafts`' columns are the app's contract; the worker's `ticket.draft` job is the only
 * consumer, and it projects the fields it keeps onto that row.
 *
 * The adapter wraps this union in a `{ decision }` envelope of its own (`@aesa/llm`'s
 * `envelopeSchema`, ported from doge-buddy's `SupportOutputEnvelopeSchema`), so callers pass the
 * bare union as `output.schema` and read the already-unwrapped value off `result.parsed`.
 */
import { DRAFT_BODY_MAX } from '@aesa/contracts'
import { z } from 'zod'

/** Why a run handed the ticket to a human instead of replying. Mirrors the escalation vocabulary
 * the ticket's `needs_owner_reason` uses, but is the MODEL's own judgment — the job maps it onto
 * `agent_escalated` and keeps the specific reason in the run output and the audit detail. */
export const ESCALATE_REASONS = [
  'needs_human_judgment',
  'policy_conflict',
  'legal_or_safety',
  'angry_customer',
  'insufficient_knowledge',
  'requested_human',
  'other',
] as const
export type EscalateReason = (typeof ESCALATE_REASONS)[number]

/** Why a run decided the thread needs no reply at all. `no_reply` leaves the ticket where it is. */
export const NO_REPLY_REASONS = ['no_question', 'already_answered', 'automated_sender', 'thread_closed', 'other'] as const
export type NoReplyReason = (typeof NO_REPLY_REASONS)[number]

export const DraftDecision = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('reply'),
    /** One of the org's own category keys, enumerated for the model in the task section. */
    categoryKey: z.string().min(1).max(40),
    /** Plain text, NO sign-off — code appends the signature after the guardrails run. */
    body: z.string().min(1).max(DRAFT_BODY_MAX),
    /** The model's own self-assessment; one input to `confidence_breakdown`, never the whole of it. */
    confidence: z.number().min(0).max(1),
    citedChunkIds: z.array(z.string().max(64)).max(20),
    usedAnswerIds: z.array(z.string().max(64)).max(20),
    memoryConflictIds: z.array(z.string().max(64)).max(20),
    /** Anything the model could not ground — surfaced to the owner on the review screen. */
    unresolvedQuestions: z.array(z.string().min(1).max(300)).max(5),
    customerLanguage: z.string().min(2).max(16),
    rationale: z.string().min(1).max(2000),
  }),
  z.object({ outcome: z.literal('escalate'), reason: z.enum(ESCALATE_REASONS), rationale: z.string().min(1).max(2000) }),
  z.object({ outcome: z.literal('no_reply'), reason: z.enum(NO_REPLY_REASONS), rationale: z.string().min(1).max(2000) }),
])
export type DraftDecision = z.infer<typeof DraftDecision>
