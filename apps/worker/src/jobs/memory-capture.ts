/**
 * `memory.capture` (spec §Learning loop, mechanism 1): one delivered reply becomes — or reinforces —
 * one resolved answer. Enqueued by `send.execute`'s post-commit `onSent` seam; runs on the `agent`
 * role because it embeds. Three short transactions with the embed strictly between the first two.
 */
import { and, eq, inArray, sql } from 'drizzle-orm'
import type PgBoss from 'pg-boss'
import type pino from 'pino'
import { z } from 'zod'
import { MEMORY_EXPIRY_DAYS, MEMORY_STRIKES_TO_RETIRE } from '@aesa/core'
import { audit, customerHash, drafts, ensureCustomerHashSalt, messages, resolvedAnswers, tickets, withOrg, type Db } from '@aesa/db'
import { scrubForMemory, type Embedder } from '@aesa/knowledge'
import { defineJob, enqueue, JOB_NAMES, registerJob, type JobDefinition } from '@aesa/queue'

export const MemoryCapturePayload = z.object({ orgId: z.string(), draftId: z.string() })
export type MemoryCapturePayload = z.infer<typeof MemoryCapturePayload>

export const memoryCaptureJob: JobDefinition<MemoryCapturePayload> = defineJob({
  name: JOB_NAMES.memoryCapture, schema: MemoryCapturePayload,
  queue: { policy: 'short', expireInSeconds: 120, retryLimit: 3, retryDelay: 30, retryBackoff: true },
  handler: async () => { throw new Error('memory.capture: register it through registerMemoryCapture(boss, deps)') },
})

export interface MemoryCaptureDeps { db: Db; embedder: Embedder; logger: pino.Logger; now?: () => Date }
const ACTOR = `system:${JOB_NAMES.memoryCapture}` as const
/** The first 1,000 chars of the latest inbound stand in for the question when triage asked nothing (the retriever's own rule). */
const TEXT_QUESTION_CHARS = 1_000

export async function registerMemoryCapture(boss: PgBoss, deps: MemoryCaptureDeps): Promise<void> {
  await registerJob(boss, { ...memoryCaptureJob, handler: async (ctx) => { await runMemoryCapture(deps, ctx.data, ctx.signal) } })
}
export async function enqueueMemoryCapture(boss: PgBoss, orgId: string, draftId: string): Promise<void> {
  await enqueue(boss, memoryCaptureJob, { orgId, draftId }, { entityId: draftId })
}

interface Loaded {
  draft: { id: string; ticketId: string; agentId: string | null; categoryId: string | null; finalBody: string; decisionSource: string; editDistanceRatio: number; usedAnswerIds: string[]; citedChunkIds: string[]; knowledgeVersion: number }
  ticket: { customerEmail: string | null; customerName: string | null; triageQuestions: string[] }
  latestInboundBody: string
}

async function load(db: Db, orgId: string, draftId: string): Promise<Loaded | null> {
  return withOrg(db, orgId, async (tx) => {
    const [d] = await tx.select({
      id: drafts.id, ticketId: drafts.ticketId, agentId: drafts.agentId, categoryId: drafts.categoryId, status: drafts.status,
      finalBody: drafts.finalBody, decisionSource: drafts.decisionSource, editDistanceRatio: drafts.editDistanceRatio,
      usedAnswerIds: drafts.usedAnswerIds, citedChunkIds: drafts.citedChunkIds, memoryCapturedAt: drafts.memoryCapturedAt,
      confidenceBreakdown: drafts.confidenceBreakdown,
    }).from(drafts).where(eq(drafts.id, draftId))
    if (!d || d.status !== 'sent' || d.finalBody === null || d.decisionSource === null || d.memoryCapturedAt !== null) return null
    const [t] = await tx.select({ customerEmail: tickets.customerEmail, customerName: tickets.customerName, triageQuestions: tickets.triageQuestions })
      .from(tickets).where(eq(tickets.id, d.ticketId))
    if (!t) return null
    const [inbound] = await tx.select({ bodyText: messages.bodyText }).from(messages)
      .where(and(eq(messages.ticketId, d.ticketId), eq(messages.direction, 'inbound')))
      .orderBy(sql`${messages.sentAt} DESC NULLS LAST`, sql`${messages.createdAt} DESC`).limit(1)
    const grounding = (d.confidenceBreakdown as { grounding?: { knowledgeVersion?: unknown } }).grounding
    return {
      draft: {
        id: d.id, ticketId: d.ticketId, agentId: d.agentId, categoryId: d.categoryId, finalBody: d.finalBody, decisionSource: d.decisionSource,
        editDistanceRatio: d.editDistanceRatio ?? 0, usedAnswerIds: d.usedAnswerIds, citedChunkIds: d.citedChunkIds,
        knowledgeVersion: typeof grounding?.knowledgeVersion === 'number' ? grounding.knowledgeVersion : 0,
      },
      ticket: t, latestInboundBody: inbound?.bodyText ?? '',
    }
  })
}

