/**
 * What the agent remembers, and the owner's four decisions about one remembered answer — as ONE
 * service module, mirroring `src/knowledge/service.ts` and `src/drafts/service.ts`: every procedure
 * is a plain exported async function `(deps, orgId, …) => result`, a soft outcome is a typed
 * `{ ok: false; code }` (never a thrown error), and `routers/memory.ts` does nothing but map those
 * codes onto `TRPCError`s.
 *
 * Discipline every function here keeps (CLAUDE.md):
 *  - one `withOrg` transaction per call, holding no network I/O;
 *  - every write guarded on the status it was READ at, so a concurrent owner, or the nightly sweep
 *    that retires expired answers, simply wins and this call reports `not_found`;
 *  - the per-org customer-hash salt never leaves the server — `deleteByCustomer` hashes the address
 *    inside the transaction and audits a COUNT, never the address and never the hash.
 *
 * `rejectCandidate` is the one two-transaction call here, deliberately: "this answer is wrong" about
 * a candidate is the same verdict as "this reply should not have been sent" about the auto-send that
 * produced it, so it delegates to `flagAutoSent` (which owns its own `withOrg`, the strikes, the
 * demotion check and the audit row) and then retires the candidate in a second transaction for the
 * cases the first cannot cover — a candidate with no source draft, or one whose draft is no longer
 * flaggable. The second is idempotent (`status = 'candidate'` guarded), so the ordinary path where
 * `flagAutoSent` already retired it simply matches zero rows.
 */
import { and, count, desc, eq, inArray } from 'drizzle-orm'
import type pino from 'pino'
import type { MemoryListInput, MemoryTab } from '@aesa/contracts'
import { MEMORY_EXPIRY_DAYS } from '@aesa/core'
import {
  agents, audit, categories, customerHash, resolvedAnswers, workspaces,
  type AuditActor, type OrgTx,
} from '@aesa/db'
import type { ApiFacade, EnqueueFn } from '../deps.ts'
import { flagAutoSent, type DraftServiceDeps } from '../drafts/service.ts'

/** Who is acting — the same shape as `knowledge/service.ts`'s `KnowledgeActor`. */
export interface MemoryActor {
  userId: string
  actor: AuditActor
  ip?: string | null
  userAgent?: string | null
}

/** A superset of `DraftServiceDeps` (minus its `now`), because `rejectCandidate` calls into it. */
export interface MemoryServiceDeps {
  api: ApiFacade
  enqueue: EnqueueFn
  logger: pino.Logger
  /** Test seam; production leaves it unset and reads the wall clock per call. */
  now?: () => Date
}

const clock = (deps: MemoryServiceDeps): Date => deps.now?.() ?? new Date()

/** Not found, or not in the status this decision applies to — one soft code, because telling the two
 * apart would leak whether an id exists in another workspace. */
export type MemoryFailure = { ok: false; code: 'not_found' }
export type MemoryResult = { ok: true } | MemoryFailure

const notFound: MemoryFailure = { ok: false, code: 'not_found' }

/** The excerpt lengths the Verify list renders — a scannable row, not the answer store. */
const QUESTION_EXCERPT = 200
const ANSWER_EXCERPT = 280

/** Which statuses each tab shows. `to_check` is the owner's actual queue: a candidate waiting to be
 * sampled, and an answer something parked for review (a model conflict, an edited reuse, a source
 * that changed underneath it). */
const TAB_STATUSES: Record<MemoryTab, readonly string[]> = {
  to_check: ['candidate', 'needs_review'],
  active: ['active'],
  retired: ['retired'],
}

export interface MemorySummary {
  candidate: number
  active: number
  needsReview: number
  retired: number
  /** The Verify tab's badge: candidates plus parked answers. */
  toCheck: number
}

export async function summary(deps: MemoryServiceDeps, orgId: string): Promise<MemorySummary> {
  return deps.api.withOrg(orgId, async (tx) => {
    const rows = await tx.select({ status: resolvedAnswers.status, value: count() })
      .from(resolvedAnswers)
      .where(eq(resolvedAnswers.orgId, orgId))
      .groupBy(resolvedAnswers.status)
    const byStatus = new Map(rows.map((row) => [row.status, row.value]))
    const candidate = byStatus.get('candidate') ?? 0
    const needsReview = byStatus.get('needs_review') ?? 0
    return {
      candidate, needsReview, active: byStatus.get('active') ?? 0, retired: byStatus.get('retired') ?? 0,
      toCheck: candidate + needsReview,
    }
  })
}

