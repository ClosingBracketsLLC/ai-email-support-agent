/**
 * The three authoritative landings of one `ticket.draft` run — escalate, no_reply, and "a draft was
 * written" — each as ONE short `withOrg` transaction. Ported from doge-buddy's
 * `runAndHandleOutcome` / `submitProposeOutcome` (`apps/ops/src/jobs/support-agent-run.ts`), adapted
 * to this codebase's `escalateTicket`, `drafts` rows and run bookkeeping.
 *
 * Split out of `jobs/ticket-draft.ts` purely for readability: the job owns the pinned step order,
 * this file owns what each outcome writes. Nothing here calls the network, so no transaction can
 * ever span a model call.
 *
 * Two invariants hold across every function below (the reference's invariants 4 and 5):
 *
 *  - **`stampFinished` on EVERY authoritative outcome**, lost races included. It is the wall-clock
 *    half of the stuck gate; a finished run that skipped it would be re-claimed — and re-billed —
 *    every `STUCK_AFTER_MINUTES`, forever. The failure path is the one place it must NOT run, and
 *    that path lives in the job file, not here.
 *  - **Every status flip is guarded on `triaged`.** An owner action during the model call wins:
 *    the flip matches zero rows, the whole transaction is rolled back through `LostRaceError`, and
 *    the run records that it threw its work away rather than anchoring a draft to a ticket that has
 *    moved on.
 */
import { and, count, eq, gt, inArray } from 'drizzle-orm'
import type pino from 'pino'
import type { UsageTotals } from '@aesa/agent'
import type { DecisionReason, NeedsOwnerReason } from '@aesa/contracts'
import { DRAFT_EXPIRE_DAYS } from '@aesa/contracts'
import {
  audit, drafts, escalateTicket, notifications, tickets, withOrg,
  type AuditActor, type Db, type OrgTx,
} from '@aesa/db'
import { stampFinished } from './claim.ts'
import { finishRun } from './runs.ts'

/** This job's own audit/escalation identity for rows that are not attributable to a run. */
export const DRAFT_ACTOR: AuditActor = 'system:ticket.draft'

/**
 * Thrown INSIDE the final transaction when the guarded flip (or the escalate landing's own
 * `FOR UPDATE` probe) matches zero rows, so the draft insert — and everything else already written
 * in that transaction — rolls back with it. Caught by the job, which records the lost race in a
 * fresh transaction under the action carried here: the two landings are told apart in the audit
 * trail, because one threw away a review draft and the other an escalation.
 */
export class LostRaceError extends Error {
  constructor(readonly auditAction: 'draft.propose_lost_race' | 'draft.escalate_lost_race' = 'draft.propose_lost_race') {
    super('ticket.draft: the ticket left `triaged` while the model call was in flight')
    this.name = 'LostRaceError'
  }
}

export interface OutcomeContext {
  db: Db
  orgId: string
  ticketId: string
  runId: string
  agentId: string
  /** The run's CLAIM-time clock: the day string, the escalation stamps and `expires_at` are all
   *  measured from it, so they agree with what the claim wrote. */
  now: Date
  /** A FRESH clock read taken just before the landing opens its transaction — the run's real finish
   *  instant. Using `now` here would make every `agent_runs` row report a zero-length run and
   *  `last_agent_finished_at` record when the run STARTED. */
  finishedAt: Date
  /** UTC day (YYYY-MM-DD) for the escalation notifications' dedupe keys. */
  day: string
  /** This run's thread snapshot — the message-time watermark `stampFinished` promotes. */
  threadSnapshotAt: Date | null
  usage: UsageTotals
  logger: pino.Logger
}

/**
 * Settles the `agent_runs` row. A `false` return means the backstop sweep aborted this run
 * underneath the job (its process looked gone): that is a warning, never a throw — the outcome the
 * job just committed is real and must stand.
 */
async function settleRun(tx: OrgTx, ctx: OutcomeContext, output: unknown): Promise<void> {
  const settled = await finishRun(tx, { runId: ctx.runId, status: 'succeeded', output, usage: ctx.usage, now: ctx.finishedAt })
  if (!settled) {
    ctx.logger.warn({ runId: ctx.runId, ticketId: ctx.ticketId }, 'ticket.draft: run was already settled by the backstop sweep')
  }
}