export async function runMemoryCapture(deps: MemoryCaptureDeps, payload: MemoryCapturePayload, signal: AbortSignal): Promise<'captured' | 'reinforced' | 'skipped'> {
  const { orgId, draftId } = payload
  const now = deps.now?.() ?? new Date()
  const loaded = await load(deps.db, orgId, draftId)
  if (!loaded) return 'skipped'
  const { draft, ticket } = loaded
  const scrub = { customerName: ticket.customerName, customerEmail: ticket.customerEmail }
  const rawQuestion = ticket.triageQuestions.filter((q) => q.trim() !== '').join('\n') || loaded.latestInboundBody.slice(0, TEXT_QUESTION_CHARS)
  const question = scrubForMemory(rawQuestion, scrub)
  const answer = scrubForMemory(draft.finalBody, scrub)
  const auto = draft.decisionSource === 'auto'
  const edited = draft.editDistanceRatio > 0

  // ── the embed, between transactions; a throw leaves the draft unstamped for the retry ──
  let vector: number[] | null = null
  if (question.length > 0 && answer.length > 0) {
    const { vectors } = await deps.embedder.embed([question], 'document', signal)
    vector = vectors[0] ?? null
  }

  return withOrg(deps.db, orgId, async (tx) => {
    // The idempotency gate FIRST: zero rows means another delivery captured this draft.
    const stamped = await tx.update(drafts).set({ memoryCapturedAt: now })
      .where(and(eq(drafts.id, draftId), sql`${drafts.memoryCapturedAt} IS NULL`)).returning({ id: drafts.id })
    if (stamped.length === 0) return 'skipped'
    if (vector === null) {
      await audit(tx, { actor: ACTOR, action: 'memory.skipped', entityType: 'draft', entityId: draftId, detail: { reason: 'empty_after_scrub' } })
      return 'skipped'
    }
    const salt = await ensureCustomerHashSalt(tx, orgId)
    const sourceCustomerHash = ticket.customerEmail ? customerHash(salt, ticket.customerEmail) : null
    const expiresAt = new Date(now.getTime() + MEMORY_EXPIRY_DAYS * 86_400_000)

    // Reinforce: a human, unchanged approval that reused active answers bumps THEM and inserts nothing.
    const usedActive = draft.usedAnswerIds.length > 0 && !auto
      ? await tx.select({ id: resolvedAnswers.id, strikes: resolvedAnswers.strikes }).from(resolvedAnswers)
          .where(and(eq(resolvedAnswers.orgId, orgId), inArray(resolvedAnswers.id, draft.usedAnswerIds), eq(resolvedAnswers.status, 'active')))
      : []
    if (usedActive.length > 0 && !edited) {
      await tx.update(resolvedAnswers)
        .set({ approvals: sql`${resolvedAnswers.approvals} + 1`, reuseCount: sql`${resolvedAnswers.reuseCount} + 1`, lastApprovedAt: now, expiresAt })
        .where(inArray(resolvedAnswers.id, usedActive.map((a) => a.id)))
      await audit(tx, { actor: ACTOR, action: 'memory.reinforced', entityType: 'draft', entityId: draftId, detail: { answerIds: usedActive.map((a) => a.id) } })
      return 'reinforced'
    }

    // Insert: active for a human approval, candidate for an auto-send (never retrieved until sampled).
    const supersedes = edited && usedActive.length > 0 ? usedActive[0]! : null
    const [inserted] = await tx.insert(resolvedAnswers).values({
      orgId, agentId: draft.agentId, categoryId: draft.categoryId, questionText: question, answerBody: answer,
      questionEmbedding: vector, embeddingModel: deps.embedder.model, embeddingVersion: deps.embedder.version,
      status: auto ? 'candidate' : 'active', approvals: auto ? 0 : 1, wasEdited: edited,
      citedChunkIds: draft.citedChunkIds, knowledgeVersion: draft.knowledgeVersion,
      sourceTicketId: draft.ticketId, sourceDraftId: draftId, sourceCustomerHash,
      supersedesId: supersedes?.id ?? null, lastApprovedAt: auto ? null : now, expiresAt,
    }).returning({ id: resolvedAnswers.id })
    if (supersedes) {
      // Deviation 9: the reused answer was corrected — one strike and the owner's review; two strikes retire.
      const retire = supersedes.strikes + 1 >= MEMORY_STRIKES_TO_RETIRE
      await tx.update(resolvedAnswers)
        .set(retire
          ? { status: 'retired', retiredReason: 'strikes', strikes: sql`${resolvedAnswers.strikes} + 1` }
          : { status: 'needs_review', reviewReason: 'edited_reuse', strikes: sql`${resolvedAnswers.strikes} + 1` })
        .where(and(eq(resolvedAnswers.id, supersedes.id), eq(resolvedAnswers.status, 'active')))
    }
    await audit(tx, {
      actor: ACTOR, action: 'memory.captured', entityType: 'draft', entityId: draftId,
      detail: { answerId: inserted!.id, status: auto ? 'candidate' : 'active', wasEdited: edited, supersedesId: supersedes?.id ?? null, questionChars: question.length, answerChars: answer.length },
    })
    return 'captured'
  })
}
