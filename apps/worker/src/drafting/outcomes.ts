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
import type { DecisionReason, DraftStatus, NeedsOwnerReason } from '@aesa/contracts'
import { DRAFT_EXPIRE_DAYS } from '@aesa/contracts'
import { draftTransitions, outboundSendTransitions, ticketTransitions } from '@aesa/core'
import {
  audit, drafts, escalateTicket, notifications, outboundSends, resolvedAnswers, tickets, withOrg,
  type AuditActor, type Db, type OrgTx,
} from '@aesa/db'
import { stampFinished } from './claim.ts'
import { finishRun } from './runs.ts'

/** This job's own audit/escalation identity for rows that are not attributable to a run. */
export const DRAFT_ACTOR: AuditActor = 'system:ticket.draft'

/** The four statuses `drafts_live_per_ticket_uidx` (migration 0011) treats as live. */
const LIVE_DRAFT_STATUSES = ['pending', 'approved', 'held', 'sending'] as const

/**
 * What a new run RETIRES before inserting its own draft, and what each becomes — the same table the
 * api's "Mark resolved" uses, and for the same reason: every one of these occupies the ticket's one
 * live-draft slot, so leaving one behind turns the INSERT below into a raw 23505 (fix wave W10 /
 * final-A1 M2). `held → expired` rather than `superseded` because that is the edge the draft matrix
 * actually has.
 *
 * `sending` is deliberately absent: a reply is in flight and only `send.execute` may decide what
 * happened to it. It cannot coexist with a `triaged` ticket today (both of that job's landings move
 * the draft out of `sending` in the same transaction that hands the ticket back), so the INSERT is
 * still safe — and if it ever could, a lost race is the honest outcome, not a stolen send.
 */
const DRAFT_RETIREMENT = { pending: 'superseded', approved: 'superseded', held: 'expired' } as const
type RetirableDraftStatus = keyof typeof DRAFT_RETIREMENT
const RETIRABLE_DRAFT_STATUSES = Object.keys(DRAFT_RETIREMENT) as RetirableDraftStatus[]

/** The send statuses a retirement pulls back, exactly as `resolveTicket` does: `claimed` too, since
 *  `send.execute`'s pre-send flip re-checks both rows and backs off when either has moved. */
const HOLDABLE_SEND_STATUSES = ['queued', 'claimed'] as const
const SUPERSEDED_SEND_ERROR = 'held:superseded_by_redraft'

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

/**
 * Where a written draft leaves the ticket: the review queue, an owner's hands with the body
 * attached, or — Phase 5 — straight out to the customer after the agent's hold window.
 */
export type DraftLanding =
  | { kind: 'review'; decisionReason: DecisionReason }
  /** `guardrail_failed` (the body is stored so the owner can edit it) and `category_off` (quiet). */
  | { kind: 'escalate'; reason: NeedsOwnerReason; decisionReason: DecisionReason; quiet: boolean }
  /**
   * `decide()` answered `send`. The draft is stored ALREADY approved (`final_body` = the screened
   * model body, `decision_source: 'auto'`, no `decided_by`) beside a `queued` send row due
   * `delayMin` minutes out, and the ticket goes to `auto_sending` — the window in which the owner
   * can still Hold it. `pushAutoSends` is the org's `notifications.push_auto_sends` setting.
   */
  | { kind: 'auto'; decisionReason: DecisionReason; sendAfter: Date; delayMin: number; pushAutoSends: boolean }

