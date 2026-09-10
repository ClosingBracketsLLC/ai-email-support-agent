/**
 * Every owner decision on a draft — approve (with the 15-second undo window), hold, resume, reject,
 * mark viewed, resolve the ticket — as ONE implementation behind two surfaces: the `drafts` tRPC
 * router (the app) and Task 19's session-less `/a/:draftId?t=` review pages (the review email). The
 * two must never drift: the same guardrail gate, the same guarded transitions, the same audit rows.
 *
 * Discipline every function here keeps:
 *  - one `withOrg` transaction per call, holding no network I/O (the app role has a 5 s
 *    idle-in-transaction timeout);
 *  - every write guarded on the status it was read at, so a concurrent owner, sweep or send job
 *    that got there first simply wins and this call reports the soft outcome;
 *  - `enqueue` only AFTER the transaction commits, and a null job id is logged, never thrown — the
 *    worker's backstop sweep rescues a lost send.
 *
 * LOCK ORDER — one global order across the api AND the worker (controller ruling, task 17 review):
 * **`outbound_sends` → `drafts` → `tickets`**, which is what every `send.execute` path already takes
 * (claim, the pre-send flip, `completeSend`, the stale/terminal landings). So:
 *  - `approveDraft` locks the draft's existing send row (when there is one) BEFORE the draft — its
 *    `INSERT … ON CONFLICT (draft_id) DO UPDATE … WHERE` locks the conflicting tuple before it ever
 *    evaluates that `WHERE`, so taking it last would invert the order against `holdDraft` and
 *    deadlock a tap-Approve-then-Undo;
 *  - `holdDraft` takes the send row, then the draft;
 *  - `resolveTicket` takes the live draft's send row, then the draft, then the ticket;
 *  - `rejectDraft` takes the draft, then the ticket.
 * The worker's `applyDraftOutcome` locks the ticket's live drafts before its ticket flip for the
 * same reason.
 */
import { and, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm'
import type pino from 'pino'
import { APPROVE_UNDO_SECONDS, OUTBOUND_SEND_STATUSES, type DraftStatus, type OutboundSendStatus, type RejectAction } from '@aesa/contracts'
import {
  buildWorkspacePolicy, clearRedraftCycle, draftTransitions, outboundSendTransitions, resolveRejectAction, validateReplyBody,
  type GuardrailFinding,
} from '@aesa/core'
import {
  agents, audit, categories, draftActionTokens, drafts, escalateTicket, outboundSends, tickets, workspaces,
  type AuditActor, type OrgTx,
} from '@aesa/db'
import { JOB_NAMES } from '@aesa/queue'
import type { ApiFacade, EnqueueFn } from '../deps.ts'

/** Who is deciding, and through which surface — `source` is what the viewed-before-approve rule keys off. */
export interface DraftActor {
  userId: string
  actor: AuditActor
  source: 'app' | 'email'
  ip?: string | null
  userAgent?: string | null
}

export interface DraftServiceDeps {
  api: ApiFacade
  enqueue: EnqueueFn
  logger: pino.Logger
  /** Test seam; production leaves it unset and reads the wall clock per call. */
  now?: () => Date
}

export type ApproveResult =
  | { ok: true; sendId: string; sendAfter: Date; edited: boolean }
  | { ok: false; code: 'not_found' | 'not_pending' | 'not_viewed' | 'agent_disabled' | 'kill_switch' | 'guardrail'; findings?: GuardrailFinding[] }

export type RejectResolution = 'redraft' | 'escalate_terminal' | 'escalate_limit'

/** The parsed `RejectDraftInput` — contracts exports the zod schema; this is the shape it parses to. */
export interface RejectInput {
  draftId: string
  action: RejectAction
  reason: string
}

/** The draft statuses the one-live-draft partial unique covers (migration 0011). */
export const LIVE_DRAFT_STATUSES = ['pending', 'approved', 'held', 'sending'] as const

/** The live-draft statuses `resolveTicket` may supersede (the two the draft matrix allows). */
const SUPERSEDABLE_DRAFT_STATUSES = ['pending', 'approved'] as const

/** The ticket statuses an owner may resolve from (spec: To review and its two neighbours). */
const RESOLVABLE_TICKET_STATUSES = ['needs_owner', 'awaiting_review', 'triaged'] as const

/** Straight from the send matrix: the states a re-approve may revive on the SAME ledger row. */
const REQUEUEABLE_SEND_STATUSES = OUTBOUND_SEND_STATUSES.filter((s) => outboundSendTransitions.can(s, 'queued'))

const clock = (deps: DraftServiceDeps): Date => deps.now?.() ?? new Date()
const utcDay = (now: Date): string => now.toISOString().slice(0, 10)

/** Postgres `deadlock_detected`. */
const DEADLOCK_SQLSTATE = '40P01'

/** The SQLSTATE arrives on the pg error, which drizzle wraps — `DrizzleQueryError.cause` is the
 * original, and Postgres errors can nest one further, so walk a bounded chain. */
function isDeadlock(error: unknown): boolean {
  let current: unknown = error
  for (let depth = 0; depth < 5 && typeof current === 'object' && current !== null; depth++) {
    if ((current as { code?: unknown }).code === DEADLOCK_SQLSTATE) return true
    current = (current as { cause?: unknown }).cause
  }
  return false
}

/**
 * Re-runs a whole transaction once when Postgres picks it as a deadlock victim.
 *
 * The three functions that touch two of the three row kinds all take them in the global order
 * (`outbound_sends` → `drafts` → `tickets`), which removes every ordinary inversion — but one narrow
 * three-way window survives it: a send row created by an approve that commits WHILE `resolveTicket`
 * waits on the draft lock cannot have been locked by resolve's first statement, so a `holdDraft` or a
 * second `approveDraft` that grabbed that send row and is now waiting on the draft can deadlock with
 * it. Postgres detects that in milliseconds and aborts one side with `40P01`; the aborted transaction
 * has rolled back WHOLE, and every body here is a fresh set of reads plus status-guarded writes, so
 * re-running it is safe and idempotent — the retry sees the world the winner left and returns the
 * ordinary soft outcome (`not_pending`, `too_late`, `false`) instead of a masked 500 on a button.
 *
 * Deliberately narrow: only `40P01`, only one extra attempt, and never around anything but a single
 * `withOrg` call (no enqueue, no I/O, is inside).
 */
export async function withDeadlockRetry<T>(fn: () => Promise<T>, opts: { attempts?: number } = {}): Promise<T> {
  const attempts = Math.max(1, opts.attempts ?? 2)
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn()
    } catch (error) {
      if (attempt >= attempts || !isDeadlock(error)) throw error
    }
  }
}

