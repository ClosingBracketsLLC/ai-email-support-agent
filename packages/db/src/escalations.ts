/**
 * The ONE way any process moves a ticket INTO `needs_owner`: the worker's drafting/send/sweep jobs
 * and the api's draft service all enter through `escalateTicket`, so the guarded flip, the cleared
 * `escalation_notified_at`, the redraft-cycle reset, the notification row and the audit row can
 * never drift apart between callers. It lives in `@aesa/db` rather than in the worker because both
 * sides need it and neither may own the other's copy.
 *
 * `escalationCopy` / `escalationDedupeKey` / `insertEscalationNotification` were private to
 * `apps/worker/src/jobs/ticket-triage.ts` in Phase 2 and moved here unchanged (the four Phase 2
 * titles are preserved verbatim); the table now covers every `NEEDS_OWNER_REASONS` entry, which the
 * `Record<NeedsOwnerReason, …>` type makes the compiler enforce as reasons are added.
 *
 * This module deliberately does NOT import `@aesa/core` — core depends on contracts only, and a
 * db → core edge would invert that. The one thing it would want, `clearRedraftCycle()`, is spelled
 * inline below; keep the two in sync.
 */
import { and, eq } from 'drizzle-orm'
import type { NeedsOwnerReason } from '@aesa/contracts'
import { audit, type AuditActor } from './audit.ts'
import { notifications, tickets } from './schema/index.ts'
import type { OrgTx } from './tenant.ts'

const FALLBACK_COPY = { title: 'Needs your attention', body: 'This ticket needs your attention.' } as const

/**
 * Owner-facing push/digest copy per escalation reason. A `Record` over the union, so adding a
 * reason to `NEEDS_OWNER_REASONS` fails the build here instead of silently paging "Needs your
 * attention". Titles are the notification headline; bodies are one plain sentence — never a
 * customer body, never a model rationale.
 */
const ESCALATION_COPY: Record<NeedsOwnerReason, { title: string; body: string }> = {
  // -- Phase 2 (triage). Titles preserved verbatim from ticket-triage.ts. --
  tripwire: { title: 'Needs your attention', body: 'This ticket matched a tripwire and was held for you.' },
  triage_flags: { title: 'Ticket flagged for review', body: 'A message on this ticket was flagged during triage and needs your attention.' },
  sentiment_angry: { title: 'Angry customer', body: "This ticket's latest message reads as angry and needs your attention." },
  triage_failed: { title: 'Triage failed twice', body: 'This ticket could not be triaged automatically and needs your attention.' },
  triage_cap: { title: 'Daily triage limit reached', body: "This ticket is waiting because today's triage limit was reached." },
  // -- Phase 3 (draft → review → send). --
  agent_escalated: { title: 'The agent asked for a human', body: 'The agent decided this one is better answered by you.' },
  agent_failed: { title: 'Drafting failed twice', body: 'The agent could not produce a reply for this ticket and stopped trying.' },
  agent_run_cap: { title: 'Daily drafting limit for this ticket', body: "This ticket hit today's drafting limit and is waiting for you." },
  guardrail_failed: { title: 'Draft blocked by the guardrails — edit it before it can send', body: 'The draft is saved with the findings; edit it before it can go out.' },
  redraft_limit_reached: { title: 'Re-drafted twice already — please reply yourself', body: 'This ticket has used its re-draft attempts and needs your reply.' },
  redraft_unfulfilled: { title: 'The agent could not act on your feedback', body: 'Your re-draft feedback did not change the reply, so this is back with you.' },
  owner_handling: { title: 'Waiting for your reply', body: 'You took this ticket over — it is waiting for your reply.' },
  orphaned: { title: 'This ticket lost its draft', body: 'The draft for this ticket went missing, so it is waiting for you.' },
  draft_expired: { title: 'A draft expired unreviewed', body: 'A draft for this ticket expired before anyone reviewed it.' },
  send_failed: { title: 'An approved reply could not be sent', body: 'The approved reply for this ticket could not be delivered.' },
  category_off: { title: 'This category is switched off', body: "The agent is switched off for this ticket's category, so it is waiting for you." },
  no_agent: { title: 'No agent is set up for this address', body: 'No agent is set up for the address this ticket arrived on.' },
}

export function escalationCopy(reason: NeedsOwnerReason): { title: string; body: string } {
  return ESCALATION_COPY[reason] ?? FALLBACK_COPY
}

