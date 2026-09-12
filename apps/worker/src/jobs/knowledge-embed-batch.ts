/**
 * The `knowledge.embed-batch` job (spec §Knowledge & learning): fills in every missing vector for
 * ONE document — the unit `knowledge.ingest` and `knowledge.crawl` both hand off (plan deviation 7:
 * one job per document, not per arbitrary chunk batch, so a job is bounded by a document's ≤ 2,000
 * chunks).
 *
 * **Every `embedder.embed` call happens OUTSIDE every `withOrg` transaction**: one read transaction
 * up front, then embed → short write transaction, embed → short write transaction, …
 *
 * Failure kinds:
 *  - a RETRYABLE `EmbedError` (429, 5xx) rethrows: pg-boss retries with backoff and the rows it
 *    already wrote stay written, so the retry only embeds what is still null. On the LAST attempt
 *    it does NOT rethrow — see `isLastAttempt` below.
 *  - a non-retryable one (a bad key, a permanent refusal) records `embed_failed` and returns.
 *  - the org's daily embed-token cap records `cap_reached` — before the first call, and again
 *    between calls once this job's own spend has used the rest of the budget up.
 *
 * `EmbedError.retryAfterMs` (Voyage's `Retry-After`) is deliberately NOT honoured: pg-boss computes
 * a retry's `start_after` from the QUEUE's `retry_delay` in its fail SQL, so a handler cannot ask
 * for a longer wait, and sleeping here instead would hold the worker slot and burn the job's own
 * 300 s expiry. The 30 s base with backoff is the answer to a `Retry-After` we cannot pass on.
 *
 * "Records" is not always "fails": on an UPLOAD or PASTE source this job owns the terminal status and
 * flips it to `failed`, but on a CRAWL source that is still `processing` it writes only
 * `failure_reason`/`failure_detail` and leaves the status alone. A crawl is still walking while its
 * first documents are embedding — flipping that source to `failed` here would strand a live crawl
 * whose own claim it does not hold. The crawl's end transition decides the status from the reason.
 * The one exception is a crawl that has ALREADY landed `ready` (its last batch's embed jobs can
 * finish after it does): there is no end transition left to read the reason, so this job lands
 * `failed` itself — see `recordFailure`.
 */
import { and, asc, eq, isNull, sql } from 'drizzle-orm'
import type PgBoss from 'pg-boss'
import { z } from 'zod'
import type { KnowledgeFailureReason } from '@aesa/contracts'
import { resolveSetting } from '@aesa/core'
import {
  audit, bumpMeter, knowledgeChunks, knowledgeDocuments, knowledgeSources, KNOWLEDGE_METERS,
  usageCounters, withOrg,
} from '@aesa/db'
import { batchTexts, EmbedError, vectorLiteral } from '@aesa/knowledge'
import { defineJob, enqueue, JOB_NAMES, registerJob, type RegisteredJobDefinition } from '@aesa/queue'
import { utcDayString } from '../date-utils.ts'
import { errorMessage } from '../err-message.ts'
import {
  failSource, FAILURE_DETAIL_MAX, guardedSourceWrite, guardedSourceWriteReturning, loadOrgSettings,
} from '../knowledge/sources.ts'
import type { KnowledgeDeps } from '../knowledge-deps.ts'

export const KnowledgeEmbedBatchPayload = z.object({ orgId: z.string(), documentId: z.string() })
export type KnowledgeEmbedBatchPayload = z.infer<typeof KnowledgeEmbedBatchPayload>

const ACTOR = 'system:knowledge.embed-batch' as const