// ---------------------------------------------------------------------------
// The draft view (the app's review panel, and `inbox.ticket`)
// ---------------------------------------------------------------------------

export interface DraftSendView {
  id: string
  status: OutboundSendStatus
  sendAfter: Date
  sentAt: Date | null
  /** Why a send is on hold or failed (`held:workspace_kill_switch`, `reauth_required`, …) — the app
   * turns it into the held banner's words. Never a customer body, never a secret. */
  lastError: string | null
}

export interface DraftView {
  id: string
  ticketId: string
  version: number
  status: DraftStatus
  /** The model's own (normalized) body — what the editor opens with. */
  body: string
  /** What was approved, edited or not; the send reads THIS. Null until a decision. */
  finalBody: string | null
  decision: string
  decisionReason: string
  confidence: number | null
  confidenceBreakdown: Record<string, unknown>
  guardrailResult: Record<string, unknown>
  rationale: string | null
  unresolvedQuestions: string[]
  customerLanguage: string | null
  isRedraft: boolean
  viewedAt: Date | null
  decidedAt: Date | null
  decisionSource: string | null
  rejectReason: string | null
  editDistanceRatio: number | null
  expiresAt: Date
  createdAt: Date
  agentAddress: string | null
  categoryLabel: string | null
  send: DraftSendView | null
  /** The instant the undo window closes — set only while the approved draft's send is still queued. */
  undoUntil: Date | null
}

const draftViewColumns = {
  id: drafts.id, ticketId: drafts.ticketId, version: drafts.version, status: drafts.status, body: drafts.body,
  finalBody: drafts.finalBody, decision: drafts.decision, decisionReason: drafts.decisionReason, confidence: drafts.confidence,
  confidenceBreakdown: drafts.confidenceBreakdown, guardrailResult: drafts.guardrailResult, rationale: drafts.rationale,
  unresolvedQuestions: drafts.unresolvedQuestions, customerLanguage: drafts.customerLanguage, isRedraft: drafts.isRedraft,
  viewedAt: drafts.viewedAt, decidedAt: drafts.decidedAt, decisionSource: drafts.decisionSource, rejectReason: drafts.rejectReason,
  editDistanceRatio: drafts.editDistanceRatio, expiresAt: drafts.expiresAt, createdAt: drafts.createdAt,
  agentAddress: agents.address, categoryLabel: categories.label,
  sendId: outboundSends.id, sendStatus: outboundSends.status, sendAfter: outboundSends.sendAfter,
  sentAt: outboundSends.sentAt, sendLastError: outboundSends.lastError,
}