/** The `drafts.decision` value (and the audit/run-output word) each landing writes. */
function decisionWord(landing: DraftLanding): 'send' | 'review' | 'escalate' {
  return landing.kind === 'auto' ? 'send' : landing.kind === 'review' ? 'review' : 'escalate'
}

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
 * The transition comes FIRST on the review AND the auto path so a lost race throws before anything
 * else is written. On the escalate paths the draft has to exist before `escalateTicket` can put its
 * id in the notification payload, so the order there is insert → escalate; the `LostRaceError` rolls
 * the insert back either way, which is what makes the two orders equivalent.
 *
 * The auto landing writes one more row than the other two: the `outbound_sends` ledger row the
 * `send.execute` job will claim once the hold window elapses. It goes in AFTER the draft insert,
 * matching the api's `approveDraft` — it is a brand-new row, so the global lock order
 * (`outbound_sends → drafts → tickets`) cannot be inverted by it.
 *
 * Superseding covers every live status except `sending` (`DRAFT_RETIREMENT`). `pending` is the
 * ordinary case; `approved` became reachable when `drafts.resume` gave a `failed` draft a way back
 * (fix wave A3) — resume + re-approve on a ticket `landStale` had already handed back to `triaged`
 * leaves an approved draft and a queued send beside a re-draftable ticket. Its send row is held in
 * the same transaction: the reply the owner approved answers a thread that has since moved on.
 */