export const knowledgeEmbedBatchJob: RegisteredJobDefinition<KnowledgeEmbedBatchPayload> = defineJob({
  name: JOB_NAMES.knowledgeEmbedBatch,
  schema: KnowledgeEmbedBatchPayload,
  // retryLimit 5 with backoff (QUEUE_OPTIONS): Voyage's 429s are the expected failure here, and
  // every retry starts from whatever is still unembedded rather than redoing work. `retryDelay: 30`
  // is what makes that budget worth having — pg-boss's default base of 1 s put the five retries at
  // ~1/2/4/8/16 s, one minute of outage in total; 30 s of base with backoff spans ~15 minutes
  // instead (final-B1).
  handler: async () => {
    throw new Error('knowledge.embed-batch: this definition has no bound deps — register it through registerKnowledgeEmbedBatch(boss, deps)')
  },
})

interface Pending {
  sourceId: string
  sourceKind: string
  sourceStatus: string
  chunks: { id: string; content: string }[]
  /** The org's embed-token spend for `day` as this job started — the base its own spend adds to. */
  spentTokens: number
  /** `knowledge.daily_embed_tokens_cap` for the org. */
  capTokens: number
}

/**
 * Records this job's verdict on the source. An ingest source is flipped `failed` outright; a crawl
 * source that is still `processing` only carries the reason, and `knowledge.crawl`'s end transition
 * turns it into a status.
 *
 * The one exception is a crawl source that has ALREADY landed `ready`: the crawl's end transition
 * runs as soon as its last batch is enqueued, so a verdict on those last documents can arrive after
 * it (final-B2). Nothing is going to read the reason then, so this write lands the status itself —
 * `ready` carries no claim token (the crawl released it) and the source is otherwise left showing
 * chunks that will never get vectors. `completed_at` stays: the walk really did finish then.
 */
async function recordFailure(
  deps: KnowledgeDeps,
  orgId: string,
  pending: Pending,
  reason: KnowledgeFailureReason,
  detail: string,
  now: Date,
): Promise<void> {
  if (pending.sourceKind !== 'crawl') {
    await failSource(deps.db, { orgId, sourceId: pending.sourceId, actor: ACTOR, reason, detail, now })
    return
  }
  await withOrg(deps.db, orgId, async (tx) => {
    // No claim token: the crawl holds it while it is `processing` and has released it by `ready`.
    // Guarded on both statuses all the same, so a crawl that has landed `failed` — or a source the
    // owner has since deleted or re-queued — keeps whatever verdict it reached.
    const landed = await guardedSourceWriteReturning(tx, pending.sourceId, ['processing', 'ready'], {
      status: sql`case when ${knowledgeSources.status} = 'ready' then 'failed' else ${knowledgeSources.status} end`,
      failureReason: reason,
      failureDetail: detail.slice(0, FAILURE_DETAIL_MAX),
      // FIRST verdict only. A `cap_reached` crawl fails every remaining document's embed job the
      // same way, and re-recording the reason per document would write up to 200 identical audit
      // rows for one budget (final-B minor). The reason is cleared by the next claim, so this never
      // hides a verdict from a LATER walk.
    }, undefined, isNull(knowledgeSources.failureReason))
    if (!landed) return
    await audit(tx, {
      actor: ACTOR, action: 'knowledge.source.embed_failed', entityType: 'knowledge_source', entityId: pending.sourceId,
      detail: { reason, status: landed.status },
    })
  })
}

/** One read transaction: the document's source, its unembedded chunks, and today's token spend. */
async function loadPending(deps: KnowledgeDeps, orgId: string, documentId: string, day: string): Promise<Pending | null> {
  return withOrg(deps.db, orgId, async (tx) => {
    const [doc] = await tx
      .select({ sourceId: knowledgeDocuments.sourceId })
      .from(knowledgeDocuments)
      .where(eq(knowledgeDocuments.id, documentId))
    if (!doc) return null

    const [source] = await tx
      .select({ kind: knowledgeSources.kind, status: knowledgeSources.status })
      .from(knowledgeSources)
      .where(eq(knowledgeSources.id, doc.sourceId))
    if (!source) return null

    // The partial index `knowledge_chunks_unembedded_idx` (org_id, document_id) WHERE embedding IS NULL.
    const chunks = await tx
      .select({ id: knowledgeChunks.id, content: knowledgeChunks.content })
      .from(knowledgeChunks)
      .where(and(eq(knowledgeChunks.documentId, documentId), isNull(knowledgeChunks.embedding)))
      .orderBy(asc(knowledgeChunks.ordinal))

    const [counter] = await tx
      .select({ value: usageCounters.value })
      .from(usageCounters)
      .where(and(eq(usageCounters.day, day), eq(usageCounters.meter, KNOWLEDGE_METERS.embedTokens)))
    const cap = resolveSetting('knowledge.daily_embed_tokens_cap', { org: await loadOrgSettings(tx, ['knowledge.daily_embed_tokens_cap']) })

    return {
      sourceId: doc.sourceId, sourceKind: source.kind, sourceStatus: source.status,
      chunks, spentTokens: counter?.value ?? 0, capTokens: cap,
    }
  })
}