/** ONE query behind both loaders: the draft, its agent address, its category label and its (single) send row. */
function draftViewQuery(tx: OrgTx, orgId: string, predicate: SQL) {
  return tx.select(draftViewColumns)
    .from(drafts)
    .leftJoin(agents, eq(agents.id, drafts.agentId))
    .leftJoin(categories, eq(categories.id, drafts.categoryId))
    .leftJoin(outboundSends, eq(outboundSends.draftId, drafts.id))
    .where(and(eq(drafts.orgId, orgId), predicate))
    .limit(1)
}

type DraftViewRow = Awaited<ReturnType<typeof draftViewQuery>>[number]

function toDraftView(row: DraftViewRow): DraftView {
  const send: DraftSendView | null = row.sendId
    ? { id: row.sendId, status: row.sendStatus as OutboundSendStatus, sendAfter: row.sendAfter!, sentAt: row.sentAt, lastError: row.sendLastError }
    : null
  const status = row.status as DraftStatus
  return {
    id: row.id, ticketId: row.ticketId, version: row.version, status, body: row.body, finalBody: row.finalBody,
    decision: row.decision, decisionReason: row.decisionReason, confidence: row.confidence,
    confidenceBreakdown: row.confidenceBreakdown as Record<string, unknown>,
    guardrailResult: row.guardrailResult as Record<string, unknown>,
    rationale: row.rationale, unresolvedQuestions: row.unresolvedQuestions, customerLanguage: row.customerLanguage,
    isRedraft: row.isRedraft, viewedAt: row.viewedAt, decidedAt: row.decidedAt, decisionSource: row.decisionSource,
    rejectReason: row.rejectReason, editDistanceRatio: row.editDistanceRatio, expiresAt: row.expiresAt, createdAt: row.createdAt,
    agentAddress: row.agentAddress, categoryLabel: row.categoryLabel, send,
    // The undo bar's clock: only an approved draft whose send is still queued can still be pulled back.
    undoUntil: status === 'approved' && send?.status === 'queued' ? send.sendAfter : null,
  }
}

export async function loadDraftView(tx: OrgTx, orgId: string, draftId: string): Promise<DraftView | null> {
  const [row] = await draftViewQuery(tx, orgId, eq(drafts.id, draftId))
  return row ? toDraftView(row) : null
}

/** The one live draft on a ticket (at most one, by the partial unique), or null. */
export async function loadLiveDraftView(tx: OrgTx, orgId: string, ticketId: string): Promise<DraftView | null> {
  const [row] = await draftViewQuery(tx, orgId, and(eq(drafts.ticketId, ticketId), inArray(drafts.status, [...LIVE_DRAFT_STATUSES]))!)
  return row ? toDraftView(row) : null
}

// ---------------------------------------------------------------------------
// approve
// ---------------------------------------------------------------------------

/**
 * The approve gate. One transaction: lock the draft, re-check the levers, screen the body that is
 * actually going out, flip `pending → approved`, put a `queued` send 15 seconds out and consume the
 * one-click token — then, after the commit, wake `send.execute` at exactly that instant.
 *
 * A refusal writes NOTHING (the token included): the owner can fix the edit and click again.
 */
