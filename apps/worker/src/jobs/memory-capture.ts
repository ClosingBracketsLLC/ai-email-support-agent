/**
 * `memory.capture` (spec §Learning loop, mechanism 1): a reply becomes — or reinforces — one
 * resolved answer, on two independent paths carried by a refined payload (Phase 7 added the
 * second):
 *
 *  - **`draftId`** — a DELIVERED draft, enqueued by `send.execute`'s post-commit `onSent` seam.
 *    Unchanged from Phase 5.
 *  - **`messageId`** — "Remember this reply" (deviation 16, the spec's Phase 7 backfill): an owner
 *    turns an already-SENT outbound message into a learned answer on demand, with no draft behind it
 *    at all — a hand-written reply, or one predating the agent entirely. Enqueued by the api's
 *    `memory.rememberReply` (Task 8). Idempotent through the partial unique index
 *    `resolved_answers_source_message_uidx` (org_id, source_message_id): a second run of the SAME
 *    message is a clean `'skipped'`, never a duplicate-key throw — the job checks first (so the
 *    common case never even reaches the insert) and the guarded re-check at write time is what
 *    makes a genuine race land the same way. Since ruling R20, EVERY refusal on this path writes a
 *    `memory.skipped` audit row naming its own reason (`not_found`, `not_outbound`, `not_sent`,
 *    `empty`, `no_question`, `already_remembered`, `embed_cap`, `empty_after_scrub`): the api
 *    screens what it cheaply can at request time, but a tap that got this far and found the world
 *    changed underneath it must still leave a record.
 *
 * Runs on the `agent` role (it embeds). Every write is a short `withOrg` transaction; the embed call
 * is network I/O and always sits strictly BETWEEN two of them, never inside one (CLAUDE.md
 * Transactions).
 */
import { and, eq, inArray, lt, sql } from 'drizzle-orm'
import type PgBoss from 'pg-boss'
import type pino from 'pino'
import { z } from 'zod'
import { MEMORY_EXPIRY_DAYS, MEMORY_STRIKES_TO_RETIRE, resolveSetting } from '@aesa/core'
import {
  audit, bumpMeter, customerHash, drafts, ensureCustomerHashSalt, KNOWLEDGE_METERS, loadSettingSources, messages,
  resolvedAnswers, tickets, usageCounters, withOrg, type Db,
} from '@aesa/db'
import { scrubForMemory, type Embedder } from '@aesa/knowledge'
import { defineJob, enqueue, JOB_NAMES, registerJob, type RegisteredJobDefinition } from '@aesa/queue'
import { utcDayString } from '../date-utils.ts'

export const MemoryCapturePayload = z.object({
  orgId: z.string(), draftId: z.string().optional(), messageId: z.string().optional(),
}).refine((p) => (p.draftId ? 1 : 0) + (p.messageId ? 1 : 0) === 1, 'exactly one of draftId or messageId')
export type MemoryCapturePayload = z.infer<typeof MemoryCapturePayload>

export const memoryCaptureJob: RegisteredJobDefinition<MemoryCapturePayload> = defineJob({
  name: JOB_NAMES.memoryCapture, schema: MemoryCapturePayload,
  handler: async () => { throw new Error('memory.capture: register it through registerMemoryCapture(boss, deps)') },
})

export interface MemoryCaptureDeps { db: Db; embedder: Embedder; logger: pino.Logger; now?: () => Date }
const ACTOR = `system:${JOB_NAMES.memoryCapture}` as const
/** The first 1,000 chars of the latest inbound stand in for the question when triage asked nothing
 *  (the retriever's own rule) — and, since Phase 7, for "Remember this reply"'s question too. */
const TEXT_QUESTION_CHARS = 1_000

export async function registerMemoryCapture(boss: PgBoss, deps: MemoryCaptureDeps): Promise<void> {
  await registerJob(boss, { ...memoryCaptureJob, handler: async (ctx) => { await runMemoryCapture(deps, ctx.data, ctx.signal) } })
}
/** Unchanged from Phase 5. */
export async function enqueueMemoryCapture(boss: PgBoss, orgId: string, draftId: string): Promise<void> {
  await enqueue(boss, memoryCaptureJob, { orgId, draftId }, { entityId: draftId })
}
/** "Remember this reply" (Task 8's `rememberReply`) — `entityId` is the message, the same
 *  `short`-queue collapse-while-`created` shape the draft path already has. */