/**
 * Rule 11 — the model asked for a human. One transaction: the guarded escalation, the run row, the
 * finish watermarks. A lost race is NOT fatal here (nothing is anchored to a draft): the reference
 * audits it under its own action and still finalizes, so the stuck gate never re-runs a run that
 * did in fact finish.
 */
export async function applyEscalateOutcome(
  ctx: OutcomeContext,
  p: { escalateReason: string; rationale: string; detail: string },
): Promise<string | undefined> {
  return withOrg(ctx.db, ctx.orgId, async (tx) => {
    const { escalated, notificationId } = await escalateTicket(tx, {
      orgId: ctx.orgId, ticketId: ctx.ticketId, fromStatus: 'triaged', reason: 'agent_escalated',
      day: ctx.day, now: ctx.now, actor: `agent:${ctx.runId}`, auditAction: 'ticket.escalated',
      detail: { escalateReason: p.escalateReason, rationale: p.rationale, detail: p.detail },
    })
    if (!escalated) {
      await audit(tx, {
        actor: `agent:${ctx.runId}`, action: 'draft.escalate_lost_race', entityType: 'ticket', entityId: ctx.ticketId,
        detail: { escalateReason: p.escalateReason },
      })
    }
    await settleRun(tx, ctx, { outcome: 'escalate', reason: p.escalateReason, rationale: p.rationale })
    await stampFinished(tx, ctx.ticketId, ctx.threadSnapshotAt, ctx.finishedAt)
    return notificationId
  })
}

/**
 * Rule 12 — nothing here needs an answer.
 *
 * With owner feedback pending this is NOT a quiet no-op: the owner corrected a draft and the run
 * answered by doing nothing, which would otherwise sit in `triaged` forever (no new inbound to
 * re-select it, no draft for the orphan backstop to notice) and silently swallow the correction.
 * It escalates `redraft_unfulfilled` instead — `escalateTicket` clears the redraft cycle with it.
 *
 * Otherwise FR3 applies: an inbound that arrived BETWEEN this run's thread snapshot and now was
 * never seen by this decision, and `no_reply` is the one authoritative outcome with no other net —
 * it stamps a finish (so the stuck branch skips it) and stays `triaged` (so the new-inbound branch
 * compares against the claim stamp, which is newer than the message). Clearing the claim stamp
 * makes the next cycle treat it as new work, but ONLY when a newer inbound really exists, re-read
 * live at UPDATE time; a null snapshot fails CLOSED to the epoch, matching the draft row's own
 * epoch fallback.
 */
export async function applyNoReplyOutcome(
  ctx: OutcomeContext,
  p: { reason: string; rationale: string; ownerFeedbackPending: boolean },
): Promise<string | undefined> {
  return withOrg(ctx.db, ctx.orgId, async (tx) => {
    let notificationId: string | undefined
    if (p.ownerFeedbackPending) {
      const result = await escalateTicket(tx, {
        orgId: ctx.orgId, ticketId: ctx.ticketId, fromStatus: 'triaged', reason: 'redraft_unfulfilled',
        day: ctx.day, now: ctx.now, actor: `agent:${ctx.runId}`, auditAction: 'ticket.escalated',
        detail: { noReplyReason: p.reason, rationale: p.rationale },
      })
      notificationId = result.notificationId
    } else {
      await audit(tx, {
        actor: `agent:${ctx.runId}`, action: 'draft.no_reply', entityType: 'ticket', entityId: ctx.ticketId,
        detail: { reason: p.reason, rationale: p.rationale },
      })
      await tx
        .update(tickets)
        .set({ lastAgentRunAt: null })
        .where(and(
          eq(tickets.id, ctx.ticketId),
          eq(tickets.status, 'triaged'),
          gt(tickets.lastInboundAt, ctx.threadSnapshotAt ?? new Date(0)),
        ))
    }
    await settleRun(tx, ctx, { outcome: 'no_reply', reason: p.reason, rationale: p.rationale, redraftUnfulfilled: p.ownerFeedbackPending })
    await stampFinished(tx, ctx.ticketId, ctx.threadSnapshotAt, ctx.finishedAt)
    return notificationId
  })
}

/** Where a written draft leaves the ticket: the review queue, or an owner's hands with the body attached. */
export type DraftLanding =
  | { kind: 'review'; decisionReason: DecisionReason }
  /** `guardrail_failed` (the body is stored so the owner can edit it) and `category_off` (quiet). */
  | { kind: 'escalate'; reason: NeedsOwnerReason; decisionReason: DecisionReason; quiet: boolean }