/**
 * Day-scoped, not lifetime-scoped (controller ruling, Phase 2 fix review): `escalation:${ticketId}`
 * alone would mean the FIRST escalation ever notified for this ticket permanently wins the unique
 * index — a ticket that gets resolved and later re-escalates (a second `triage_failed`, a fresh
 * angry follow-up after a reopen, …) would then insert nothing and page nobody. Scoping by UTC day
 * makes the dedupe "at most one push per ticket per day", while `escalation_notified_at` (cleared on
 * every transition INTO `needs_owner`) stays the authoritative "has this escalation episode been
 * notified" stamp — this key only governs the notification row.
 */
export function escalationDedupeKey(ticketId: string, day: string): string {
  return `escalation:${ticketId}:${day}`
}

/** `ON CONFLICT (dedupe_key) DO NOTHING` — a second escalation for the same dedupe key (e.g. the
 * same ticket escalated twice in one UTC day) is a silent no-op: no duplicate row, no second page. */
export async function insertEscalationNotification(
  tx: OrgTx, orgId: string, ticketId: string, dedupeKey: string, reason: NeedsOwnerReason, extra?: { draftId?: string },
): Promise<string | undefined> {
  const { title, body } = escalationCopy(reason)
  const payload: Record<string, string> = { ticketId }
  if (extra?.draftId) payload.draftId = extra.draftId
  const [row] = await tx
    .insert(notifications)
    .values({ orgId, kind: 'escalation', title, body, dedupeKey, payload })
    .onConflictDoNothing({ target: notifications.dedupeKey })
    .returning({ id: notifications.id })
  return row?.id
}

export interface EscalateTicketParams {
  orgId: string
  ticketId: string
  /** The status the ticket was SELECTED with; the flip is guarded on it, so a concurrent owner
   *  action that already moved the ticket wins and this call writes nothing at all. */
  fromStatus: string
  reason: NeedsOwnerReason
  /** UTC day (YYYY-MM-DD) for the notification dedupe key. */
  day: string
  now: Date
  /** The owner caused this escalation (a reject, a take-over): pre-stamp `escalation_notified_at`
   *  and page nobody — they are already looking at the ticket. */
  quiet?: boolean
  draftId?: string
  actor: AuditActor
  /** Callers pass `'ticket.escalated'` — Task 18's Activity feed counts that action. */
  auditAction: string
  detail?: Record<string, unknown>
}

/**
 * The guarded transition INTO `needs_owner`, as ONE unit of work inside the caller's transaction:
 *
 *  1. `UPDATE … WHERE id = $ AND status = $fromStatus` — zero rows means a concurrent writer moved
 *     the ticket first, and this returns `{ escalated: false }` having written nothing (no audit
 *     row, no notification): the loser of the race must leave no trace.
 *  2. `escalation_notified_at` is nulled on every entry (the dispatcher's "not yet paged" flag), or
 *     pre-stamped to `now` when `quiet`.
 *  3. The redraft cycle is reset — `clearRedraftCycle()` in `@aesa/core`, spelled inline here.
 *  4. One audit row, then the notification (skipped entirely when `quiet`).
 *
 * The returned `notificationId` is what the caller enqueues `notify.dispatch` with, AFTER its
 * transaction commits; `undefined` means either `quiet` or a dedupe hit (already paged today).
 */
export async function escalateTicket(tx: OrgTx, p: EscalateTicketParams): Promise<{ escalated: boolean; notificationId?: string }> {
  const rows = await tx
    .update(tickets)
    .set({
      status: 'needs_owner',
      needsOwnerReason: p.reason,
      escalationNotifiedAt: p.quiet ? p.now : null,
      // clearRedraftCycle() from @aesa/core, inlined: packages/db must not depend on core.
      ownerRedraftFeedback: null,
      redraftCount: 0,
    })
    .where(and(eq(tickets.id, p.ticketId), eq(tickets.status, p.fromStatus)))
    .returning({ id: tickets.id })
  if (rows.length === 0) return { escalated: false }

  await audit(tx, {
    actor: p.actor,
    action: p.auditAction,
    entityType: 'ticket',
    entityId: p.ticketId,
    detail: { reason: p.reason, ...p.detail },
  })

  if (p.quiet) return { escalated: true }
  const notificationId = await insertEscalationNotification(
    tx, p.orgId, p.ticketId, escalationDedupeKey(p.ticketId, p.day), p.reason, { draftId: p.draftId },
  )
  return notificationId === undefined ? { escalated: true } : { escalated: true, notificationId }
}