export async function approveDraft(
  deps: DraftServiceDeps, orgId: string, input: { draftId: string; body?: string }, actor: DraftActor,
  opts?: { consumeTokenId?: string },
): Promise<ApproveResult> {
  const now = clock(deps)
  const outcome = await withDeadlockRetry(() => deps.api.withOrg(orgId, async (tx): Promise<ApproveResult> => {
    // Lock order `outbound_sends` → `drafts` → `tickets` (see this file's header): a no-op when this
    // draft has never been approved, and the lock the upsert below would otherwise take second.
    await tx.select({ id: outboundSends.id })
      .from(outboundSends)
      .where(and(eq(outboundSends.orgId, orgId), eq(outboundSends.draftId, input.draftId)))
      .limit(1)
      .for('update')

    const [draft] = await tx.select({
      id: drafts.id, ticketId: drafts.ticketId, agentId: drafts.agentId, status: drafts.status, body: drafts.body, viewedAt: drafts.viewedAt,
    }).from(drafts).where(and(eq(drafts.orgId, orgId), eq(drafts.id, input.draftId))).limit(1).for('update')
    if (!draft) return { ok: false, code: 'not_found' }
    if (draft.status !== 'pending') return { ok: false, code: 'not_pending' }

    // The email surface only ever gets here from the page that RENDERED the body, so the click is
    // itself the proof of a read; the app has to say so explicitly (Task 20 marks viewed on render).
    const viewedAt = draft.viewedAt ?? (actor.source === 'email' ? now : null)
    if (viewedAt === null) return { ok: false, code: 'not_viewed' }

    const [ticket] = await tx.select({ id: tickets.id, connectionId: tickets.connectionId, agentId: tickets.agentId })
      .from(tickets).where(and(eq(tickets.orgId, orgId), eq(tickets.id, draft.ticketId))).limit(1)
    if (!ticket) return { ok: false, code: 'not_found' }

    const [workspace] = await tx.select({
      killSwitch: workspaces.killSwitch, agentEnabled: workspaces.agentEnabled, allowedUrlHosts: workspaces.allowedUrlHosts,
      allowedEmailDomains: workspaces.allowedEmailDomains, contactPhone: workspaces.contactPhone, contactUrls: workspaces.contactUrls,
      locale: workspaces.locale,
    }).from(workspaces).where(eq(workspaces.orgId, orgId)).limit(1)
    if (!workspace) throw new Error(`approveDraft: org ${orgId} has no workspace row`)

    // The kill levers, in `send.execute`'s own order (its firstKillLever) — the send would refuse
    // anyway, so refusing here keeps the ticket in To review instead of parking a held send on it.
    if (workspace.killSwitch) return { ok: false, code: 'kill_switch' }
    if (!workspace.agentEnabled) return { ok: false, code: 'agent_disabled' }

    const agentId = draft.agentId ?? ticket.agentId
    const [agent] = agentId
      ? await tx.select({ id: agents.id, domain: agents.domain }).from(agents).where(and(eq(agents.orgId, orgId), eq(agents.id, agentId))).limit(1)
      : []
    // No agent row means no From address and no domain to allow: nothing can be sent, and "the agent
    // is not set up" is the truest of the six codes for it.
    if (!agent) return { ok: false, code: 'agent_disabled' }

    // The approve gate screens FAILS only: `trustedTexts: []` (an owner may legitimately paste the
    // workspace's own guidance wording into a reply) and no `groundedNumbers` (the owner is the
    // grounding). The draft gate already screened the model's own body against the full policy.
    const policy = buildWorkspacePolicy({
      workspace: {
        allowedUrlHosts: workspace.allowedUrlHosts, allowedEmailDomains: workspace.allowedEmailDomains,
        contactPhone: workspace.contactPhone, contactUrls: workspace.contactUrls, locale: workspace.locale,
      },
      agentDomain: agent.domain, trustedTexts: [], expectedLanguage: null,
    })
    const screened = validateReplyBody(input.body ?? draft.body, policy)
    if (!screened.ok) {
      // Warnings never block, so only the failures are the reasons for this refusal.
      return { ok: false, code: 'guardrail', findings: screened.findings.filter((f) => f.severity === 'fail') }
    }

    const finalBody = screened.normalizedBody
    const editDistanceRatio = input.body === undefined ? 0 : levenshteinRatio(finalBody, draft.body)
    const edited = editDistanceRatio > 0

    draftTransitions.assert('pending', 'approved')
    const approved = await tx.update(drafts)
      .set({
        status: 'approved', finalBody, decidedBy: actor.userId, decidedAt: now, decisionSource: actor.source,
        editDistanceRatio, viewedAt,
      })
      .where(and(eq(drafts.id, draft.id), eq(drafts.status, 'pending')))
      .returning({ id: drafts.id })
    if (approved.length === 0) return { ok: false, code: 'not_pending' }

    // ONE ledger row per draft (the unique on draft_id). A re-approve after an undo or a failed
    // attempt revives that row instead of stacking a second one — and only from the two states the
    // send matrix allows back to `queued`, so a claimed or already sent delivery can never be reset.
    const sendAfter = new Date(now.getTime() + APPROVE_UNDO_SECONDS * 1000)
    const [send] = await tx.insert(outboundSends)
      .values({ orgId, draftId: draft.id, ticketId: ticket.id, connectionId: ticket.connectionId, agentId: agent.id, status: 'queued', sendAfter })
      .onConflictDoUpdate({
        target: outboundSends.draftId,
        set: { status: 'queued', sendAfter, attempts: 0, claimedAt: null, claimExpiresAt: null, claimToken: null, lastError: null, updatedAt: now },
        setWhere: inArray(outboundSends.status, [...REQUEUEABLE_SEND_STATUSES]),
      })
      .returning({ id: outboundSends.id })
    // Zero rows means the existing ledger row is claimed/sent/queued while its draft was still
    // `pending` — an impossible pairing, so refuse loudly and roll the approval back.
    if (!send) throw new Error(`approveDraft: draft ${draft.id} already has a live outbound send`)

    await consumeActionToken(tx, opts?.consumeTokenId, now)

    await audit(tx, {
      actor: actor.actor, action: 'draft.approved', entityType: 'draft', entityId: draft.id,
      detail: { draftId: draft.id, ticketId: ticket.id, edited, editDistanceRatio, source: actor.source },
      ip: actor.ip, userAgent: actor.userAgent,
    })
    return { ok: true, sendId: send.id, sendAfter, edited }
  }))

  if (outcome.ok) {
    const jobId = await deps.enqueue(
      JOB_NAMES.sendExecute, { orgId, sendId: outcome.sendId }, { entityId: outcome.sendId, startAfter: outcome.sendAfter },
    )
    if (jobId === null) {
      deps.logger.warn({ orgId, sendId: outcome.sendId }, 'send.execute enqueue returned no job id; the backstop due-send sweep will pick it up')
    }
  }
  return outcome
}

