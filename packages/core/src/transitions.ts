export class IllegalTransitionError extends Error {
  constructor(readonly from: string, readonly to: string) {
    super(`Illegal transition: ${from} -> ${to}`)
    this.name = 'IllegalTransitionError'
  }
}

/** Pure legal-transition matrix (ported from doge-buddy's proposals/transitions.ts). Guarded UPDATEs live in each repository. */
export function defineTransitions<S extends string>(matrix: Record<S, readonly NoInfer<S>[]>) {
  for (const [from, tos] of Object.entries(matrix) as [S, readonly S[]][]) {
    if (tos.includes(from)) throw new Error(`transition matrix lists a self-transition for ${from}`)
  }
  return {
    can: (from: S, to: S): boolean => matrix[from].includes(to),
    assert: (from: S, to: S): void => { if (!matrix[from].includes(to)) throw new IllegalTransitionError(from, to) },
  }
}

export const TICKET_STATUSES = ['new', 'triaged', 'awaiting_review', 'auto_sending', 'needs_owner', 'waiting_on_customer', 'resolved'] as const
export type TicketStatus = (typeof TICKET_STATUSES)[number]
export const ticketTransitions = defineTransitions<TicketStatus>({
  new: ['triaged', 'needs_owner', 'resolved'],
  triaged: ['awaiting_review', 'auto_sending', 'needs_owner', 'resolved'],
  awaiting_review: ['waiting_on_customer', 'triaged', 'needs_owner', 'resolved'],
  auto_sending: ['waiting_on_customer', 'awaiting_review', 'triaged', 'needs_owner'],
  needs_owner: ['triaged', 'resolved', 'waiting_on_customer'],
  waiting_on_customer: ['new', 'resolved'],
  resolved: ['new'],
})

export const DRAFT_STATUSES = ['pending', 'approved', 'held', 'sending', 'sent', 'rejected', 'superseded', 'expired', 'failed'] as const
export type DraftStatus = (typeof DRAFT_STATUSES)[number]
export const draftTransitions = defineTransitions<DraftStatus>({
  pending: ['approved', 'rejected', 'superseded', 'expired'],
  approved: ['sending', 'held', 'failed', 'superseded'],
  held: ['pending', 'expired'],
  // `sending` → `held`: a send that crashed mid-delivery leaves the draft here, and the retry's
  // recovery scan can come back "not delivered" with a kill lever now on. Without this edge the
  // send lands `held` beside a permanently `sending` draft that nothing can move (a `held` send is
  // not claimable and no sweep selects a `sending` draft) — the Task 13 review's stuck state.
  sending: ['sent', 'failed', 'held'],
  sent: [], rejected: [], superseded: [], expired: [], failed: [],
})

export const OUTBOUND_SEND_STATUSES = ['queued', 'held', 'claimed', 'sent', 'failed'] as const // === contracts' (pinned by test)
export type OutboundSendStatus = (typeof OUTBOUND_SEND_STATUSES)[number]
export const outboundSendTransitions = defineTransitions<OutboundSendStatus>({
  queued: ['held', 'claimed', 'failed'],
  held: ['queued', 'failed'],
  claimed: ['sent', 'failed', 'queued', 'held'], // queued = released for retry-later (rate limit, busy thread); held = a kill lever flipped
  sent: [],
  failed: ['queued'], // a re-approve after a failed send re-queues the same ledger row
})

export const AGENT_RUN_STATUSES = ['running', 'succeeded', 'failed', 'aborted'] as const
export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number]
export const agentRunTransitions = defineTransitions<AgentRunStatus>({
  running: ['succeeded', 'failed', 'aborted'],
  succeeded: [], failed: [], aborted: [],
})