/**
 * The source flips to `ready` HERE only for ingest sources (upload/paste): a crawl source is flipped
 * by `knowledge.crawl` itself once the walk finishes, because a crawl that is still running has more
 * documents coming and "every document embedded" says nothing about whether it is done.
 */
async function maybeFlipSourceReady(deps: KnowledgeDeps, orgId: string, pending: Pending, now: Date): Promise<void> {
  if (pending.sourceKind === 'crawl' || pending.sourceStatus !== 'processing') return

  await withOrg(deps.db, orgId, async (tx) => {
    const [outstanding] = await tx
      .select({ value: sql<number>`count(*)::int` })
      .from(knowledgeDocuments)
      .where(and(eq(knowledgeDocuments.sourceId, pending.sourceId), sql`${knowledgeDocuments.embeddedCount} < ${knowledgeDocuments.chunkCount}`))
    if ((outstanding?.value ?? 0) > 0) return

    const written = await guardedSourceWrite(tx, pending.sourceId, ['processing'], { status: 'ready', completedAt: now, claimToken: null })
    if (!written) return
    await audit(tx, { actor: ACTOR, action: 'knowledge.source.ready', entityType: 'knowledge_source', entityId: pending.sourceId, detail: {} })
  })
}

/**
 * pg-boss's own metadata for THIS attempt (`registerJob` passes `ctx.job` through). Absent means
 * "not the last attempt" — a direct call from a test or a script has no retry budget behind it.
 * pg-boss increments `retry_count` as it re-fetches a job, and its fail SQL lands `failed` (not
 * `retry`) once `retry_count = retry_limit`, so equality here IS the last attempt.
 */
export interface EmbedAttempt { retryCount: number; retryLimit: number }

const isLastAttempt = (attempt?: EmbedAttempt): boolean =>
  attempt !== undefined && attempt.retryCount >= attempt.retryLimit