/**
 * The single-use one-click token, consumed in the SAME transaction as the decision it authorized.
 * Zero rows means someone else already used it: throw, so the whole decision rolls back and the
 * caller renders the friendly page rather than acting twice.
 */
async function consumeActionToken(tx: OrgTx, tokenId: string | undefined, now: Date): Promise<void> {
  if (!tokenId) return
  const consumed = await tx.update(draftActionTokens)
    .set({ consumedAt: now })
    .where(and(eq(draftActionTokens.id, tokenId), isNull(draftActionTokens.consumedAt)))
    .returning({ id: draftActionTokens.id })
  if (consumed.length === 0) throw new Error('draft action token was already consumed')
}

// ---------------------------------------------------------------------------
// hold (Undo) and resume
// ---------------------------------------------------------------------------

/**
 * Undo IS hold: inside the 15-second window the queued send goes `held` and the draft comes back to
 * `pending`, so the ticket is in To review again with nothing sent. (Phase 5's auto-send Hold button
 * is the same call.) Past the claim it is `too_late` — the reply is already going out.
 *
 * The approval's own trail (`decided_by`/`decided_at`/`final_body`) is deliberately left on the row:
 * the audit log records the approve and the hold, and the owner's edit survives for a re-approve.
 */
export async function holdDraft(
  deps: DraftServiceDeps, orgId: string, draftId: string, actor: DraftActor, opts?: { consumeTokenId?: string },
): Promise<{ ok: true } | { ok: false; code: 'not_found' | 'not_holdable' | 'too_late' }> {
  const now = clock(deps)
  return withDeadlockRetry(() => deps.api.withOrg(orgId, async (tx) => {
    // Send row first: `send.execute` claims it before it touches the draft, and the undo races
    // exactly that claim — locking in the other order is how the two would deadlock.
    const [send] = await tx.select({ id: outboundSends.id, status: outboundSends.status })
      .from(outboundSends).where(and(eq(outboundSends.orgId, orgId), eq(outboundSends.draftId, draftId))).limit(1).for('update')
    const [draft] = await tx.select({ id: drafts.id, ticketId: drafts.ticketId, status: drafts.status })
      .from(drafts).where(and(eq(drafts.orgId, orgId), eq(drafts.id, draftId))).limit(1).for('update')
    if (!draft) return { ok: false, code: 'not_found' }
    if (draft.status !== 'approved') return { ok: false, code: 'not_holdable' }
    if (!send) return { ok: false, code: 'not_holdable' }
    if (send.status === 'claimed' || send.status === 'sent') return { ok: false, code: 'too_late' }
    if (send.status !== 'queued') return { ok: false, code: 'not_holdable' }

    outboundSendTransitions.assert('queued', 'held')
    const held = await tx.update(outboundSends)
      .set({ status: 'held' })
      .where(and(eq(outboundSends.id, send.id), eq(outboundSends.status, 'queued')))
      .returning({ id: outboundSends.id })
    if (held.length === 0) return { ok: false, code: 'too_late' }

    // approved → held → pending, both legs guarded and both in the matrix: there is no
    // approved → pending edge, and inventing one would let the two state machines drift.
    draftTransitions.assert('approved', 'held')
    await tx.update(drafts).set({ status: 'held' }).where(and(eq(drafts.id, draft.id), eq(drafts.status, 'approved')))
    draftTransitions.assert('held', 'pending')
    await tx.update(drafts).set({ status: 'pending' }).where(and(eq(drafts.id, draft.id), eq(drafts.status, 'held')))

    await consumeActionToken(tx, opts?.consumeTokenId, now)
    await audit(tx, {
      actor: actor.actor, action: 'draft.held', entityType: 'draft', entityId: draft.id,
      detail: { draftId: draft.id, ticketId: draft.ticketId, sendId: send.id, source: actor.source },
      ip: actor.ip, userAgent: actor.userAgent,
    })
    return { ok: true }
  }))
}