/** Everything the `drafts` row carries that the model or the guardrails produced. */
export interface DraftRowInput {
  body: string
  categoryId: string | null
  categoryLabel: string
  confidence: number
  confidenceBreakdown: Record<string, unknown>
  guardrailResult: Record<string, unknown>
  retrievedChunkIds: string[]
  citedChunkIds: string[]
  retrievedAnswerIds: string[]
  usedAnswerIds: string[]
  memoryConflictIds: string[]
  rationale: string
  unresolvedQuestions: string[]
  customerLanguage: string
  isRedraft: boolean
  warnings: string[]
}

/** The push copy for a draft awaiting review: no customer identity, just what is waiting and how sure the model is. */
export function draftReviewCopy(categoryLabel: string, confidence: number, body: string): { title: string; body: string } {
  return { title: `Reply ready · ${categoryLabel} · ${Math.round(confidence * 100)}%`, body: body.slice(0, 140) }
}

/**
 * Rules 13/14 — a draft exists and is being stored. ONE transaction, in the reference's pinned
 * order: guarded transition → supersede → insert → notify → audit → settle → watermarks.
 *
 * The transition comes FIRST on the review path so a lost race throws before anything else is
 * written. On the escalate paths the draft has to exist before `escalateTicket` can put its id in
 * the notification payload, so the order there is insert → escalate; the `LostRaceError` rolls the
 * insert back either way, which is what makes the two orders equivalent.
 *
 * Superseding covers `pending` only: the ticket was `triaged` at the flip, so no approved/sending
 * draft can be live on it, and the one-live-draft partial unique would have refused the insert if
 * one were.
 */