export async function enqueueMemoryRemember(boss: PgBoss, orgId: string, messageId: string): Promise<void> {
  await enqueue(boss, memoryCaptureJob, { orgId, messageId }, { entityId: messageId })
}

interface Loaded {
  draft: { id: string; ticketId: string; agentId: string | null; categoryId: string | null; finalBody: string; decisionSource: string; editDistanceRatio: number; usedAnswerIds: string[]; citedChunkIds: string[]; knowledgeVersion: number }
  ticket: { customerEmail: string | null; customerName: string | null; triageQuestions: string[] }
  latestInboundBody: string
  /** Phase 6: the org has already spent its daily embedding budget. Read HERE, in the same read
   *  transaction as everything else, so the embed below is skipped rather than billed. */
  atEmbedCap: boolean
}

async function loadDraft(db: Db, orgId: string, draftId: string, day: string, now: Date): Promise<Loaded | null> {
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
    // The SAME meter and the SAME per-org setting `knowledge.embed-batch` spends from — one
    // workspace budget covers chunk vectors and answer vectors alike.
    const [counter] = await tx.select({ value: usageCounters.value }).from(usageCounters)
      .where(and(eq(usageCounters.day, day), eq(usageCounters.meter, KNOWLEDGE_METERS.embedTokens)))
    const cap = resolveSetting('knowledge.daily_embed_tokens_cap', await loadSettingSources(tx, ['knowledge.daily_embed_tokens_cap'], now))

    const grounding = (d.confidenceBreakdown as { grounding?: { knowledgeVersion?: unknown } }).grounding
    return {
      atEmbedCap: (counter?.value ?? 0) >= cap,
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
  const { orgId } = payload
  if (payload.messageId !== undefined) return captureFromMessage(deps, orgId, payload.messageId, signal)
  if (payload.draftId !== undefined) return captureFromDraft(deps, orgId, payload.draftId, signal)
  // Defensive only: `registerJob` always re-validates against `MemoryCapturePayload` before a
  // handler ever sees a payload, so this is unreachable from pg-boss — only a direct, bypassing call.
  throw new Error('memory.capture: payload must carry exactly one of draftId or messageId')
}

async function captureFromDraft(deps: MemoryCaptureDeps, orgId: string, draftId: string, signal: AbortSignal): Promise<'captured' | 'reinforced' | 'skipped'> {
  const now = deps.now?.() ?? new Date()
  const day = utcDayString(now)
  const loaded = await loadDraft(deps.db, orgId, draftId, day, now)
  if (!loaded) return 'skipped'
  const { draft, ticket } = loaded

  // At cap: stamp anyway. The alternative — leaving `memory_captured_at` null — would have the
  // `short` queue's redelivery (and every later one) retry a draft the budget will still refuse,
  // and this reply is not coming back tomorrow. One answer is worth less than a stuck queue.
  if (loaded.atEmbedCap) {
    return withOrg(deps.db, orgId, async (tx): Promise<'skipped'> => {
      const stamped = await tx.update(drafts).set({ memoryCapturedAt: now })
        .where(and(eq(drafts.id, draftId), sql`${drafts.memoryCapturedAt} IS NULL`)).returning({ id: drafts.id })
      if (stamped.length === 0) return 'skipped'
      await audit(tx, { actor: ACTOR, action: 'memory.skipped', entityType: 'draft', entityId: draftId, detail: { reason: 'embed_cap' } })
      return 'skipped'
    })
  }
  const scrub = { customerName: ticket.customerName, customerEmail: ticket.customerEmail }
  const rawQuestion = ticket.triageQuestions.filter((q) => q.trim() !== '').join('\n') || loaded.latestInboundBody.slice(0, TEXT_QUESTION_CHARS)
  const question = scrubForMemory(rawQuestion, scrub)
  const answer = scrubForMemory(draft.finalBody, scrub)
  const auto = draft.decisionSource === 'auto'
  const edited = draft.editDistanceRatio > 0

  // ── the embed, between transactions; a throw leaves the draft unstamped for the retry ──
  let vector: number[] | null = null
  let embedTokens = 0
  if (question.length > 0 && answer.length > 0) {
    const { vectors, tokens } = await deps.embedder.embed([question], 'document', signal)
    vector = vectors[0] ?? null
    embedTokens = tokens
  }

  return withOrg(deps.db, orgId, async (tx) => {
    // The idempotency gate FIRST: zero rows means another delivery captured this draft.
    const stamped = await tx.update(drafts).set({ memoryCapturedAt: now })
      .where(and(eq(drafts.id, draftId), sql`${drafts.memoryCapturedAt} IS NULL`)).returning({ id: drafts.id })
    if (stamped.length === 0) return 'skipped'
    // Phase 6: what this capture actually cost, on the same meter `knowledge.embed-batch` bumps.
    if (embedTokens > 0) await bumpMeter(tx, orgId, day, KNOWLEDGE_METERS.embedTokens, embedTokens)
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

// ─────────────────────────────────────────────────────────────────────────────
// "Remember this reply" (messageId) — Phase 7
// ─────────────────────────────────────────────────────────────────────────────

interface LoadedRemember {
  message: { id: string; ticketId: string; bodyText: string }
  ticket: { customerEmail: string | null; customerName: string | null }
  questionBody: string
  atEmbedCap: boolean
}

/** Every non-`ok` load carries the REASON it refused, and every one of them is audited (ruling R20).
 *  The four the api's `rememberReply` screens at request time are still here as a backstop: reaching
 *  the job means something changed between the tap and the run (a body purged by `retention.sweep`, a
 *  message deleted), and that is exactly when the record earns its keep. */
type RememberSkip = 'not_found' | 'not_outbound' | 'not_sent' | 'empty' | 'no_question' | 'already_remembered'

type RememberLoad =
  | { status: 'ok'; data: LoadedRemember }
  | { status: 'skip'; reason: RememberSkip }

/**
 * The read half. Checks the unique index's target FIRST — "the job checks first" — so the common
 * case (a message nobody has remembered yet) never even reaches a validity check it would fail
 * anyway, and a genuine duplicate short-circuits before touching `messages`/`tickets` at all.
 */
async function loadRemember(db: Db, orgId: string, messageId: string, day: string, now: Date): Promise<RememberLoad> {
  return withOrg(db, orgId, async (tx) => {
    const [already] = await tx.select({ id: resolvedAnswers.id }).from(resolvedAnswers)
      .where(and(eq(resolvedAnswers.orgId, orgId), eq(resolvedAnswers.sourceMessageId, messageId)))
    if (already) return { status: 'skip', reason: 'already_remembered' }

    const [m] = await tx.select({
      id: messages.id, ticketId: messages.ticketId, direction: messages.direction,
      bodyText: messages.bodyText, sentAt: messages.sentAt,
    }).from(messages).where(eq(messages.id, messageId))
    // One check per line, each with its own reason: "this is not a reply", "this reply never went
    // out", "there is no text left" and "there is no such message" are four different answers to the
    // owner who tapped Remember this reply, and lumping them was the silence R20 closes.
    if (!m) return { status: 'skip', reason: 'not_found' }
    if (m.direction !== 'outbound') return { status: 'skip', reason: 'not_outbound' }
    if (m.sentAt === null) return { status: 'skip', reason: 'not_sent' }
    if (m.bodyText === null) return { status: 'skip', reason: 'empty' }

    const [t] = await tx.select({ customerEmail: tickets.customerEmail, customerName: tickets.customerName })
      .from(tickets).where(eq(tickets.id, m.ticketId))
    if (!t) return { status: 'skip', reason: 'not_found' }

    // The latest inbound STRICTLY BEFORE this reply — never the ticket's overall latest inbound,
    // which could be a message that arrived AFTER this reply was sent (a chasing customer).
    const [inbound] = await tx.select({ bodyText: messages.bodyText }).from(messages)
      .where(and(eq(messages.ticketId, m.ticketId), eq(messages.direction, 'inbound'), lt(messages.sentAt, m.sentAt)))
      .orderBy(sql`${messages.sentAt} DESC NULLS LAST`, sql`${messages.createdAt} DESC`).limit(1)
    if (!inbound || inbound.bodyText === null) return { status: 'skip', reason: 'no_question' }

    const [counter] = await tx.select({ value: usageCounters.value }).from(usageCounters)
      .where(and(eq(usageCounters.day, day), eq(usageCounters.meter, KNOWLEDGE_METERS.embedTokens)))
    const cap = resolveSetting('knowledge.daily_embed_tokens_cap', await loadSettingSources(tx, ['knowledge.daily_embed_tokens_cap'], now))

    return {
      status: 'ok',
      data: {
        message: { id: m.id, ticketId: m.ticketId, bodyText: m.bodyText },
        ticket: t,
        questionBody: inbound.bodyText.slice(0, TEXT_QUESTION_CHARS),
        atEmbedCap: (counter?.value ?? 0) >= cap,
      },
    }
  })
}

async function skipRemember(
  deps: MemoryCaptureDeps, orgId: string, messageId: string, reason: RememberSkip | 'embed_cap' | 'empty_after_scrub',
): Promise<'skipped'> {
  await withOrg(deps.db, orgId, (tx) =>
    audit(tx, { actor: ACTOR, action: 'memory.skipped', entityType: 'message', entityId: messageId, detail: { reason } }))
  return 'skipped'
}

async function captureFromMessage(deps: MemoryCaptureDeps, orgId: string, messageId: string, signal: AbortSignal): Promise<'captured' | 'skipped'> {
  const now = deps.now?.() ?? new Date()
  const day = utcDayString(now)
  const loaded = await loadRemember(deps.db, orgId, messageId, day, now)

  // Ruling R20: a human tap must not vanish. EVERY refusal is audited under its own reason — there
  // is no silent branch left on this path.
  if (loaded.status === 'skip') return skipRemember(deps, orgId, messageId, loaded.reason)

  const { message, ticket, questionBody, atEmbedCap } = loaded.data
  // Same rule as the draft path: at cap, skip rather than spend — there is no per-message stamp to
  // gate a retry on (unlike `drafts.memory_captured_at`), so a later run simply tries again once the
  // day's budget resets; nothing here needs to remember that this attempt happened.
  if (atEmbedCap) return skipRemember(deps, orgId, messageId, 'embed_cap')

  const scrub = { customerName: ticket.customerName, customerEmail: ticket.customerEmail }
  const question = scrubForMemory(questionBody, scrub)
  const answer = scrubForMemory(message.bodyText, scrub)
  if (question.length === 0 || answer.length === 0) return skipRemember(deps, orgId, messageId, 'empty_after_scrub')

  // ── the embed, between transactions ──
  const { vectors, tokens } = await deps.embedder.embed([question], 'document', signal)
  const vector = vectors[0] ?? null
  if (vector === null) return skipRemember(deps, orgId, messageId, 'empty_after_scrub')

  return withOrg(deps.db, orgId, async (tx) => {
    // The unique index is the hard guarantee; this re-check under the SAME transaction as the
    // insert is what turns a genuine race into a clean 'skipped' rather than a constraint throw.
    const [already] = await tx.select({ id: resolvedAnswers.id }).from(resolvedAnswers)
      .where(and(eq(resolvedAnswers.orgId, orgId), eq(resolvedAnswers.sourceMessageId, messageId)))
    if (already) {
      await audit(tx, { actor: ACTOR, action: 'memory.skipped', entityType: 'message', entityId: messageId, detail: { reason: 'already_remembered' } })
      return 'skipped'
    }
    if (tokens > 0) await bumpMeter(tx, orgId, day, KNOWLEDGE_METERS.embedTokens, tokens)
    const salt = await ensureCustomerHashSalt(tx, orgId)
    const sourceCustomerHash = ticket.customerEmail ? customerHash(salt, ticket.customerEmail) : null
    const expiresAt = new Date(now.getTime() + MEMORY_EXPIRY_DAYS * 86_400_000)

    const [inserted] = await tx.insert(resolvedAnswers).values({
      orgId, agentId: null, categoryId: null, questionText: question, answerBody: answer,
      questionEmbedding: vector, embeddingModel: deps.embedder.model, embeddingVersion: deps.embedder.version,
      status: 'active', approvals: 1, wasEdited: false,
      sourceTicketId: message.ticketId, sourceDraftId: null, sourceMessageId: messageId, sourceCustomerHash,
      lastApprovedAt: now, expiresAt,
    }).returning({ id: resolvedAnswers.id })
    await audit(tx, {
      actor: ACTOR, action: 'memory.captured', entityType: 'message', entityId: messageId,
      detail: { answerId: inserted!.id, status: 'active', questionChars: question.length, answerChars: answer.length },
    })
    return 'captured'
  })
}