/**
 * The way back for a draft `send.execute` parked on `held` (a kill lever, a mailbox that needs
 * re-authing): `held → pending` puts it in To review again. The send row stays `held` on purpose —
 * the next approve revives that same ledger row through `approveDraft`'s ON CONFLICT path, so the
 * delivery keeps its history (attempts, provider ids) instead of starting a second one.
 */
export async function resumeDraft(
  deps: DraftServiceDeps, orgId: string, draftId: string, actor: DraftActor,
): Promise<{ ok: true } | { ok: false; code: 'not_found' | 'not_held' }> {
  return deps.api.withOrg(orgId, async (tx) => {
    const [draft] = await tx.select({ id: drafts.id, ticketId: drafts.ticketId, status: drafts.status })
      .from(drafts).where(and(eq(drafts.orgId, orgId), eq(drafts.id, draftId))).limit(1).for('update')
    if (!draft) return { ok: false, code: 'not_found' }
    if (draft.status !== 'held') return { ok: false, code: 'not_held' }

    draftTransitions.assert('held', 'pending')
    const resumed = await tx.update(drafts)
      .set({ status: 'pending' })
      .where(and(eq(drafts.id, draft.id), eq(drafts.status, 'held')))
      .returning({ id: drafts.id })
    if (resumed.length === 0) return { ok: false, code: 'not_held' }

    await audit(tx, {
      actor: actor.actor, action: 'draft.resumed', entityType: 'draft', entityId: draft.id,
      detail: { draftId: draft.id, ticketId: draft.ticketId, source: actor.source },
      ip: actor.ip, userAgent: actor.userAgent,
    })
    return { ok: true }
  })
}

// ---------------------------------------------------------------------------
// reject
// ---------------------------------------------------------------------------

/**
 * Reject, with the three resolutions `resolveRejectAction` decides between (blank reason → the owner
 * is taking over; at the cap → page them; otherwise → re-draft with their feedback). The draft is
 * always rejected; what happens to the TICKET is the resolution.
 */
