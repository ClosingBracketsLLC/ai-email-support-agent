/**
 * The drafting claim protocol — the per-ticket mutex the `ticket.draft` job runs on, ported from
 * doge-buddy's `apps/ops/src/jobs/support-agent-run.ts` (`claimTicket`, `unwindClaimStamp`,
 * `recordFailure`), adapted to this codebase's `withOrg` transactions, `needs_owner` naming and
 * shared `escalateTicket`. There is no `agent_session_id` here — Phase 3 runs are stateless.
 *
 * Every function takes an `OrgTx`: the caller owns the transaction, and none of this touches the
 * network, so a claim can never hold a connection across a model call.
 */
import { and, eq } from 'drizzle-orm'
import { INVARIANTS } from '@aesa/core'
import { audit, escalateTicket, tickets, type AuditActor, type OrgTx } from '@aesa/db'
import { utcDayString } from '../date-utils.ts'

/**
 * How long a claim may stand without a finish before the next attempt treats it as a hard-kill.
 * Comfortably above `DRAFT_JOB_EXPIRE_SECONDS / 60` (10 min) so a merely slow — but still running —
 * job is never re-claimed underneath itself; the backstop sweep (Task 14) uses this same constant.
 */
export const STUCK_AFTER_MINUTES = 20

/** Everything the draft job needs off the LOCKED row, so nothing has to be re-read after the claim. */
export interface ClaimedTicket {
  id: string
  status: string
  agentId: string | null
  connectionId: string
  lastInboundAt: Date | null
  lastAgentRunAt: Date | null
  lastAgentPromptedAt: Date | null
  lastAgentFinishedAt: Date | null
  agentFailureCount: number
  ownerRedraftFeedback: string | null
  redraftCount: number
  categoryId: string | null
  language: string | null
  sentiment: string | null
  subject: string | null
  customerEmail: string | null
  triageQuestions: string[]
  hasAttachments: boolean
}

export type ClaimResult =
  | { claimed: false; reason: 'ticket_missing' | 'not_triaged' | 'failure_ceiling' | 'watermark' | 'stuck_escalated'; status?: string }
  | {
      claimed: true
      /** True only when the STUCK branch is what authorized this claim — the only claim that charges a failure. */
      stuckClaim: boolean
      /** The PRE-update locked row: `agentFailureCount` here excludes this claim's own stuck charge (add `stuckClaim ? 1 : 0`). */
      ticket: ClaimedTicket
      /** The locked read's `last_inbound_at` — this run's staleness + prompt watermark. NEVER `now()`. */
      threadSnapshotAt: Date | null
      /** What `last_agent_run_at` held BEFORE this claim's stamp; what an unwind restores. */
      priorLastAgentRunAt: Date | null
      /** The EXACT value this claim wrote — literally the `now` it was called with, not a fresh clock read. */
      stampedLastAgentRunAt: Date
    }

/** The claim protocol's own audit/escalation identity: this all runs inside the `ticket.draft` job. */
const DRAFT_ACTOR: AuditActor = 'system:ticket.draft'

const CLAIM_COLUMNS = {
  id: tickets.id,
  status: tickets.status,
  agentId: tickets.agentId,
  connectionId: tickets.connectionId,
  lastInboundAt: tickets.lastInboundAt,
  lastAgentRunAt: tickets.lastAgentRunAt,
  lastAgentPromptedAt: tickets.lastAgentPromptedAt,
  lastAgentFinishedAt: tickets.lastAgentFinishedAt,
  agentFailureCount: tickets.agentFailureCount,
  ownerRedraftFeedback: tickets.ownerRedraftFeedback,
  redraftCount: tickets.redraftCount,
  categoryId: tickets.categoryId,
  language: tickets.language,
  sentiment: tickets.sentiment,
  subject: tickets.subject,
  customerEmail: tickets.customerEmail,
  triageQuestions: tickets.triageQuestions,
  hasAttachments: tickets.hasAttachments,
}

