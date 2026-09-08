export class IllegalTransitionError extends Error {
  constructor(readonly from: string, readonly to: string) {
    super(`Illegal transition: ${from} -> ${to}`)
    this.name = 'IllegalTransitionError'
  }
}

/** Pure legal-transition matrix (ported from doge-buddy's proposals/transitions.ts). Guarded UPDATEs live in each repository. */
export function defineTransitions<S extends string>(matrix: Record<string, readonly string[]> & Record<S, readonly S[]>) {
  for (const [from, tos] of Object.entries(matrix) as [S, readonly S[]][]) {
    if (tos.includes(from)) throw new Error(`transition matrix lists a self-transition for ${from}`)
  }
  return {
    can: (from: S, to: S): boolean => (matrix[from] as readonly S[]).includes(to),
    assert: (from: S, to: S): void => { if (!(matrix[from] as readonly S[]).includes(to)) throw new IllegalTransitionError(from, to) },
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
  sending: ['sent', 'failed'],
  sent: [], rejected: [], superseded: [], expired: [], failed: [],
})