export interface MemoryListRow {
  id: string
  status: string
  /** An EXCERPT of the scrubbed question and answer — `memory.capture` already stripped the customer's
   * own identifiers; these are just the first few lines of what it stored. */
  question: string
  answer: string
  approvals: number
  strikes: number
  reuseCount: number
  wasEdited: boolean
  reviewReason: string | null
  retiredReason: string | null
  categoryLabel: string | null
  agentAddress: string | null
  sourceTicketId: string | null
  createdAt: Date
  lastApprovedAt: Date | null
  expiresAt: Date
}

export async function list(
  deps: MemoryServiceDeps, orgId: string, input: MemoryListInput,
): Promise<{ answers: MemoryListRow[] }> {
  const answers = await deps.api.withOrg(orgId, async (tx) => {
    const rows = await tx.select({
      id: resolvedAnswers.id, status: resolvedAnswers.status,
      questionText: resolvedAnswers.questionText, answerBody: resolvedAnswers.answerBody,
      approvals: resolvedAnswers.approvals, strikes: resolvedAnswers.strikes, reuseCount: resolvedAnswers.reuseCount,
      wasEdited: resolvedAnswers.wasEdited, reviewReason: resolvedAnswers.reviewReason, retiredReason: resolvedAnswers.retiredReason,
      categoryLabel: categories.label, agentAddress: agents.address, sourceTicketId: resolvedAnswers.sourceTicketId,
      createdAt: resolvedAnswers.createdAt, lastApprovedAt: resolvedAnswers.lastApprovedAt, expiresAt: resolvedAnswers.expiresAt,
    })
      .from(resolvedAnswers)
      .leftJoin(categories, eq(categories.id, resolvedAnswers.categoryId))
      .leftJoin(agents, eq(agents.id, resolvedAnswers.agentId))
      .where(and(eq(resolvedAnswers.orgId, orgId), inArray(resolvedAnswers.status, [...TAB_STATUSES[input.tab]])))
      .orderBy(desc(resolvedAnswers.createdAt), desc(resolvedAnswers.id))
      .limit(input.limit)
    return rows.map(({ questionText, answerBody, ...row }) => ({
      ...row, question: questionText.slice(0, QUESTION_EXCERPT), answer: answerBody.slice(0, ANSWER_EXCERPT),
    }))
  })
  return { answers }
}

/** "This one is fine" on an answer the agent parked for review: back to `active`, reason cleared. */
export async function keepAnswer(
  deps: MemoryServiceDeps, orgId: string, answerId: string, actor: MemoryActor,
): Promise<MemoryResult> {
  return deps.api.withOrg(orgId, async (tx) => {
    const kept = await tx.update(resolvedAnswers)
      .set({ status: 'active', reviewReason: null })
      .where(and(eq(resolvedAnswers.orgId, orgId), eq(resolvedAnswers.id, answerId), eq(resolvedAnswers.status, 'needs_review')))
      .returning({ id: resolvedAnswers.id })
    if (kept.length === 0) return notFound
    await auditAnswer(tx, actor, 'memory.kept', answerId, {})
    return { ok: true }
  })
}

/** "Forget this" — from any live status. `owner` is the reason, so the nightly sweep's own retirements
 * (`expired`, `unsampled`) stay distinguishable from a human's. */
export async function retireAnswer(
  deps: MemoryServiceDeps, orgId: string, answerId: string, actor: MemoryActor,
): Promise<MemoryResult> {
  return deps.api.withOrg(orgId, async (tx) => {
    const retired = await tx.update(resolvedAnswers)
      .set({ status: 'retired', retiredReason: 'owner' })
      .where(and(
        eq(resolvedAnswers.orgId, orgId), eq(resolvedAnswers.id, answerId),
        inArray(resolvedAnswers.status, ['candidate', 'active', 'needs_review']),
      ))
      .returning({ id: resolvedAnswers.id, status: resolvedAnswers.status })
    if (retired.length === 0) return notFound
    await auditAnswer(tx, actor, 'memory.retired', answerId, {})
    return { ok: true }
  })
}

/**
 * The sampling verdict: this auto-sent answer was right. It joins the active set with one approval
 * and a FRESH 365-day life — `expires_at` is fixed at approval time and never rolled by reuse, so
 * this is the one call that sets it after capture.
 */
export async function confirmCandidate(
  deps: MemoryServiceDeps, orgId: string, answerId: string, actor: MemoryActor,
): Promise<MemoryResult> {
  const now = clock(deps)
  return deps.api.withOrg(orgId, async (tx) => {
    const confirmed = await tx.update(resolvedAnswers)
      .set({ status: 'active', approvals: 1, lastApprovedAt: now, expiresAt: new Date(now.getTime() + MEMORY_EXPIRY_DAYS * 86_400_000) })
      .where(and(eq(resolvedAnswers.orgId, orgId), eq(resolvedAnswers.id, answerId), eq(resolvedAnswers.status, 'candidate')))
      .returning({ id: resolvedAnswers.id })
    if (confirmed.length === 0) return notFound
    await auditAnswer(tx, actor, 'memory.confirmed', answerId, {})
    return { ok: true }
  })
}

