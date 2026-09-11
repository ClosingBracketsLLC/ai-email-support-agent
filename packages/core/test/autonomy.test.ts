import { describe, expect, it } from 'vitest'
import type { Decision, DecisionInput } from '../src/autonomy.ts'
import { COLD_START_DECISIONS, decide } from '../src/autonomy.ts'

// The fully-clear input: every gate passes, including the Phase-5-only `auto` branch (evidence >=
// threshold), so decide() reaches the final `send/ok` branch. Every row below starts from this and
// overrides only the field(s) needed to trip one gate — proving everything *before* that gate in
// the spec's evaluation order is still clear.
const basePass: DecisionInput = {
  platformKillSwitch: false,
  workspaceKillSwitch: false,
  agentEnabled: true,
  agentActive: true,
  subscriptionActive: true,
  tripwire: false,
  outcome: 'reply',
  ownerFeedbackPending: false,
  guardrail: { ok: true, warningCount: 0 },
  dmarcPass: true,
  categoryMode: 'auto',
  isRedraft: false,
  humanDecisionCount: COLD_START_DECISIONS,
  evidence: 0.9,
  threshold: 0.85,
  hasAttachments: false,
  allowanceExhausted: false,
  autoSendCapReached: false,
  mailboxHealthy: true,
}

describe('decide() — evaluation order (spec §Decision)', () => {
  it.each<[string, Partial<DecisionInput>, Decision]>([
    ['platformKillSwitch → review/platform_killswitch', { platformKillSwitch: true }, { action: 'review', reason: 'platform_killswitch' }],
    ['workspaceKillSwitch → review/workspace_killswitch', { workspaceKillSwitch: true }, { action: 'review', reason: 'workspace_killswitch' }],
    ['!agentEnabled → review/agent_disabled', { agentEnabled: false }, { action: 'review', reason: 'agent_disabled' }],
    ['!agentActive → review/agent_disabled', { agentActive: false }, { action: 'review', reason: 'agent_disabled' }],
    ['!subscriptionActive → review/subscription_inactive', { subscriptionActive: false }, { action: 'review', reason: 'subscription_inactive' }],
    ['tripwire → escalate/tripwire (cannot be turned off)', { tripwire: true }, { action: 'escalate', reason: 'tripwire' }],
    ['outcome escalate → escalate/agent_escalate', { outcome: 'escalate' }, { action: 'escalate', reason: 'agent_escalate' }],
    [
      'outcome no_reply, no feedback pending → no_action/no_reply',
      { outcome: 'no_reply', ownerFeedbackPending: false },
      { action: 'no_action', reason: 'no_reply' },
    ],
    [
      'outcome no_reply, feedback pending → escalate/redraft_unfulfilled',
      { outcome: 'no_reply', ownerFeedbackPending: true },
      { action: 'escalate', reason: 'redraft_unfulfilled' },
    ],
    [
      '!guardrail.ok → escalate/guardrail_failed',
      { guardrail: { ok: false, warningCount: 0 } },
      { action: 'escalate', reason: 'guardrail_failed' },
    ],
    ['dmarcPass false → review/dmarc_fail', { dmarcPass: false }, { action: 'review', reason: 'dmarc_fail' }],
    ['dmarcPass null (unknown) → review/dmarc_fail', { dmarcPass: null }, { action: 'review', reason: 'dmarc_fail' }],
    ['categoryMode off → escalate/category_off, quiet', { categoryMode: 'off' }, { action: 'escalate', reason: 'category_off', quiet: true }],
    ['categoryMode review → review/category_review', { categoryMode: 'review' }, { action: 'review', reason: 'category_review' }],
    ['isRedraft → review/redraft', { isRedraft: true }, { action: 'review', reason: 'redraft' }],
    [
      'warningCount > 0 → review/guardrail_warning',
      { guardrail: { ok: true, warningCount: 1 } },
      { action: 'review', reason: 'guardrail_warning' },
    ],
    [
      'humanDecisionCount < COLD_START_DECISIONS → review/cold_start',
      { humanDecisionCount: COLD_START_DECISIONS - 1 },
      { action: 'review', reason: 'cold_start' },
    ],
    ['evidence < threshold → review/below_threshold', { evidence: 0.5 }, { action: 'review', reason: 'below_threshold' }],
    ['evidence null → review/below_threshold', { evidence: null }, { action: 'review', reason: 'below_threshold' }],
    ['threshold null → review/below_threshold', { threshold: null }, { action: 'review', reason: 'below_threshold' }],
    ['hasAttachments → review/attachments', { hasAttachments: true }, { action: 'review', reason: 'attachments' }],
    ['allowanceExhausted → review/allowance_exhausted', { allowanceExhausted: true }, { action: 'review', reason: 'allowance_exhausted' }],
    ['autoSendCapReached → review/auto_send_cap', { autoSendCapReached: true }, { action: 'review', reason: 'auto_send_cap' }],
    ['!mailboxHealthy → review/mailbox_unhealthy', { mailboxHealthy: false }, { action: 'review', reason: 'mailbox_unhealthy' }],
    [
      'everything clear, auto mode, evidence >= threshold → send/ok',
      {},
      { action: 'send', reason: 'ok' },
    ],
  ])('%s', (_label, overrides, expected) => {
    expect(decide({ ...basePass, ...overrides })).toEqual(expected)
  })

  it('category_off is the only reason that carries quiet: true', () => {
    const decision = decide({ ...basePass, categoryMode: 'off' })
    expect(decision.quiet).toBe(true)
  })

  it('the fully-clear auto-mode base sends with no quiet flag set', () => {
    expect(decide(basePass)).toEqual({ action: 'send', reason: 'ok' })
  })
})