/**
 * The CAS claim: `SELECT … FOR UPDATE` the ticket row, evaluate the selection predicate against the
 * LOCKED row in JS, then stamp. The row lock is what makes this a true compare-and-swap — a
 * concurrent claimer's SELECT blocks until this transaction commits, so it reads the stamp this one
 * wrote and backs off instead of racing it. (That is also why no branch below needs a
 * `WHERE status = 'triaged'` of its own: the lock is the guard, and a strictly stronger one.)
 *
 * **Three watermarks, and only two of them are comparable.** `last_agent_run_at` (stamped here,
 * before the model call) and `last_agent_finished_at` (stamped by `stampFinished` on every
 * authoritative outcome) are both WALL-CLOCK: `run_at` newer than `finished_at` means "claimed but
 * never finished", which is exactly what stuck recovery detects. `last_agent_prompted_at` is a
 * MESSAGE-time watermark (the run's thread snapshot) used only to filter a thread — comparing it
 * against `run_at` would compare when a customer wrote against when a worker started, which is
 * degenerate: every settled ticket would look permanently stuck and be re-run every 20 minutes.
 *
 * The stuck branch carries the ONLY failure increment: `stuckClaim` requires that neither
 * `neverRun` nor `newInbound` would have authorized the claim on their own. A ticket that ran
 * successfully an hour ago and just got new mail claims via `newInbound` and must NOT be charged a
 * failure — it did not fail, and two of those would escalate a perfectly healthy ticket.
 */
export async function claimTicket(tx: OrgTx, p: { orgId: string; ticketId: string; now: Date }): Promise<ClaimResult> {
  const stuckBefore = new Date(p.now.getTime() - STUCK_AFTER_MINUTES * 60_000)

  const [locked] = await tx.select(CLAIM_COLUMNS).from(tickets).where(eq(tickets.id, p.ticketId)).limit(1).for('update')
  if (!locked) return { claimed: false, reason: 'ticket_missing' }
  if (locked.status !== 'triaged') return { claimed: false, reason: 'not_triaged', status: locked.status }
  if (locked.agentFailureCount >= INVARIANTS.AGENT_FAILURE_ESCALATE_AT) return { claimed: false, reason: 'failure_ceiling' }

  const neverRun = locked.lastAgentRunAt === null
  const newInbound = locked.lastAgentRunAt !== null && locked.lastInboundAt !== null && locked.lastInboundAt > locked.lastAgentRunAt
  // Stuck-run recovery, both sides wall-clock: claimed 20+ minutes ago and never finished (a
  // hard-kill that expired the job before any handler code ran).
  const stuck =
    locked.lastAgentRunAt !== null &&
    locked.lastAgentRunAt < stuckBefore &&
    (locked.lastAgentFinishedAt === null || locked.lastAgentFinishedAt < locked.lastAgentRunAt)

  if (!neverRun && !newInbound && !stuck) return { claimed: false, reason: 'watermark' }

  // ONLY a claim the stuck branch had to authorize counts as a failed attempt.
  const stuckClaim = stuck && !neverRun && !newInbound
  const agentFailureCount = locked.agentFailureCount + (stuckClaim ? 1 : 0)

  // The ceiling case escalates INSIDE this transaction, atomically with the increment that reached
  // it. Split across two transactions, a hard-kill in between would leave the ticket `triaged` at
  // the ceiling count: excluded from selection by the guard above, never escalated, and so never
  // notified — stranded forever with zero owner signal. The stamp still goes on (harmless: the
  // ticket is leaving `triaged`), so the whole thing is one commit.
  //
  // The notification `escalateTicket` inserts is NOT returned: `ClaimResult` carries no id, so the
  // caller cannot enqueue `notify.dispatch` for it. That is a latency cost, not a lost page — the
  // poll sweep re-enqueues any `pending` notification older than STUCK_NOTIFICATION_MINUTES.
  if (stuckClaim && agentFailureCount >= INVARIANTS.AGENT_FAILURE_ESCALATE_AT) {
    await tx.update(tickets).set({ lastAgentRunAt: p.now, agentFailureCount }).where(eq(tickets.id, p.ticketId))
    await escalateTicket(tx, {
      orgId: p.orgId, ticketId: p.ticketId, fromStatus: 'triaged', reason: 'agent_failed',
      day: utcDayString(p.now), now: p.now, actor: DRAFT_ACTOR, auditAction: 'ticket.escalated',
      detail: { agentFailureCount },
    })
    return { claimed: false, reason: 'stuck_escalated' }
  }

  await tx
    .update(tickets)
    .set({ lastAgentRunAt: p.now, ...(stuckClaim ? { agentFailureCount } : {}) })
    .where(eq(tickets.id, p.ticketId))

  return {
    claimed: true,
    stuckClaim,
    ticket: locked,
    threadSnapshotAt: locked.lastInboundAt,
    priorLastAgentRunAt: locked.lastAgentRunAt,
    stampedLastAgentRunAt: p.now,
  }
}

