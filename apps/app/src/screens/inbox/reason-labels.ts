/**
 * Every machine reason the api hands the app, in the owner's words. Each map is an exhaustive
 * `Record<union, string>` so a new reason in `@aesa/contracts` fails typecheck here rather than
 * rendering a bare enum name — the defensive `…Label(value)` lookups exist because the columns
 * behind these are plain `text`, so the tRPC-inferred type is a bare `string | null`.
 */
import type { DecisionReason, NeedsOwnerReason } from '@aesa/contracts'

/** Why the draft came to review instead of going out (spec §Decision, in `decide()`'s own order). */
export const DECISION_REASON_LABEL: Record<DecisionReason, string> = {
  platform_killswitch: 'Sending is paused across the platform',
  workspace_killswitch: 'Your workspace kill switch is on',
  agent_disabled: 'The agent is switched off',
  subscription_inactive: 'The subscription is not active',
  tripwire: 'A tripwire term was found',
  agent_escalate: 'The agent asked for a human',
  no_reply: 'No reply is needed',
  redraft_unfulfilled: 'The re-draft did not act on your feedback',
  guardrail_failed: 'The guardrails blocked this draft',
  dmarc_fail: 'Sender not verified',
  category_off: 'This category is switched off',
  category_review: 'Category set to review',
  redraft: 'A re-draft always comes to you',
  guardrail_warning: 'Guardrail warnings',
  memory_conflict: 'A learned answer conflicts with your guidance',
  unresolved_questions: 'The agent could not answer everything',
  thread_too_long: 'Long thread — a person should look',
  cold_start: 'Fewer than 10 decisions so far',
  below_threshold: 'Confidence below the send threshold',
  attachments: 'The customer sent attachments',
  allowance_exhausted: "This month's reply allowance is used up",
  auto_send_cap: "Today's auto-send cap is reached",
  mailbox_unhealthy: 'The mailbox needs attention',
  ok: 'Ready to send',
}

/** One sentence per `NeedsOwnerReason` (spec: "needs_owner banner with the reason sentence"). */
export const REASON_SENTENCE: Record<NeedsOwnerReason, string> = {
  tripwire: 'A tripwire term was found in this thread — it needs your review before anything is sent.',
  triage_flags: 'Triage flagged this message — it needs your review.',
  sentiment_angry: 'This customer sounds angry — it needs your review.',
  triage_failed: 'Triage could not read this message, so it needs your review.',
  triage_cap: "This category has hit today's review cap, so it needs your review.",
  agent_escalated: 'The agent asked for a human on this one — it needs your reply.',
  agent_failed: 'Drafting failed twice, so this ticket needs your reply.',
  agent_run_cap: "This ticket hit today's drafting limit — it needs your reply.",
  guardrail_failed: 'The guardrails blocked this draft. Edit it — the edited version has to pass before it can send.',
  redraft_limit_reached: 'Re-drafted twice already — please reply yourself.',
  redraft_unfulfilled: 'The agent could not act on your feedback — it needs your reply.',
  owner_handling: 'You chose to handle this one yourself.',
  orphaned: 'This ticket lost its draft — it needs your review.',
  draft_expired: 'A draft expired unreviewed — it needs your review.',
  send_failed: 'An approved reply could not be sent — check the mailbox and try again.',
  category_off: 'This category is switched off, so replies wait for you.',
  no_agent: 'No agent is set up for this address yet.',
  provider_unavailable: 'AI provider unavailable — the provider this agent uses rejected its key. Check Settings → AI.',
}

/**
 * Why an approved send is parked. Unlike the failed vocabulary below this one IS closed, and these
 * are every `held:*` string the product writes into `outbound_sends.last_error`: the seven
 * `held:${lever}` arms of `send.execute`'s `firstKillLever`, `ticket.draft`'s
 * `held:superseded_by_redraft` (`outcomes.ts`, when a re-draft retires the draft a send was queued
 * for) and the api's own `held:ticket_resolved` (`resolveTicket`). Anything starting with `reauth`
 * is the mailbox asking to be reconnected — `send.execute` writes that one without a `held:` prefix.
 * These read as the tail of "On hold — …".
 */
const HOLD_REASON_LABEL: Record<string, string> = {
  'held:platform_killswitch': 'sending is paused',
  'held:workspace_kill_switch': 'sending is paused',
  'held:agent_disabled': 'the agent is off',
  'held:agent_inactive': 'this agent is not active',
  'held:connection_unavailable': 'the mailbox needs reconnecting',
  'held:category_off': 'this category is off',
  'held:category_not_auto': 'this category is no longer on Autopilot',
  'held:superseded_by_redraft': 'a newer draft replaced it',
  'held:ticket_resolved': 'the ticket was resolved',
}
const HOLD_REASON_FALLBACK = 'sending was paused'

/**
 * Why an approved reply was never sent. Unlike the hold keys above, `outbound_sends.last_error` on a
 * FAILED send is not a closed vocabulary: `landTerminal` writes `guardrail:<code>[,<code>…]` and four
 * fixed sentences, `landStale` writes `stale: newer customer message`, and `landDeadLetter` writes an
 * arbitrary `errorMessage(err)` — a provider or network string that may carry anything at all. So the
 * raw value is NEVER rendered: the two prefixes and the four fixed sentences are mapped, and
 * everything else falls back. These read as the tail of "Not sent — …".
 */
const FAILED_REASON_LABEL: Record<string, string> = {
  'draft has no final body': 'the reply had no body',
  'ticket has no customer email': 'there is no customer address to reply to',
  'no inbound message to reply to': 'there is no customer message to reply to',
  'no rfc message id to thread the reply onto': 'the reply could not be threaded onto the conversation',
}
const FAILED_REASON_FALLBACK = 'the reply could not be sent'

export function decisionReasonLabel(reason: string | null): string | null {
  if (!reason) return null
  return (DECISION_REASON_LABEL as Record<string, string>)[reason] ?? null
}

export function reasonSentence(reason: string | null): string | null {
  if (!reason) return null
  return (REASON_SENTENCE as Record<string, string>)[reason] ?? null
}

/** `lastError` carries a trailing detail on the re-auth arm ('reauth_required: delivery unverified'). */
export function holdReasonLabel(lastError: string | null): string {
  if (!lastError) return HOLD_REASON_FALLBACK
  if (lastError.startsWith('reauth')) return 'the mailbox needs reconnecting'
  return HOLD_REASON_LABEL[lastError] ?? HOLD_REASON_FALLBACK
}

/** The tail of "Not sent — …" for a `failed` draft, whose send's `lastError` is free text. */
export function sendFailureLabel(lastError: string | null): string {
  if (!lastError) return FAILED_REASON_FALLBACK
  if (lastError.startsWith('guardrail:')) return 'the guardrails blocked the reply'
  if (lastError.startsWith('stale:')) return 'the customer wrote again first'
  return FAILED_REASON_LABEL[lastError] ?? FAILED_REASON_FALLBACK
}