export async function runKnowledgeEmbedBatch(
  deps: KnowledgeDeps,
  payload: KnowledgeEmbedBatchPayload,
  signal: AbortSignal,
  attempt?: EmbedAttempt,
): Promise<void> {
  const { orgId, documentId } = payload
  const now = deps.now?.() ?? new Date()
  const day = utcDayString(now)

  const pending = await loadPending(deps, orgId, documentId, day)
  if (!pending) return

  /** The owner sees a failed source rather than a silently half-embedded one; re-running it after
   *  midnight UTC is Phase 7's sweep, not this job's business. */
  const recordCapReached = () => recordFailure(
    deps, orgId, pending, 'cap_reached',
    "the workspace's daily embedding budget is used up; this source resumes after midnight UTC", now,
  )

  if (pending.chunks.length > 0) {
    // `batchTexts` packs under all three of the 128-text, the 100k-token and the 120k-character
    // ceilings (the last is the floor under the token estimate for CJK text); the order it
    // preserves is what lines each returned vector up with its chunk.
    const batches = batchTexts(pending.chunks.map((c) => c.content))
    let cursor = 0
    // The day's spend as this job started, plus what this job has spent since. Checked before EVERY
    // call rather than once per job (final-B minor): a 2,000-chunk document is ~16 Voyage calls, and
    // one cap check up front let a single job run the whole way past the budget. Concurrent jobs
    // still spend against the same counter, so the bound is "overshoots by at most one batch".
    let spent = pending.spentTokens

    for (const batch of batches) {
      if (spent >= pending.capTokens) {
        await recordCapReached()
        return
      }
      const slice = pending.chunks.slice(cursor, cursor + batch.length)
      cursor += batch.length

      let embedded: { vectors: number[][]; tokens: number }
      try {
        embedded = await deps.embedder.embed(batch, 'document', signal)
      } catch (err) {
        if (err instanceof EmbedError && !err.retryable) {
          await recordFailure(deps, orgId, pending, 'embed_failed', err.message, now)
          return
        }
        if (isLastAttempt(attempt)) {
          // The retry budget is gone (a Voyage outage longer than the ~15-minute window). Rethrowing
          // would land the job `failed` and leave an INGEST source `processing` with a claim token
          // nothing will ever release — no sweep clears it and `completeUpload` needs `queued`
          // (final-B1). Land the verdict instead; the detail is operator-facing, so only an
          // `EmbedError`'s own provider message goes in it.
          deps.logger.warn(
            { sourceId: pending.sourceId, documentId, error: errorMessage(err) },
            'knowledge.embed-batch: retries exhausted; recording embed_failed',
          )
          const detail = err instanceof EmbedError ? err.message : 'the embedding provider could not be reached'
          await recordFailure(deps, orgId, pending, 'embed_failed', detail, now)
          return
        }
        throw err // retryable (or unknown): pg-boss retries with backoff, already-written rows stand
      }
      spent += embedded.tokens

      await withOrg(deps.db, orgId, async (tx) => {
        let written = 0
        for (const [index, chunk] of slice.entries()) {
          const vector = embedded.vectors[index]
          if (!vector) continue
          const rows = await tx
            .update(knowledgeChunks)
            .set({
              embedding: vectorLiteral(vector) as never,
              embeddingModel: deps.embedder.model,
              embeddingVersion: deps.embedder.version,
            })
            // `org_id` is redundant under RLS and deliberate: the vector about to be written is the
            // one thing in this pipeline a cross-tenant bug could not be walked back from.
            .where(and(eq(knowledgeChunks.id, chunk.id), eq(knowledgeChunks.orgId, orgId)))
            .returning({ id: knowledgeChunks.id })
          written += rows.length
        }
        await bumpMeter(tx, orgId, day, KNOWLEDGE_METERS.embedTokens, embedded.tokens)
        if (written > 0) {
          await tx
            .update(knowledgeDocuments)
            .set({ embeddedCount: sql`least(${knowledgeDocuments.embeddedCount} + ${written}, ${knowledgeDocuments.chunkCount})` })
            .where(eq(knowledgeDocuments.id, documentId))
        }
      })
    }
  }

  await maybeFlipSourceReady(deps, orgId, pending, now)
}

export async function registerKnowledgeEmbedBatch(boss: PgBoss, deps: KnowledgeDeps): Promise<void> {
  const wired: RegisteredJobDefinition<KnowledgeEmbedBatchPayload> = {
    ...knowledgeEmbedBatchJob,
    handler: async (ctx) => {
      // `includeMetadata` is on for every queue (registerJob), so `retryCount`/`retryLimit` are the
      // real ones — that is how the handler knows this is the attempt with nothing after it.
      await runKnowledgeEmbedBatch(deps, ctx.data, ctx.signal, { retryCount: ctx.job.retryCount, retryLimit: ctx.job.retryLimit })
    },
  }
  await registerJob(boss, wired)
}

export async function enqueueKnowledgeEmbedBatch(boss: PgBoss, orgId: string, documentId: string): Promise<string | null> {
  return enqueue(boss, knowledgeEmbedBatchJob, { orgId, documentId }, { entityId: documentId })
}