/**
 * Undoes the claim's stamp when the org-level gate refuses AFTER the claim (the unlocked pre-claim
 * reads can be slipped past by a concurrent worker; the locked gate is the real enforcement). Left
 * standing, that stamp would read as "claimed, never finished" 20 minutes later and the stuck
 * branch would charge a failure for a run that never happened — two of those falsely escalate the
 * ticket `agent_failed`. Guarded on the EXACT value the claim wrote (and on `triaged`), so it can
 * only ever touch the row it is meant to; anything else matches 0 rows and no-ops.
 */
export async function unwindClaimStamp(tx: OrgTx, ticketId: string, stampedValue: Date, priorValue: Date | null): Promise<boolean> {
  const rows = await tx
    .update(tickets)
    .set({ lastAgentRunAt: priorValue })
    .where(and(eq(tickets.id, ticketId), eq(tickets.status, 'triaged'), eq(tickets.lastAgentRunAt, stampedValue)))
    .returning({ id: tickets.id })
  return rows.length > 0
}

/**
 * The failure row, under a row lock (the lock IS the guard, and a stronger one than a status CAS):
 * count the attempt, and either escalate at the ceiling or clear the claim stamp so the retry can
 * claim immediately — without that clear the retry's CAS finds no new inbound and no-ops, stranding
 * the ticket below the ceiling for a whole stuck window.
 *
 * Deliberately does NOT stamp `last_agent_finished_at`: a failed attempt must keep reading as
 * "claimed but never finished", which is exactly what stuck recovery looks for.
 */
export async function recordFailure(
  tx: OrgTx,
  p: { orgId: string; ticketId: string; code: string; detail: string; now: Date; runId: string | null },
): Promise<{ escalated: boolean; agentFailureCount: number; notificationId?: string }> {
  const [locked] = await tx
    .select({ status: tickets.status, agentFailureCount: tickets.agentFailureCount })
    .from(tickets)
    .where(eq(tickets.id, p.ticketId))
    .limit(1)
    .for('update')
  if (!locked) return { escalated: false, agentFailureCount: 0 }

  const actor: AuditActor = p.runId ? `agent:${p.runId}` : DRAFT_ACTOR
  const agentFailureCount = locked.agentFailureCount + 1
  let escalated = false
  let notificationId: string | undefined

  if (agentFailureCount >= INVARIANTS.AGENT_FAILURE_ESCALATE_AT) {
    // The count always lands; the escalation only when the ticket is still the job's to move (an
    // owner action may have taken it elsewhere while the run was out at the model).
    await tx.update(tickets).set({ agentFailureCount }).where(eq(tickets.id, p.ticketId))
    if (locked.status === 'triaged') {
      const result = await escalateTicket(tx, {
        orgId: p.orgId, ticketId: p.ticketId, fromStatus: 'triaged', reason: 'agent_failed',
        day: utcDayString(p.now), now: p.now, actor, auditAction: 'ticket.escalated',
        detail: { agentFailureCount, code: p.code },
      })
      escalated = result.escalated
      notificationId = result.notificationId
    }
  } else {
    await tx.update(tickets).set({ agentFailureCount, lastAgentRunAt: null }).where(eq(tickets.id, p.ticketId))
  }

  // Atomic with the accounting above. `detail` may quote the rejected draft — audit only, never a
  // customer-visible surface.
  await audit(tx, {
    actor, action: 'draft.run_failed', entityType: 'ticket', entityId: p.ticketId,
    detail: { code: p.code, detail: p.detail },
  })

  return notificationId === undefined ? { escalated, agentFailureCount } : { escalated, agentFailureCount, notificationId }
}

/**
 * Every authoritative outcome (reply / escalate / no_reply, lost races included) ends here: the
 * wall-clock finish watermark that closes the stuck window, plus the promotion of this run's thread
 * snapshot to the MESSAGE-time prompt watermark when there was one. Unguarded on purpose — these
 * are watermarks, not a transition, and they must land whatever the ticket's status ended up as.
 */
export async function stampFinished(tx: OrgTx, ticketId: string, threadSnapshotAt: Date | null, now: Date): Promise<void> {
  await tx
    .update(tickets)
    .set({ lastAgentFinishedAt: now, ...(threadSnapshotAt !== null ? { lastAgentPromptedAt: threadSnapshotAt } : {}) })
    .where(eq(tickets.id, ticketId))
}
