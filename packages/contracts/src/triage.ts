import { z } from 'zod'

export const SENTIMENTS = ['positive', 'neutral', 'negative', 'angry'] as const
export type Sentiment = (typeof SENTIMENTS)[number]

export const ESCALATION_FLAGS = ['legal_threat', 'chargeback_threat', 'injury', 'recall_mention'] as const
export type EscalationFlag = (typeof ESCALATION_FLAGS)[number]

export const NEEDS_OWNER_REASONS = [
  'tripwire', 'triage_flags', 'sentiment_angry', 'triage_failed', 'triage_cap',
  'agent_escalated', 'agent_failed', 'agent_run_cap', 'guardrail_failed', 'redraft_limit_reached',
  'redraft_unfulfilled', 'owner_handling', 'orphaned', 'draft_expired', 'send_failed', 'category_off', 'no_agent',
  'provider_unavailable',
] as const
export type NeedsOwnerReason = (typeof NEEDS_OWNER_REASONS)[number]

export const TriageVerdict = z.object({
  categoryKey: z.string().min(1).max(40),
  language: z.string().min(2).max(16),
  sentiment: z.enum(SENTIMENTS),
  isSpam: z.boolean(),
  isAutomated: z.boolean(),
  escalationFlags: z.array(z.enum(ESCALATION_FLAGS)).max(4),
  questions: z.array(z.string().min(1).max(300)).max(5),
})
export type TriageVerdict = z.infer<typeof TriageVerdict>
