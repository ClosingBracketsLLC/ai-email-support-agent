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
import { and, desc, eq, inArray, isNull, ne, sql, type SQL } from 'drizzle-orm'
import type pino from 'pino'
// The pure sub-path, never the package root: `@aesa/agent/policy` pulls in `@aesa/core` and this
// package's prompt-TEXT modules only, so the Anthropic SDK never enters an api process (CLAUDE.md —
// the api never calls a model). `error-surface.test.ts` walks the real module graph to hold that.
import { buildReplyPolicy } from '@aesa/agent/policy'
import { APPROVE_UNDO_SECONDS, OUTBOUND_SEND_STATUSES, type DraftStatus, type OutboundSendStatus, type RejectAction } from '@aesa/contracts'
import {
  clearRedraftCycle, draftTransitions, outboundSendTransitions, resolveRejectAction, ticketTransitions, validateReplyBody,
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

/**
 * The live-draft statuses "Mark resolved" RETIRES, and what each becomes — both edges are in the
 * draft matrix (`pending|approved → superseded`, `held → expired`).
 *
 * All three, not just the first two (fix wave A2, final-C I1): a draft `send.execute` parked on
 * `held` is live as far as `drafts_live_per_ticket_uidx` is concerned, so leaving it behind poisoned
 * the ticket — the next cycle's `ticket.draft` INSERT hit 23505, which is not a `LostRaceError`, and
 * kept failing until `sweeps.daily` expired the draft up to seven days later.
 *
 * `sending` is deliberately absent: a reply is in flight (or already delivered) and only the send job
 * may decide what happened to it. Its send row is left alone for the same reason.
 */
const DRAFT_RETIREMENT = { pending: 'superseded', approved: 'superseded', held: 'expired' } as const
type RetirableDraftStatus = keyof typeof DRAFT_RETIREMENT
const RETIRABLE_DRAFT_STATUSES = Object.keys(DRAFT_RETIREMENT) as RetirableDraftStatus[]

/** The send statuses a resolve may pull back. `claimed` as well as `queued` (fix wave A2): the
 * in-flight job's pre-send flip matches on `status = 'claimed' AND claim_token = …`, so holding the
 * row here makes that flip match nothing and the run back off before anything is sent. */
const HOLDABLE_SEND_STATUSES = ['queued', 'claimed'] as const

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
function draftViewQuery(tx: OrgTx, orgId: string, predicate: SQL, orderBy?: SQL[]) {
  const rows = tx.select(draftViewColumns)
    .from(drafts)
    .leftJoin(agents, eq(agents.id, drafts.agentId))
    .leftJoin(categories, eq(categories.id, drafts.categoryId))
    .leftJoin(outboundSends, eq(outboundSends.draftId, drafts.id))
    .where(and(eq(drafts.orgId, orgId), predicate))
  return (orderBy ? rows.orderBy(...orderBy) : rows).limit(1)
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

/**
 * The draft the ticket screen opens on: the one LIVE draft (at most one, by the partial unique) —
 * or, when there is none, the ticket's most recent `failed` one.
 *
 * The fallback exists because A3's return path is otherwise unreachable from the app (round 2,
 * re-review 2): a terminal send failure leaves the draft `failed`, which is outside
 * `drafts_live_per_ticket_uidx`, so "Not sent — … Back to review" had nothing to render against and
 * `drafts.resume` had no button. `failed` is the ONLY non-live status served this way — a `rejected`,
 * `superseded`, `expired` or `sent` draft is finished business and stays out of the panel.
 *
 * `inbox.list`'s join is deliberately NOT widened: a `needs_owner/send_failed` row shows no draft
 * chip, which keeps the list's "a draft is waiting for you" chip honest.
 */
export async function loadLiveDraftView(tx: OrgTx, orgId: string, ticketId: string): Promise<DraftView | null> {
  const [live] = await draftViewQuery(tx, orgId, and(eq(drafts.ticketId, ticketId), inArray(drafts.status, [...LIVE_DRAFT_STATUSES]))!)
  if (live) return toDraftView(live)

  // `decided_at` is always set on a `failed` draft (both edges into it, `approved → failed` and
  // `sending → failed`, run downstream of an approve), but NULLS LAST keeps the order total if that
  // ever stops being true; `created_at` breaks a same-instant tie.
  const [failed] = await draftViewQuery(
    tx, orgId, and(eq(drafts.ticketId, ticketId), eq(drafts.status, 'failed'))!,
    [sql`${drafts.decidedAt} DESC NULLS LAST`, desc(drafts.createdAt)],
  )
  return failed ? toDraftView(failed) : null
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
  const outcome = await withDeadlockRetry(async () => {
    // Inside the retried body, not outside it (fix wave A5, final-C M4): a retry is a fresh set of
    // reads and a fresh CLOCK, so `decided_at` and the 15-second `send_after` come from when this
    // attempt actually ran, not from before the deadlock it lost.
    const now = clock(deps)
    return deps.api.withOrg(orgId, async (tx): Promise<ApproveResult> => {
      // Lock order `outbound_sends` → `drafts` → `tickets` (see this file's header): a no-op when this
      // draft has never been approved, and the lock the upsert below would otherwise take second.
      await tx.select({ id: outboundSends.id })
        .from(outboundSends)
        .where(and(eq(outboundSends.orgId, orgId), eq(outboundSends.draftId, input.draftId)))
        .limit(1)
        .for('update')

      const [draft] = await tx.select({
        id: drafts.id, ticketId: drafts.ticketId, agentId: drafts.agentId, status: drafts.status, body: drafts.body, viewedAt: drafts.viewedAt,
        customerLanguage: drafts.customerLanguage,
      }).from(drafts).where(and(eq(drafts.orgId, orgId), eq(drafts.id, input.draftId))).limit(1).for('update')
      if (!draft) return { ok: false, code: 'not_found' }
      if (draft.status !== 'pending') return { ok: false, code: 'not_pending' }

      // The email surface only ever gets here from the page that RENDERED the body, so the click is
      // itself the proof of a read; the app has to say so explicitly (Task 20 marks viewed on render).
      const viewedAt = draft.viewedAt ?? (actor.source === 'email' ? now : null)
      if (viewedAt === null) return { ok: false, code: 'not_viewed' }

      const [ticket] = await tx.select({ id: tickets.id, connectionId: tickets.connectionId, agentId: tickets.agentId, language: tickets.language })
        .from(tickets).where(and(eq(tickets.orgId, orgId), eq(tickets.id, draft.ticketId))).limit(1)
      if (!ticket) return { ok: false, code: 'not_found' }

      const [workspace] = await tx.select({
        killSwitch: workspaces.killSwitch, agentEnabled: workspaces.agentEnabled, allowedUrlHosts: workspaces.allowedUrlHosts,
        allowedEmailDomains: workspaces.allowedEmailDomains, contactPhone: workspaces.contactPhone, contactUrls: workspaces.contactUrls,
        locale: workspaces.locale, operatingGuidance: workspaces.operatingGuidance,
      }).from(workspaces).where(eq(workspaces.orgId, orgId)).limit(1)
      if (!workspace) throw new Error(`approveDraft: org ${orgId} has no workspace row`)

      // The kill levers, in `send.execute`'s own order (its firstKillLever) — the send would refuse
      // anyway, so refusing here keeps the ticket in To review instead of parking a held send on it.
      if (workspace.killSwitch) return { ok: false, code: 'kill_switch' }
      if (!workspace.agentEnabled) return { ok: false, code: 'agent_disabled' }

      const agentId = draft.agentId ?? ticket.agentId
      const [agent] = agentId
        ? await tx.select({
          id: agents.id, domain: agents.domain, displayName: agents.displayName, address: agents.address,
          replyFromAddress: agents.replyFromAddress, personaPreset: agents.personaPreset, personaText: agents.personaText,
          guidanceExtra: agents.guidanceExtra,
        }).from(agents).where(and(eq(agents.orgId, orgId), eq(agents.id, agentId))).limit(1)
        : []
      // No agent row means no From address and no domain to allow: nothing can be sent, and "the agent
      // is not set up" is the truest of the six codes for it.
      if (!agent) return { ok: false, code: 'agent_disabled' }

      // THE SAME POLICY THE SEND GATE BUILDS — `@aesa/agent/policy`'s `buildReplyPolicy`, from the same
      // four trusted texts and the same `expectedLanguage`, off the same rows (fix wave A1, reversing
      // ruling ledger line 28). The gate this call feeds is `send.execute` step 2; a policy that
      // differed by one trusted text meant an owner edit quoting ten words of their own operating
      // guidance passed HERE and was then destroyed there by `landTerminal('guardrail:…')` — the draft
      // `failed`, the ticket paged, and (until A3) no way back (final-C I2 / final-E I1).
      //
      // The one deliberate difference is in the OPTIONS, not the policy: no `groundedNumbers`, because
      // the owner IS the grounding for their own edit — and `unbacked_number` is a `warn` that could
      // never have blocked either gate anyway.
      const policy = buildReplyPolicy({
        workspace: {
          allowedUrlHosts: workspace.allowedUrlHosts, allowedEmailDomains: workspace.allowedEmailDomains,
          contactPhone: workspace.contactPhone, contactUrls: workspace.contactUrls, locale: workspace.locale,
        },
        agent,
        workspaceGuidance: workspace.operatingGuidance,
        agentGuidance: agent.guidanceExtra,
        expectedLanguage: ticket.language,
      })
      const screened = validateReplyBody(input.body ?? draft.body, policy, { replyLanguage: draft.customerLanguage })
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
    })
  })

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
  return withDeadlockRetry(async () => {
    // A fresh clock per attempt, for the same reason `approveDraft` takes one (fix wave A5).
    const now = clock(deps)
    return deps.api.withOrg(orgId, async (tx) => {
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
    })
  })
}

/** The two statuses "Back to review" may resume from, both with a `→ pending` edge in the matrix. */
const RESUMABLE_DRAFT_STATUSES = ['held', 'failed'] as const
type ResumableDraftStatus = (typeof RESUMABLE_DRAFT_STATUSES)[number]

/**
 * "Back to review", for the two ways `send.execute` can park a reply:
 *
 *  - **`held`** — a kill lever, or a mailbox that needs re-authing. Nothing was attempted, the ticket
 *    is still `awaiting_review`, and only the draft moves.
 *  - **`failed`** — a TERMINAL refusal: the third-pass guardrail (`landTerminal`), or a dead letter
 *    after the retry budget (`landDeadLetter`). Those also escalate the ticket to
 *    `needs_owner/send_failed`, so the resume walks that escalation back to `awaiting_review` —
 *    guarded on BOTH the status and the reason, so a ticket escalated for anything else (the owner
 *    taking it over, the redraft cap, a tripwire) is left exactly as its escalator left it, and a
 *    stale-failed draft, whose ticket `landStale` sent back to `triaged` for a re-draft, is left
 *    alone too. `escalation_notified_at` is NOT re-stamped: the owner was already paged, and clearing
 *    it would let the next escalation page them again about a ticket they are looking at.
 *    (fix wave A3 / final-E I2 — without `failed → pending` the runbook's documented recovery, "fix
 *    the cause, tap Back to review, approve again", had no button behind it.)
 *
 * The send row is untouched either way — `held` stays `held`, `failed` stays `failed`. The next
 * approve revives that same ledger row through `approveDraft`'s ON CONFLICT path
 * (`REQUEUEABLE_SEND_STATUSES` covers both), so the delivery keeps its history (attempts, provider
 * ids, `last_error`) instead of starting a second one.
 *
 * ONE-LIVE-DRAFT: `held` is inside `drafts_live_per_ticket_uidx` and `failed` is OUTSIDE it, so a
 * resume from `failed` MOVES A ROW INTO the partial unique. If a re-draft has already landed on that
 * ticket the insert-side of that index is occupied and the UPDATE raises a raw 23505 — a masked 500
 * on a button. The guarded scan below turns it into the ordinary soft outcome (round 2, re-review 1).
 * It excludes the draft being resumed: a `held` draft is already in the index, so it is its own
 * (harmless) hit, and the unique itself proves no other live row can exist beside it.
 *
 * Lock order: drafts → tickets, the same order `rejectDraft` takes. No send row is read or written.
 */
export async function resumeDraft(
  deps: DraftServiceDeps, orgId: string, draftId: string, actor: DraftActor,
): Promise<{ ok: true } | { ok: false; code: 'not_found' | 'not_resumable' }> {
  return deps.api.withOrg(orgId, async (tx) => {
    const [draft] = await tx.select({ id: drafts.id, ticketId: drafts.ticketId, status: drafts.status })
      .from(drafts).where(and(eq(drafts.orgId, orgId), eq(drafts.id, draftId))).limit(1).for('update')
    if (!draft) return { ok: false, code: 'not_found' }
    const from = draft.status as ResumableDraftStatus
    if (!RESUMABLE_DRAFT_STATUSES.includes(from)) return { ok: false, code: 'not_resumable' }

    // The one-live-draft guard (see the header). Locked, not merely read: a `ticket.draft` INSERT
    // committing between this scan and the UPDATE would put the 23505 straight back.
    const rivals = await tx.select({ id: drafts.id })
      .from(drafts)
      .where(and(
        eq(drafts.orgId, orgId), eq(drafts.ticketId, draft.ticketId), ne(drafts.id, draft.id),
        inArray(drafts.status, [...LIVE_DRAFT_STATUSES]),
      ))
      .for('update')
    if (rivals.length > 0) return { ok: false, code: 'not_resumable' }

    draftTransitions.assert(from, 'pending')
    const resumed = await tx.update(drafts)
      .set({ status: 'pending' })
      .where(and(eq(drafts.id, draft.id), eq(drafts.status, from)))
      .returning({ id: drafts.id })
    if (resumed.length === 0) return { ok: false, code: 'not_resumable' }

    // Only the send job's OWN escalation is walked back, and only for the draft status that job
    // pairs it with — both halves guarded in the one statement, so a concurrent writer that moved
    // the ticket in between simply wins and the resume stops at the draft.
    let ticketReturned = false
    if (from === 'failed') {
      ticketTransitions.assert('needs_owner', 'awaiting_review')
      const moved = await tx.update(tickets)
        .set({ status: 'awaiting_review', needsOwnerReason: null })
        .where(and(
          eq(tickets.orgId, orgId), eq(tickets.id, draft.ticketId),
          eq(tickets.status, 'needs_owner'), eq(tickets.needsOwnerReason, 'send_failed'),
        ))
        .returning({ id: tickets.id })
      ticketReturned = moved.length > 0
    }

    await audit(tx, {
      actor: actor.actor, action: 'draft.resumed', entityType: 'draft', entityId: draft.id,
      detail: { draftId: draft.id, ticketId: draft.ticketId, from, ticketReturned, source: actor.source },
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
 * "Mark resolved": the owner is done with this ticket. The live draft (if any) is RETIRED — every
 * status the one-live-draft partial unique covers except `sending`, `pending|approved → superseded`
 * and `held → expired` — and its send pulled back from `queued` OR `claimed`, so nothing goes out
 * after the fact and the ticket is clear for the next draft cycle. The redraft cycle is cleared the
 * way every other exit from it is.
 */
export async function resolveTicket(deps: DraftServiceDeps, orgId: string, ticketId: string, actor: DraftActor): Promise<boolean> {
  return withDeadlockRetry(() => deps.api.withOrg(orgId, async (tx) => {
    // Lock order `outbound_sends` → `drafts` → `tickets` (see this file's header). The send rows go
    // first, found through a subquery so no draft row has to be read (let alone locked) before them.
    // The subquery spans every retirable status, so the `held` draft's send is locked too.
    await tx.select({ id: outboundSends.id })
      .from(outboundSends)
      .where(and(
        eq(outboundSends.orgId, orgId),
        inArray(outboundSends.draftId, tx.select({ id: drafts.id })
          .from(drafts)
          .where(and(eq(drafts.orgId, orgId), eq(drafts.ticketId, ticketId), inArray(drafts.status, RETIRABLE_DRAFT_STATUSES)))),
      ))
      .for('update')

    // The live draft under a real lock, and its status re-read there: reading it unlocked meant a
    // concurrent approve could flip `pending → approved` underneath, leaving the supersede below
    // matching 0 rows on a ticket already marked resolved — an approved reply still queued to go out
    // (review Important 1). `FOR UPDATE` re-checks the predicate after the wait, so an approve that
    // won the race is still selected here, and superseded, and its send held.
    const [live] = await tx.select({ id: drafts.id, status: drafts.status })
      .from(drafts)
      .where(and(eq(drafts.orgId, orgId), eq(drafts.ticketId, ticketId), inArray(drafts.status, RETIRABLE_DRAFT_STATUSES)))
      .limit(1)
      .for('update')

    const moved = await tx.update(tickets)
      .set({ status: 'resolved', ...clearRedraftCycle() })
      .where(and(eq(tickets.orgId, orgId), eq(tickets.id, ticketId), inArray(tickets.status, [...RESOLVABLE_TICKET_STATUSES])))
      .returning({ id: tickets.id })
    if (moved.length === 0) return false

    let retired: { id: string; from: RetirableDraftStatus; to: DraftStatus } | null = null
    if (live) {
      const from = live.status as RetirableDraftStatus
      const to: DraftStatus = DRAFT_RETIREMENT[from]
      draftTransitions.assert(from, to)
      const rows = await tx.update(drafts)
        .set({ status: to })
        .where(and(eq(drafts.orgId, orgId), eq(drafts.id, live.id), eq(drafts.status, from)))
        .returning({ id: drafts.id })
      if (rows.length > 0) {
        retired = { id: live.id, from, to }
        for (const s of HOLDABLE_SEND_STATUSES) outboundSendTransitions.assert(s, 'held')
        await tx.update(outboundSends)
          .set({ status: 'held', lastError: 'held:ticket_resolved' })
          .where(and(eq(outboundSends.orgId, orgId), eq(outboundSends.draftId, live.id), inArray(outboundSends.status, [...HOLDABLE_SEND_STATUSES])))
        // One row per retired draft, named for the status it landed in — the ticket.resolved row
        // below says the ticket was resolved, not what happened to the reply that was waiting on it.
        await audit(tx, {
          actor: actor.actor, action: to === 'superseded' ? 'draft.superseded' : 'draft.expired',
          entityType: 'draft', entityId: live.id,
          detail: { draftId: live.id, ticketId, from, via: 'ticket_resolved' }, ip: actor.ip, userAgent: actor.userAgent,
        })
      }
    }

    await audit(tx, {
      actor: actor.actor, action: 'ticket.resolved', entityType: 'ticket', entityId: ticketId,
      // `supersededDraftId` keeps its name and its null-when-nothing-was-live meaning; `retiredAs`
      // says which of the two retirements it took.
      detail: { ticketId, supersededDraftId: retired?.id ?? null, retiredAs: retired?.to ?? null },
      ip: actor.ip, userAgent: actor.userAgent,
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