export async function rejectDraft(
  deps: DraftServiceDeps, orgId: string, input: RejectInput, actor: DraftActor,
): Promise<{ ok: true; resolution: RejectResolution } | { ok: false; code: 'not_found' | 'not_pending' }> {
  const now = clock(deps)
  const day = utcDay(now)
  type Outcome =
    | { ok: true; resolution: RejectResolution; redraftTicketId?: string; notificationId?: string }
    | { ok: false; code: 'not_found' | 'not_pending' }

  const outcome = await deps.api.withOrg(orgId, async (tx): Promise<Outcome> => {
    const [draft] = await tx.select({ id: drafts.id, ticketId: drafts.ticketId, status: drafts.status })
      .from(drafts).where(and(eq(drafts.orgId, orgId), eq(drafts.id, input.draftId))).limit(1).for('update')
    if (!draft) return { ok: false, code: 'not_found' }
    if (draft.status !== 'pending') return { ok: false, code: 'not_pending' }

    const [ticket] = await tx.select({ id: tickets.id, status: tickets.status, redraftCount: tickets.redraftCount })
      .from(tickets).where(and(eq(tickets.orgId, orgId), eq(tickets.id, draft.ticketId))).limit(1)
    if (!ticket) return { ok: false, code: 'not_found' }

    const resolution = resolveRejectAction({
      reason: input.reason, action: input.action, redraftCount: ticket.redraftCount, ticketStatus: ticket.status,
    })

    draftTransitions.assert('pending', 'rejected')
    const rejected = await tx.update(drafts)
      .set({
        status: 'rejected', rejectReason: input.reason, rejectAction: input.action,
        decidedBy: actor.userId, decidedAt: now, decisionSource: actor.source,
      })
      .where(and(eq(drafts.id, draft.id), eq(drafts.status, 'pending')))
      .returning({ id: drafts.id })
    if (rejected.length === 0) return { ok: false, code: 'not_pending' }

    if (resolution.kind === 'redraft') {
      // `last_agent_prompted_at` is deliberately kept: it is the per-day run cap's own stamp, and a
      // re-draft must not buy the ticket a fresh day of model runs.
      const moved = await tx.update(tickets)
        .set({
          status: 'triaged', ownerRedraftFeedback: input.reason, redraftCount: sql`${tickets.redraftCount} + 1`,
          agentFailureCount: 0, lastAgentRunAt: null, lastAgentFinishedAt: null,
        })
        .where(and(eq(tickets.id, ticket.id), eq(tickets.status, 'awaiting_review')))
        .returning({ redraftCount: tickets.redraftCount })
      const flipped = moved[0]
      if (flipped) {
        await audit(tx, {
          actor: actor.actor, action: 'draft.rejected_for_redraft', entityType: 'draft', entityId: draft.id,
          detail: { draftId: draft.id, ticketId: ticket.id, reasonLen: input.reason.length, redraftCount: flipped.redraftCount },
          ip: actor.ip, userAgent: actor.userAgent,
        })
        return { ok: true, resolution: 'redraft', redraftTicketId: ticket.id }
      }
      // Zero rows: the ticket left `awaiting_review` between the read and the flip. Fall through to
      // the terminal escalation IN THIS TRANSACTION — a rejected draft may never be left dangling.
    }

    const atLimit = resolution.kind === 'escalate_limit'
    // `awaiting_review` is the ONLY status a reject may escalate from: it is where a ticket with a
    // live draft sits. Re-read under READ COMMITTED (a fresh snapshot per statement) — anything else
    // means a concurrent writer already moved the ticket somewhere it owns (`resolved`, a fresh
    // `triaged` cycle, an escalation of its own), and re-escalating that would undo their work, so
    // the reject stops at the rejected draft (review Minor 5).
    const [current] = await tx.select({ status: tickets.status })
      .from(tickets).where(and(eq(tickets.orgId, orgId), eq(tickets.id, ticket.id))).limit(1)
    const escalated = current?.status === 'awaiting_review'
      ? await escalateTicket(tx, {
        orgId, ticketId: ticket.id, fromStatus: 'awaiting_review',
        reason: atLimit ? 'redraft_limit_reached' : 'owner_handling',
        day, now,
        // The owner is looking at the ticket when they take it over — escalate quietly. Hitting the
        // re-draft cap is news, so that one pages, under its own reason-scoped dedupe key.
        quiet: !atLimit,
        ...(atLimit ? { dedupeKey: `redraft_limit:${ticket.id}:${day}` } : {}),
        draftId: draft.id, actor: actor.actor, auditAction: 'ticket.escalated',
        detail: { draftId: draft.id, rejectAction: input.action },
      })
      : { escalated: false, notificationId: undefined }
    // `escalate_limit` is the caller's cue that the ticket was paged for hitting the re-draft cap —
    // so it is only that when the escalation actually happened. A ticket a concurrent writer moved
    // out of `awaiting_review` (the guard above) is reported as the terminal resolution it got.
    const resolutionName: RejectResolution = atLimit && escalated.escalated ? 'escalate_limit' : 'escalate_terminal'
    await audit(tx, {
      actor: actor.actor, action: 'draft.rejected', entityType: 'draft', entityId: draft.id,
      detail: { draftId: draft.id, ticketId: ticket.id, resolution: resolutionName, reasonLen: input.reason.length, escalated: escalated.escalated },
      ip: actor.ip, userAgent: actor.userAgent,
    })
    return escalated.notificationId === undefined
      ? { ok: true, resolution: resolutionName }
      : { ok: true, resolution: resolutionName, notificationId: escalated.notificationId }
  })

  if (!outcome.ok) return outcome
  if (outcome.redraftTicketId) {
    const jobId = await deps.enqueue(JOB_NAMES.ticketDraft, { orgId, ticketId: outcome.redraftTicketId }, { entityId: outcome.redraftTicketId })
    if (jobId === null) {
      deps.logger.warn({ orgId, ticketId: outcome.redraftTicketId }, 'ticket.draft enqueue returned no job id; the backstop missed-draft sweep will pick it up')
    }
  }
  if (outcome.notificationId) {
    const jobId = await deps.enqueue(JOB_NAMES.notifyDispatch, { orgId, notificationId: outcome.notificationId }, { entityId: outcome.notificationId })
    if (jobId === null) deps.logger.warn({ orgId, notificationId: outcome.notificationId }, 'notify.dispatch enqueue returned no job id; the digest will collapse it')
  }
  return { ok: true, resolution: outcome.resolution }
}

// ---------------------------------------------------------------------------
// viewed / resolve
// ---------------------------------------------------------------------------

/**
 * Stamps the first view of a pending draft — the evidence the approve gate's viewed-before-approve
 * rule reads. `COALESCE` so a second viewer never moves the stamp; a decided draft is a no-op.
 */
export async function markViewed(deps: DraftServiceDeps, orgId: string, draftId: string, actor: DraftActor): Promise<boolean> {
  const now = clock(deps)
  return deps.api.withOrg(orgId, async (tx) => {
    const stamped = await tx.update(drafts)
      .set({ viewedAt: sql`COALESCE(${drafts.viewedAt}, ${now})` })
      .where(and(eq(drafts.orgId, orgId), eq(drafts.id, draftId), eq(drafts.status, 'pending')))
      .returning({ id: drafts.id, ticketId: drafts.ticketId, viewedAt: drafts.viewedAt })
    const row = stamped[0]
    if (!row) return false
    // One row per draft, not per render: the stamp only moves the first time, and this is what makes
    // "someone read it before approving" auditable.
    if (row.viewedAt?.getTime() === now.getTime()) {
      await audit(tx, {
        actor: actor.actor, action: 'draft.viewed', entityType: 'draft', entityId: draftId,
        detail: { draftId, ticketId: row.ticketId, source: actor.source }, ip: actor.ip, userAgent: actor.userAgent,
      })
    }
    return true
  })
}

