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
 *    already wrote stay written, so the retry only embeds what is still null.
 *  - a non-retryable one (a bad key, a permanent refusal) fails the source `embed_failed` and returns.
 *  - the org's daily embed-token cap fails the source `cap_reached` before the first call.
 */
import { and, asc, eq, isNull, sql } from 'drizzle-orm'
import type PgBoss from 'pg-boss'
import { z } from 'zod'
import { resolveSetting } from '@aesa/core'
import {
  audit, bumpMeter, knowledgeChunks, knowledgeDocuments, knowledgeSources, KNOWLEDGE_METERS,
  usageCounters, withOrg,
} from '@aesa/db'
import { batchTexts, EmbedError, vectorLiteral } from '@aesa/knowledge'
import { defineJob, enqueue, JOB_NAMES, registerJob, type JobDefinition } from '@aesa/queue'
import { utcDayString } from '../date-utils.ts'
import { failSource, guardedSourceWrite, loadOrgSettings } from '../knowledge/sources.ts'
import type { KnowledgeDeps } from '../knowledge-deps.ts'

export const KnowledgeEmbedBatchPayload = z.object({ orgId: z.string(), documentId: z.string() })
export type KnowledgeEmbedBatchPayload = z.infer<typeof KnowledgeEmbedBatchPayload>

const ACTOR = 'system:knowledge.embed-batch' as const

export const knowledgeEmbedBatchJob: JobDefinition<KnowledgeEmbedBatchPayload> = defineJob({
  name: JOB_NAMES.knowledgeEmbedBatch,
  schema: KnowledgeEmbedBatchPayload,
  // retryLimit 5 with backoff: Voyage's 429s are the expected failure here, and every retry starts
  // from whatever is still unembedded rather than redoing work.
  queue: { expireInSeconds: 300, retryLimit: 5, retryBackoff: true, policy: 'short' },
  handler: async () => {
    throw new Error('knowledge.embed-batch: this definition has no bound deps — register it through registerKnowledgeEmbedBatch(boss, deps)')
  },
})

interface Pending {
  sourceId: string
  sourceKind: string
  sourceStatus: string
  chunks: { id: string; content: string }[]
  capExhausted: boolean
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
      chunks, capExhausted: (counter?.value ?? 0) >= cap,
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

    const written = await guardedSourceWrite(tx, pending.sourceId, ['processing'], { status: 'ready', completedAt: now })
    if (!written) return
    await audit(tx, { actor: ACTOR, action: 'knowledge.source.ready', entityType: 'knowledge_source', entityId: pending.sourceId, detail: {} })
  })
}

export async function runKnowledgeEmbedBatch(deps: KnowledgeDeps, payload: KnowledgeEmbedBatchPayload, signal: AbortSignal): Promise<void> {
  const { orgId, documentId } = payload
  const now = deps.now?.() ?? new Date()
  const day = utcDayString(now)

  const pending = await loadPending(deps, orgId, documentId, day)
  if (!pending) return

  if (pending.capExhausted) {
    // The owner sees a failed source rather than a silently half-embedded one; re-running it after
    // midnight UTC is Phase 7's sweep, not this job's business.
    await failSource(deps.db, {
      orgId, sourceId: pending.sourceId, actor: ACTOR, reason: 'cap_reached',
      detail: "the workspace's daily embedding budget is used up; this source resumes after midnight UTC", now,
    })
    return
  }

  if (pending.chunks.length > 0) {
    // `batchTexts` packs under BOTH the 128-text and the 100k-token ceilings; the order it preserves
    // is what lines each returned vector up with its chunk.
    const batches = batchTexts(pending.chunks.map((c) => c.content))
    let cursor = 0

    for (const batch of batches) {
      const slice = pending.chunks.slice(cursor, cursor + batch.length)
      cursor += batch.length

      let embedded: { vectors: number[][]; tokens: number }
      try {
        embedded = await deps.embedder.embed(batch, 'document', signal)
      } catch (err) {
        if (err instanceof EmbedError && !err.retryable) {
          await failSource(deps.db, { orgId, sourceId: pending.sourceId, actor: ACTOR, reason: 'embed_failed', detail: err.message, now })
          return
        }
        throw err // retryable (or unknown): pg-boss retries with backoff, already-written rows stand
      }

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
  const wired: JobDefinition<KnowledgeEmbedBatchPayload> = {
    ...knowledgeEmbedBatchJob,
    handler: async (ctx) => {
      await runKnowledgeEmbedBatch(deps, ctx.data, ctx.signal)
    },
  }
  await registerJob(boss, wired)
}

export async function enqueueKnowledgeEmbedBatch(boss: PgBoss, orgId: string, documentId: string): Promise<string | null> {
  return enqueue(boss, knowledgeEmbedBatchJob, { orgId, documentId }, { entityId: documentId })
}