export async function applyDraftOutcome(
  ctx: OutcomeContext,
  landing: DraftLanding,
  row: DraftRowInput,
): Promise<{ draftId: string; notificationId?: string; sendId?: string }> {
  return withOrg(ctx.db, ctx.orgId, async (tx) => {
    // Global lock order (task 17 review ruling): `outbound_sends` → `drafts` → `tickets`, one order
    // across the worker and the api. The ticket's live drafts are locked BEFORE the ticket — by BOTH
    // landings, before the review landing's flip and before the escalate landing's probe — and the
    // ticket statement below stays exactly what it was, the lost-race gate; it simply runs second.
    // Without this the two landings raced the api's `rejectDraft` / `resolveTicket` (draft → ticket)
    // in the opposite order and a pair could deadlock.
    // The send rows go FIRST, found through a subquery so no draft row is read (let alone locked)
    // before them — the retirement below may hold one, and the api's `resolveTicket` takes the same
    // three tables in the same order (fix wave W10).
    await tx
      .select({ id: outboundSends.id })
      .from(outboundSends)
      .where(and(
        eq(outboundSends.orgId, ctx.orgId),
        inArray(outboundSends.draftId, tx.select({ id: drafts.id })
          .from(drafts)
          .where(and(eq(drafts.orgId, ctx.orgId), eq(drafts.ticketId, ctx.ticketId), inArray(drafts.status, RETIRABLE_DRAFT_STATUSES)))),
      ))
      .for('update')

    const live = await tx
      .select({ id: drafts.id, status: drafts.status })
      .from(drafts)
      .where(and(
        eq(drafts.orgId, ctx.orgId),
        eq(drafts.ticketId, ctx.ticketId),
        inArray(drafts.status, LIVE_DRAFT_STATUSES),
      ))
      .for('update')

    if (landing.kind === 'review' || landing.kind === 'auto') {
      // The auto landing parks the ticket on `auto_sending` — the hold window, in which the owner
      // can still pull the reply back — instead of the review queue. Both edges are guarded on
      // `triaged`, so an owner action during the model call still wins the race.
      const to = landing.kind === 'auto' ? 'auto_sending' : 'awaiting_review'
      ticketTransitions.assert('triaged', to)
      const flipped = await tx
        .update(tickets)
        .set({ status: to })
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

    for (const old of live) {
      if (!RETIRABLE_DRAFT_STATUSES.includes(old.status as RetirableDraftStatus)) continue
      const from = old.status as RetirableDraftStatus
      const to: DraftStatus = DRAFT_RETIREMENT[from]
      draftTransitions.assert(from, to)
      const retired = await tx
        .update(drafts)
        .set({ status: to })
        .where(and(eq(drafts.id, old.id), eq(drafts.status, from)))
        .returning({ id: drafts.id })
      if (retired.length === 0) continue
      // A `pending` draft never has a send row; an `approved` or `held` one does, and it is locked
      // (first, by the statement above this transaction's ticket work) before we touch it.
      for (const from of HOLDABLE_SEND_STATUSES) outboundSendTransitions.assert(from, 'held')
      await tx
        .update(outboundSends)
        .set({ status: 'held', lastError: SUPERSEDED_SEND_ERROR })
        .where(and(eq(outboundSends.draftId, old.id), inArray(outboundSends.status, [...HOLDABLE_SEND_STATUSES])))
      await audit(tx, {
        actor: `agent:${ctx.runId}`, action: to === 'superseded' ? 'draft.superseded' : 'draft.expired',
        entityType: 'draft', entityId: old.id,
        detail: { supersededByRunId: ctx.runId, ticketId: ctx.ticketId, from },
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
        decision: decisionWord(landing),
        decisionReason: landing.decisionReason,
        // The auto landing IS the decision: the draft is stored already approved, with the screened
        // body as its `final_body` (nobody will edit it) and no `decided_by`/`viewed_at` — nobody
        // looked. `auto_decided_at` is the durable mark that survives a Hold + re-approve, which
        // rewrites `decision_source` to `app`.
        ...(landing.kind === 'auto'
          ? {
              status: 'approved' as const, finalBody: row.body, decisionSource: 'auto',
              decidedAt: ctx.finishedAt, autoDecidedAt: ctx.finishedAt,
            }
          : { status: 'pending' as const }),
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

    // Deviation 8: an answer the model says contradicts the guidance goes to the owner's Verify list
    // NOW, on every landing kind — even one that is then rejected. The ids were already filtered
    // against what retrieval returned; a chunk id in that list simply matches no answer row, and the
    // `status = 'active'` guard makes a second run's repeat flag a no-op.
    if (row.memoryConflictIds.length > 0) {
      await tx
        .update(resolvedAnswers)
        .set({ status: 'needs_review', reviewReason: 'model_conflict' })
        .where(and(
          eq(resolvedAnswers.orgId, ctx.orgId),
          inArray(resolvedAnswers.id, row.memoryConflictIds),
          eq(resolvedAnswers.status, 'active'),
        ))
    }

    let notificationId: string | undefined
    let sendId: string | undefined
    if (landing.kind === 'auto') {
      // The ticket row is already locked by this transaction's own flip, so this read cannot race;
      // the send row is NEW, so inserting it after the draft cannot invert the global lock order.
      const [connection] = await tx
        .select({ connectionId: tickets.connectionId })
        .from(tickets)
        .where(eq(tickets.id, ctx.ticketId))
      const [send] = await tx
        .insert(outboundSends)
        .values({
          orgId: ctx.orgId, draftId, ticketId: ctx.ticketId, connectionId: connection!.connectionId,
          agentId: ctx.agentId, status: 'queued', sendAfter: landing.sendAfter,
        })
        .returning({ id: outboundSends.id })
      sendId = send!.id
      // Off by default (`notifications.push_auto_sends`): an owner who trusts Autopilot does not
      // want a push per reply. When it IS on, the page is the Hold button's only doorway.
      if (landing.pushAutoSends) {
        const [push] = await tx
          .insert(notifications)
          .values({
            orgId: ctx.orgId, kind: 'auto_send',
            title: `Auto-sending in ${landing.delayMin} min · ${row.categoryLabel} · ${Math.round(row.confidence * 100)}%`,
            body: row.body.slice(0, 140),
            dedupeKey: `auto_send:${draftId}`, payload: { ticketId: ctx.ticketId, draftId },
          })
          .onConflictDoNothing({ target: notifications.dedupeKey })
          .returning({ id: notifications.id })
        notificationId = push?.id
      }
    } else if (landing.kind === 'review') {
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
        draftId, version, decision: decisionWord(landing),
        reason: landing.decisionReason, confidence: row.confidence, warnings: row.warnings,
        isRedraft: row.isRedraft, usage: { ...ctx.usage },
      },
    })
    await settleRun(tx, ctx, { outcome: 'reply', draftId, decision: decisionWord(landing) })
    await stampFinished(tx, ctx.ticketId, ctx.threadSnapshotAt, ctx.finishedAt)

    return {
      draftId,
      ...(notificationId === undefined ? {} : { notificationId }),
      ...(sendId === undefined ? {} : { sendId }),
    }
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