/**
 * "Mark resolved": the owner is done with this ticket. The live draft (if any) is superseded and its
 * queued send held, so nothing goes out after the fact, and the redraft cycle is cleared the way
 * every other exit from it is.
 */
export async function resolveTicket(deps: DraftServiceDeps, orgId: string, ticketId: string, actor: DraftActor): Promise<boolean> {
  return withDeadlockRetry(() => deps.api.withOrg(orgId, async (tx) => {
    // Lock order `outbound_sends` → `drafts` → `tickets` (see this file's header). The send rows go
    // first, found through a subquery so no draft row has to be read (let alone locked) before them.
    await tx.select({ id: outboundSends.id })
      .from(outboundSends)
      .where(and(
        eq(outboundSends.orgId, orgId),
        inArray(outboundSends.draftId, tx.select({ id: drafts.id })
          .from(drafts)
          .where(and(eq(drafts.orgId, orgId), eq(drafts.ticketId, ticketId), inArray(drafts.status, [...SUPERSEDABLE_DRAFT_STATUSES])))),
      ))
      .for('update')

    // The live draft under a real lock, and its status re-read there: reading it unlocked meant a
    // concurrent approve could flip `pending → approved` underneath, leaving the supersede below
    // matching 0 rows on a ticket already marked resolved — an approved reply still queued to go out
    // (review Important 1). `FOR UPDATE` re-checks the predicate after the wait, so an approve that
    // won the race is still selected here, and superseded, and its send held.
    const [live] = await tx.select({ id: drafts.id, status: drafts.status })
      .from(drafts)
      .where(and(eq(drafts.orgId, orgId), eq(drafts.ticketId, ticketId), inArray(drafts.status, [...SUPERSEDABLE_DRAFT_STATUSES])))
      .limit(1)
      .for('update')

    const moved = await tx.update(tickets)
      .set({ status: 'resolved', ...clearRedraftCycle() })
      .where(and(eq(tickets.orgId, orgId), eq(tickets.id, ticketId), inArray(tickets.status, [...RESOLVABLE_TICKET_STATUSES])))
      .returning({ id: tickets.id })
    if (moved.length === 0) return false

    let supersededDraftId: string | null = null
    if (live) {
      draftTransitions.assert(live.status as DraftStatus, 'superseded')
      const superseded = await tx.update(drafts)
        .set({ status: 'superseded' })
        .where(and(eq(drafts.orgId, orgId), eq(drafts.id, live.id), inArray(drafts.status, [...SUPERSEDABLE_DRAFT_STATUSES])))
        .returning({ id: drafts.id })
      if (superseded.length > 0) {
        supersededDraftId = live.id
        outboundSendTransitions.assert('queued', 'held')
        await tx.update(outboundSends)
          .set({ status: 'held', lastError: 'held:ticket_resolved' })
          .where(and(eq(outboundSends.orgId, orgId), eq(outboundSends.draftId, live.id), eq(outboundSends.status, 'queued')))
      }
    }

    await audit(tx, {
      actor: actor.actor, action: 'ticket.resolved', entityType: 'ticket', entityId: ticketId,
      detail: { ticketId, supersededDraftId }, ip: actor.ip, userAgent: actor.userAgent,
    })
    return true
  }))
}

// ---------------------------------------------------------------------------
// the edit-distance ratio
// ---------------------------------------------------------------------------

/**
 * Levenshtein distance over the longer string's length: 0 = byte-identical, 1 = nothing in common.
 * Stored on the draft as `edit_distance_ratio` — how much of the model's reply the owner rewrote,
 * which is what Phase 5's graduation reads. Two rolling rows, so a 4 000-char body costs one array.
 */
export function levenshteinRatio(a: string, b: string): number {
  const max = Math.max(a.length, b.length)
  if (max === 0) return 0
  if (a === b) return 0
  if (a.length === 0 || b.length === 0) return 1

  let prev = new Uint32Array(b.length + 1)
  let curr = new Uint32Array(b.length + 1)
  for (let j = 0; j <= b.length; j++) prev[j] = j
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i
    const ca = a.charCodeAt(i - 1)
    for (let j = 1; j <= b.length; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1
      curr[j] = Math.min(curr[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost)
    }
    const swap = prev
    prev = curr
    curr = swap
  }
  return prev[b.length]! / max
}