export async function applyDraftOutcome(
  ctx: OutcomeContext,
  landing: DraftLanding,
  row: DraftRowInput,
): Promise<{ draftId: string; notificationId?: string }> {
  return withOrg(ctx.db, ctx.orgId, async (tx) => {
    // Global lock order (task 17 review ruling): `outbound_sends` → `drafts` → `tickets`, one order
    // across the worker and the api. This job never touches a send row, so the ticket's live drafts
    // are locked FIRST — by BOTH landings, before the review landing's flip and before the escalate
    // landing's probe — and the ticket statement below stays exactly what it was, the lost-race gate;
    // it simply runs second. Without this the two landings raced the api's `rejectDraft` /
    // `resolveTicket` (draft → ticket) in the opposite order and a pair could deadlock.
    await tx
      .select({ id: drafts.id })
      .from(drafts)
      .where(and(
        eq(drafts.orgId, ctx.orgId),
        eq(drafts.ticketId, ctx.ticketId),
        inArray(drafts.status, ['pending', 'approved', 'held', 'sending']),
      ))
      .for('update')

    if (landing.kind === 'review') {
      const flipped = await tx
        .update(tickets)
        .set({ status: 'awaiting_review' })
        .where(and(eq(tickets.id, ctx.ticketId), eq(tickets.status, 'triaged')))
        .returning({ id: tickets.id })
      if (flipped.length === 0) throw new LostRaceError('draft.propose_lost_race')
    } else {
      // The escalate landing cannot flip the ticket until the draft exists (its id rides the
      // notification payload), so it takes the SAME lock the review branch's UPDATE takes, in the
      // SAME place. Without this probe the two landings lock the ticket row and the one-live-draft
      // partial unique in opposite orders, and two concurrent runs on one ticket can deadlock.
      // It doubles as the lost-race guard: zero rows means an owner already moved the ticket.
      const locked = await tx
        .select({ id: tickets.id })
        .from(tickets)
        .where(and(eq(tickets.id, ctx.ticketId), eq(tickets.status, 'triaged')))
        .limit(1)
        .for('update')
      if (locked.length === 0) throw new LostRaceError('draft.escalate_lost_race')
    }

    const superseded = await tx
      .update(drafts)
      .set({ status: 'superseded' })
      .where(and(eq(drafts.ticketId, ctx.ticketId), eq(drafts.status, 'pending')))
      .returning({ id: drafts.id })
    for (const old of superseded) {
      await audit(tx, {
        actor: `agent:${ctx.runId}`, action: 'draft.superseded', entityType: 'draft', entityId: old.id,
        detail: { supersededByRunId: ctx.runId, ticketId: ctx.ticketId },
      })
    }

    const [priorCount] = await tx.select({ value: count() }).from(drafts).where(eq(drafts.ticketId, ctx.ticketId))
    const version = 1 + (priorCount?.value ?? 0)

    const [inserted] = await tx
      .insert(drafts)
      .values({
        orgId: ctx.orgId, ticketId: ctx.ticketId, agentId: ctx.agentId, agentRunId: ctx.runId,
        version, body: row.body, categoryId: row.categoryId,
        modelConfidence: row.confidence, confidence: row.confidence,
        confidenceBreakdown: row.confidenceBreakdown, guardrailResult: row.guardrailResult,
        decision: landing.kind === 'review' ? 'review' : 'escalate',
        decisionReason: landing.decisionReason,
        status: 'pending',
        retrievedChunkIds: row.retrievedChunkIds, citedChunkIds: row.citedChunkIds,
        retrievedAnswerIds: row.retrievedAnswerIds, usedAnswerIds: row.usedAnswerIds,
        memoryConflictIds: row.memoryConflictIds,
        rationale: row.rationale, unresolvedQuestions: row.unresolvedQuestions,
        customerLanguage: row.customerLanguage,
        // A ticket with no inbound yet has no snapshot. Fail CLOSED with the epoch rather than
        // `now`: every later inbound then reads as newer, so the send's staleness guard treats
        // such a draft as stale instead of waving it through.
        threadSnapshotAt: ctx.threadSnapshotAt ?? new Date(0),
        isRedraft: row.isRedraft,
        expiresAt: new Date(ctx.now.getTime() + DRAFT_EXPIRE_DAYS * 86_400_000),
      })
      .returning({ id: drafts.id })
    const draftId = inserted!.id

    let notificationId: string | undefined
    if (landing.kind === 'review') {
      const copy = draftReviewCopy(row.categoryLabel, row.confidence, row.body)
      const [push] = await tx
        .insert(notifications)
        .values({
          orgId: ctx.orgId, kind: 'draft_review', title: copy.title, body: copy.body,
          dedupeKey: `draft_review:${draftId}`, payload: { ticketId: ctx.ticketId, draftId },
        })
        .onConflictDoNothing({ target: notifications.dedupeKey })
        .returning({ id: notifications.id })
      notificationId = push?.id
    } else {
      const result = await escalateTicket(tx, {
        orgId: ctx.orgId, ticketId: ctx.ticketId, fromStatus: 'triaged', reason: landing.reason,
        day: ctx.day, now: ctx.now, quiet: landing.quiet, draftId,
        actor: `agent:${ctx.runId}`, auditAction: 'ticket.escalated',
        detail: { draftId, decisionReason: landing.decisionReason, warnings: row.warnings },
      })
      // Unreachable: the `FOR UPDATE` probe above holds this row's lock for the whole
      // transaction, so nothing can have moved it since. Kept as the belt on that brace.
      if (!result.escalated) throw new LostRaceError('draft.escalate_lost_race')
      notificationId = result.notificationId
    }

    await audit(tx, {
      actor: `agent:${ctx.runId}`, action: 'draft.created', entityType: 'ticket', entityId: ctx.ticketId,
      detail: {
        draftId, version, decision: landing.kind === 'review' ? 'review' : 'escalate',
        reason: landing.decisionReason, confidence: row.confidence, warnings: row.warnings,
        isRedraft: row.isRedraft, usage: { ...ctx.usage },
      },
    })
    await settleRun(tx, ctx, { outcome: 'reply', draftId, decision: landing.kind === 'review' ? 'review' : 'escalate' })
    await stampFinished(tx, ctx.ticketId, ctx.threadSnapshotAt, ctx.finishedAt)

    return notificationId === undefined ? { draftId } : { draftId, notificationId }
  })
}

/**
 * The `LostRaceError` landing: a fresh transaction (the one that threw is gone), recording that a
 * paid-for run threw its draft away, and still finalizing — the run DID finish, and leaving it
 * unfinished would have the stuck gate re-run it on a timer.
 */
export async function recordLostRace(ctx: OutcomeContext, action: LostRaceError['auditAction']): Promise<void> {
  await withOrg(ctx.db, ctx.orgId, async (tx) => {
    await audit(tx, {
      actor: `agent:${ctx.runId}`, action, entityType: 'ticket', entityId: ctx.ticketId,
      detail: { runId: ctx.runId },
    })
    await settleRun(tx, ctx, { lostRace: true })
    await stampFinished(tx, ctx.ticketId, ctx.threadSnapshotAt, ctx.finishedAt)
  })
}