/**
 * The other sampling verdict — and the same verdict as `drafts.flagAutoSent` on the reply that
 * produced this candidate, so it IS that call (see this file's header for the two-transaction shape).
 *
 * Transaction 1 (`flagAutoSent`, only when the candidate names a source draft): stamps the draft,
 * strikes the answers that draft used, retires every candidate sourced from it — this one included —
 * and runs the demotion check. Transaction 2 retires the candidate for the cases transaction 1 could
 * not cover: no source draft at all, or a draft that is no longer flaggable (already flagged, or the
 * reply never actually went out).
 */
export async function rejectCandidate(
  deps: MemoryServiceDeps, orgId: string, answerId: string, actor: MemoryActor,
): Promise<MemoryResult> {
  const [candidate] = await deps.api.withOrg(orgId, (tx) =>
    tx.select({ id: resolvedAnswers.id, sourceDraftId: resolvedAnswers.sourceDraftId })
      .from(resolvedAnswers)
      .where(and(eq(resolvedAnswers.orgId, orgId), eq(resolvedAnswers.id, answerId), eq(resolvedAnswers.status, 'candidate')))
      .limit(1))
  if (!candidate) return notFound

  if (candidate.sourceDraftId) {
    const draftDeps: DraftServiceDeps = { api: deps.api, enqueue: deps.enqueue, logger: deps.logger, ...(deps.now ? { now: deps.now } : {}) }
    // A refusal here is not a failure of THIS call: the candidate is still the owner's to reject, and
    // the retirement below stands on its own.
    await flagAutoSent(draftDeps, orgId, candidate.sourceDraftId, { ...actor, source: 'app' })
  }

  return deps.api.withOrg(orgId, async (tx) => {
    const retired = await tx.update(resolvedAnswers)
      .set({ status: 'retired', retiredReason: 'sampled_bad' })
      .where(and(eq(resolvedAnswers.orgId, orgId), eq(resolvedAnswers.id, answerId), eq(resolvedAnswers.status, 'candidate')))
      .returning({ id: resolvedAnswers.id })
    // Zero rows is the ordinary path when the draft was flaggable: `flagAutoSent` already retired
    // this candidate, with the same reason, in its own transaction.
    await auditAnswer(tx, actor, 'memory.rejected', answerId, { alreadyRetired: retired.length === 0 })
    return { ok: true }
  })
}

/**
 * "Forget everything you learned from this customer" (spec §Learning loop privacy). The address is
 * hashed with the workspace's own salt INSIDE the transaction and never stored, logged or returned;
 * the audit row carries a count alone.
 *
 * A workspace with no salt has never captured an answer against a customer, so there is nothing to
 * match — and minting one here just to prove that would create a lasting secret for a no-op. It still
 * audits (`count: 0`): every tRPC mutation writes exactly one audit row (CLAUDE.md), and "someone
 * asked us to forget this customer and there was nothing to forget" is precisely the kind of request
 * a privacy trail has to show (task 9 review).
 */
export async function deleteByCustomer(
  deps: MemoryServiceDeps, orgId: string, email: string, actor: MemoryActor,
): Promise<{ deleted: number }> {
  return deps.api.withOrg(orgId, async (tx) => {
    const [workspace] = await tx.select({ salt: workspaces.customerHashSalt })
      .from(workspaces).where(eq(workspaces.orgId, orgId)).limit(1)

    const count = workspace?.salt
      ? (await tx.delete(resolvedAnswers)
        .where(and(eq(resolvedAnswers.orgId, orgId), eq(resolvedAnswers.sourceCustomerHash, customerHash(workspace.salt, email))))
        .returning({ id: resolvedAnswers.id })).length
      : 0

    await audit(tx, {
      actor: actor.actor, action: 'memory.deleted_by_customer', entityType: 'workspace', entityId: orgId,
      detail: { count }, ip: actor.ip, userAgent: actor.userAgent,
    })
    return { deleted: count }
  })
}

/** One audit row per decision, always naming the answer — never its text. */
async function auditAnswer(
  tx: OrgTx, actor: MemoryActor, action: string, answerId: string, detail: Record<string, unknown>,
): Promise<void> {
  await audit(tx, {
    actor: actor.actor, action, entityType: 'resolved_answer', entityId: answerId,
    detail: { answerId, ...detail }, ip: actor.ip, userAgent: actor.userAgent,
  })
}
