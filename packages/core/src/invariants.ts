/**
 * The margin between a job's pg-boss expiry and the AbortSignal deadline defineJob() gives its handler.
 * @aesa/queue imports this one: two copies would let the boot invariant pass while the real deadline drifts.
 */
export const JOB_SIGNAL_MARGIN_SECONDS = 30

/** Coupled constants the reference enforced only by comment. Asserted at api/worker boot; tested here. */
export const INVARIANTS = {
  REDRAFT_MAX: 2,
  AGENT_MAX_RUNS_PER_TICKET_PER_DAY: 3,
  AGENT_FAILURE_ESCALATE_AT: 2,
  SEND_QUEUE_EXPIRE_SECONDS: 600,
  SEND_CLAIM_HORIZON_SECONDS: 600,
  DRAFT_JOB_EXPIRE_SECONDS: 600,
  DRAFT_WATCHDOG_SECONDS: 240,
  JOB_SIGNAL_MARGIN_SECONDS,
} as const

export function checkInvariants(v: Record<keyof typeof INVARIANTS, number>): string[] {
  const violations: string[] = []
  if (1 + v.REDRAFT_MAX > v.AGENT_MAX_RUNS_PER_TICKET_PER_DAY)
    violations.push(`1 + REDRAFT_MAX (${v.REDRAFT_MAX}) must be <= AGENT_MAX_RUNS_PER_TICKET_PER_DAY (${v.AGENT_MAX_RUNS_PER_TICKET_PER_DAY})`)
  if (v.SEND_CLAIM_HORIZON_SECONDS !== v.SEND_QUEUE_EXPIRE_SECONDS)
    violations.push(`SEND_CLAIM_HORIZON_SECONDS (${v.SEND_CLAIM_HORIZON_SECONDS}) must equal SEND_QUEUE_EXPIRE_SECONDS (${v.SEND_QUEUE_EXPIRE_SECONDS})`)
  if (v.DRAFT_WATCHDOG_SECONDS + v.JOB_SIGNAL_MARGIN_SECONDS >= v.DRAFT_JOB_EXPIRE_SECONDS)
    violations.push(`DRAFT_WATCHDOG_SECONDS + JOB_SIGNAL_MARGIN_SECONDS must be < DRAFT_JOB_EXPIRE_SECONDS`)
  return violations
}

export function assertInvariants(): void {
  const violations = checkInvariants(INVARIANTS)
  if (violations.length) throw new Error(`invariant violations:\n- ${violations.join('\n- ')}`)
}
