import type { DecisionAction, DecisionReason } from '@aesa/contracts'

export interface DecisionInput {
  platformKillSwitch: boolean
  workspaceKillSwitch: boolean
  agentEnabled: boolean
  agentActive: boolean
  subscriptionActive: boolean
  tripwire: boolean
  outcome: 'reply' | 'escalate' | 'no_reply'
  ownerFeedbackPending: boolean
  guardrail: { ok: boolean; warningCount: number }
  dmarcPass: boolean | null // the latest inbound's stamp; null (unknown) counts as not authenticated
  categoryMode: 'off' | 'review' | 'auto'
  isRedraft: boolean
  /** The model flagged a retrieved answer as contradicting the guidance (spec blocker "memory conflict"). */
  memoryConflict: boolean
  /** The model left something it could not ground (spec blocker "unresolved questions"). */
  unresolvedQuestions: boolean
  /** More than THREAD_MAX_MESSAGES_FOR_AUTO messages in the thread (spec blocker). */
  threadTooLong: boolean
  humanDecisionCount: number // cold-start lock below COLD_START_DECISIONS
  evidence: number | null // Phase 5; null in Phase 3
  threshold: number | null
  hasAttachments: boolean
  allowanceExhausted: boolean
  autoSendCapReached: boolean
  mailboxHealthy: boolean
}

export interface Decision {
  action: DecisionAction
  reason: DecisionReason
  /** pre-stamp escalation_notified_at (no page) */
  quiet?: true
}

export const COLD_START_DECISIONS = 10

/**
 * Pure function of DecisionInput (spec §Decision). Evaluation order below is the specification —
 * do not reorder without updating the spec and the decision table in autonomy.test.ts.
 */
export function decide(i: DecisionInput): Decision {
  if (i.platformKillSwitch) return { action: 'review', reason: 'platform_killswitch' }
  if (i.workspaceKillSwitch) return { action: 'review', reason: 'workspace_killswitch' }
  if (!i.agentEnabled || !i.agentActive) return { action: 'review', reason: 'agent_disabled' }
  if (!i.subscriptionActive) return { action: 'review', reason: 'subscription_inactive' }
  if (i.tripwire) return { action: 'escalate', reason: 'tripwire' }
  if (i.outcome === 'escalate') return { action: 'escalate', reason: 'agent_escalate' }
  if (i.outcome === 'no_reply') {
    return i.ownerFeedbackPending ? { action: 'escalate', reason: 'redraft_unfulfilled' } : { action: 'no_action', reason: 'no_reply' }
  }
  if (!i.guardrail.ok) return { action: 'escalate', reason: 'guardrail_failed' }
  if (i.dmarcPass !== true) return { action: 'review', reason: 'dmarc_fail' }
  if (i.categoryMode === 'off') return { action: 'escalate', reason: 'category_off', quiet: true }
  if (i.categoryMode === 'review') return { action: 'review', reason: 'category_review' }
  if (i.isRedraft) return { action: 'review', reason: 'redraft' }
  if (i.guardrail.warningCount > 0) return { action: 'review', reason: 'guardrail_warning' }
  if (i.memoryConflict) return { action: 'review', reason: 'memory_conflict' }
  if (i.unresolvedQuestions) return { action: 'review', reason: 'unresolved_questions' }
  if (i.threadTooLong) return { action: 'review', reason: 'thread_too_long' }
  if (i.humanDecisionCount < COLD_START_DECISIONS) return { action: 'review', reason: 'cold_start' }
  if (i.evidence === null || i.threshold === null || i.evidence < i.threshold) return { action: 'review', reason: 'below_threshold' }
  if (i.hasAttachments) return { action: 'review', reason: 'attachments' }
  if (i.allowanceExhausted) return { action: 'review', reason: 'allowance_exhausted' }
  if (i.autoSendCapReached) return { action: 'review', reason: 'auto_send_cap' }
  if (!i.mailboxHealthy) return { action: 'review', reason: 'mailbox_unhealthy' }
  return { action: 'send', reason: 'ok' }
}
