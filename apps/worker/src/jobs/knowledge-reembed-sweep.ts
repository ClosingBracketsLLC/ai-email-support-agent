/**
 * `knowledge.reembed-sweep` (Phase 7): what makes `KNOWLEDGE_EMBED_MODEL` changeable on a LIVE
 * workspace at all. Retrieval's vector leg additionally filters on `embedding_model`
 * (CLAUDE.md Retrieval), so a chunk or a resolved answer embedded under a model the org no longer
 * runs simply never scores on that leg again — this sweep is what re-embeds it under the currently
 * configured model.
 *
 * Two arms, run every 10 minutes, each bounded so one pass never runs long:
 *
 *  - **Chunks** (`REEMBED_DOCS_PER_RUN` documents per run): `knowledge-embed-batch.ts`'s own
 *    selection predicate is `embedding IS NULL` (the partial index `knowledge_chunks_unembedded_idx`)
 *    — never `embedding_model <> $current` — so this arm's whole job is to NULL a document's stale
 *    vectors (a guarded write, re-checked at write time) and re-enqueue `knowledge.embed-batch`,
 *    which then refills them under whatever model the org runs today. **`knowledge_version` is
 *    deliberately NEVER bumped here**: that counter tracks the set of RETRIEVABLE chunks, and a
 *    chunk stays retrievable through the LEXICAL leg the whole time this arm runs — nulling a
 *    vector only degrades how well the VECTOR leg scores it until the re-embed lands, it never
 *    removes the chunk from what a draft can cite (CLAUDE.md Knowledge bounds).
 *  - **Answers** (`REEMBED_ANSWERS_PER_RUN` `resolved_answers` rows per run, `status = 'active'`
 *    only — a `candidate`/`needs_review`/`retired` row is never retrieved regardless of its vector,
 *    so re-embedding one would spend budget for nothing): unlike chunks, an answer's vector cannot
 *    be filled in by a LATER job — there is no `answer.embed-batch` — so this arm embeds it itself,
 *    grouped by org (the daily cap and the meter are per-org), cap-checked BEFORE spending exactly
 *    as `memory-capture.ts` does, and written back with a guarded per-row UPDATE.
 *
 * **The embed call is network I/O and never runs inside a `withOrg`/`withPlatform` transaction**
 * (CLAUDE.md Transactions): both arms read inside one transaction, embed (or nothing, for the chunk
 * arm — it never calls the embedder itself) between transactions, and write back in a second short
 * transaction guarded on what was actually read.
 */
import { and, asc, count, eq, isNotNull, ne } from 'drizzle-orm'
import type PgBoss from 'pg-boss'
import { resolveSetting } from '@aesa/core'
import {
  audit, bumpMeter, knowledgeChunks, knowledgeDocuments, KNOWLEDGE_METERS, loadSettingSources,
  resolvedAnswers, usageCounters, withOrg, withPlatform,
} from '@aesa/db'
import { vectorLiteral } from '@aesa/knowledge'
import { registerCron } from '@aesa/queue'
import { utcDayString } from '../date-utils.ts'
import { errorMessage } from '../err-message.ts'
import type { KnowledgeDeps } from '../knowledge-deps.ts'
import { alert } from '../observability.ts'

const SWEEP_REASON = 'cron:knowledge.reembed-sweep'
const ACTOR = 'system:cron:knowledge.reembed-sweep' as const

/** Bounds the chunk arm — one job per document, so this is also (at most) this many
 *  `knowledge.embed-batch` enqueues per run. */
export const REEMBED_DOCS_PER_RUN = 20
/** Bounds the answers arm — one Voyage/hash call per ORG group within this, never per row. */
export const REEMBED_ANSWERS_PER_RUN = 128

interface StaleDoc { orgId: string; documentId: string }

/**
 * Arm 1: nulls a document's stale-model chunks, resets `embedded_count` to what remains embedded,
 * and reports whether anything actually changed (a `false` here means another process already
 * refreshed every chunk between discovery and this write — the guard matched nothing, correctly).
 */
async function reembedDocument(deps: KnowledgeDeps, orgId: string, documentId: string, currentModel: string): Promise<boolean> {
  return withOrg(deps.db, orgId, async (tx) => {
    // Guarded on the SAME predicate discovery used (`<> currentModel`), re-evaluated at write
    // time — not a captured "old value": a document with more than one stale model in its history
    // (rare — the org changed models twice before a sweep ever ran) is nulled in ONE update instead
    // of needing to be revisited once per distinct old value.
    const nulled = await tx.update(knowledgeChunks)
      .set({ embedding: null, embeddingModel: null, embeddingVersion: null })
      .where(and(
        eq(knowledgeChunks.documentId, documentId), isNotNull(knowledgeChunks.embedding),
        ne(knowledgeChunks.embeddingModel, currentModel),
      ))
      .returning({ id: knowledgeChunks.id })
    if (nulled.length === 0) return false

    const [remaining] = await tx.select({ value: count() }).from(knowledgeChunks)
      .where(and(eq(knowledgeChunks.documentId, documentId), isNotNull(knowledgeChunks.embedding)))
    await tx.update(knowledgeDocuments).set({ embeddedCount: remaining?.value ?? 0 }).where(eq(knowledgeDocuments.id, documentId))
    // Deliberately no `bumpKnowledgeVersion` here — see the file header.
    await audit(tx, {
      actor: ACTOR, action: 'knowledge.source.reembed_queued', entityType: 'knowledge_document', entityId: documentId,
      detail: { chunksNulled: nulled.length, model: currentModel },
    })
    return true
  })
}

/** Arm 2's read: does ORG's cap already cover today's spend? (`memory-capture.ts:66-68`'s shape.) */
async function atEmbedCap(deps: KnowledgeDeps, orgId: string, day: string, now: Date): Promise<boolean> {
  return withOrg(deps.db, orgId, async (tx) => {
    const [counter] = await tx.select({ value: usageCounters.value }).from(usageCounters)
      .where(and(eq(usageCounters.day, day), eq(usageCounters.meter, KNOWLEDGE_METERS.embedTokens)))
    const cap = resolveSetting('knowledge.daily_embed_tokens_cap', await loadSettingSources(tx, ['knowledge.daily_embed_tokens_cap'], now))
    return (counter?.value ?? 0) >= cap
  })
}

interface StaleAnswer { id: string; orgId: string; questionText: string; embeddingModel: string }

export async function runKnowledgeReembedSweep(
  boss: PgBoss,
  deps: KnowledgeDeps,
): Promise<{ documentsQueued: number; answersReembedded: number; skippedCap: number }> {
  const now = deps.now?.() ?? new Date()
  const day = utcDayString(now)
  const currentModel = deps.embedder.model

  // ---- Arm 1: chunks ----
  const staleDocs: StaleDoc[] = await withPlatform(deps.db, SWEEP_REASON, (tx) =>
    tx.selectDistinct({ orgId: knowledgeChunks.orgId, documentId: knowledgeChunks.documentId })
      .from(knowledgeChunks)
      .where(and(isNotNull(knowledgeChunks.embedding), isNotNull(knowledgeChunks.embeddingModel), ne(knowledgeChunks.embeddingModel, currentModel)))
      .orderBy(asc(knowledgeChunks.documentId))
      .limit(REEMBED_DOCS_PER_RUN))

  let documentsQueued = 0
  const toEnqueue: StaleDoc[] = []
  for (const { orgId, documentId } of staleDocs) {
    try {
      if (await reembedDocument(deps, orgId, documentId, currentModel)) {
        documentsQueued += 1
        toEnqueue.push({ orgId, documentId })
      }
    } catch (err) {
      deps.logger.warn({ documentId, error: errorMessage(err) }, 'knowledge_reembed_sweep_document_failed')
    }
  }
  for (const { orgId, documentId } of toEnqueue) {
    try {
      await deps.enqueueEmbedBatch(orgId, documentId)
    } catch (err) {
      // Unlike every other enqueue failure in this file, this one is NOT self-healing: discovery's
      // own predicate requires `embedding IS NOT NULL` (a document with vectors still to null), and
      // this document's chunks are already null with nothing queued to refill them — a future run
      // will never see it again. Narrow trigger, unrecoverable state; raised to `error` rather than
      // left at one easy-to-miss `warn`.
      alert(deps.logger, 'knowledge_reembed_stranded', { orgId, documentId, error: errorMessage(err) })
    }
  }

  // ---- Arm 2: answers ----
  const staleAnswerRows = await withPlatform(deps.db, SWEEP_REASON, (tx) =>
    tx.select({
      id: resolvedAnswers.id, orgId: resolvedAnswers.orgId, questionText: resolvedAnswers.questionText,
      embeddingModel: resolvedAnswers.embeddingModel,
    })
      .from(resolvedAnswers)
      .where(and(
        eq(resolvedAnswers.status, 'active'), isNotNull(resolvedAnswers.questionEmbedding),
        isNotNull(resolvedAnswers.embeddingModel), ne(resolvedAnswers.embeddingModel, currentModel),
      ))
      .orderBy(asc(resolvedAnswers.id))
      .limit(REEMBED_ANSWERS_PER_RUN))
  // `embeddingModel` is narrowed by `isNotNull` above; drizzle's column type stays nullable, so this
  // widens just that one field rather than casting the whole row shape.
  const staleAnswers: StaleAnswer[] = staleAnswerRows.map((r) => ({ ...r, embeddingModel: r.embeddingModel! }))

  const byOrg = new Map<string, StaleAnswer[]>()
  for (const row of staleAnswers) {
    const list = byOrg.get(row.orgId)
    if (list) list.push(row)
    else byOrg.set(row.orgId, [row])
  }

  let answersReembedded = 0
  let skippedCap = 0
  for (const [orgId, rows] of byOrg) {
    try {
      if (await atEmbedCap(deps, orgId, day, now)) {
        skippedCap += 1
        continue
      }

      // Between transactions — real network I/O.
      const { vectors, tokens } = await deps.embedder.embed(rows.map((r) => r.questionText), 'document')

      await withOrg(deps.db, orgId, async (tx) => {
        let written = 0
        for (const [index, row] of rows.entries()) {
          const vector = vectors[index]
          if (!vector) continue
          const res = await tx.update(resolvedAnswers)
            .set({ questionEmbedding: vectorLiteral(vector) as never, embeddingModel: currentModel, embeddingVersion: deps.embedder.version })
            .where(and(eq(resolvedAnswers.id, row.id), eq(resolvedAnswers.embeddingModel, row.embeddingModel)))
            .returning({ id: resolvedAnswers.id })
          written += res.length
        }
        if (tokens > 0) await bumpMeter(tx, orgId, day, KNOWLEDGE_METERS.embedTokens, tokens)
        // One row per ORG per run, never one per answer — same "workspace, count in the detail"
        // shape `sweeps-daily.ts`'s `auditPerOrgArm` uses for a platform-wide pass's per-org tally.
        if (written > 0) {
          await audit(tx, {
            actor: ACTOR, action: 'memory.reembedded', entityType: 'workspace', entityId: orgId,
            detail: { count: written, model: currentModel },
          })
        }
        answersReembedded += written
      })
    } catch (err) {
      deps.logger.warn({ orgId, error: errorMessage(err) }, 'knowledge_reembed_sweep_answers_failed')
    }
  }

  return { documentsQueued, answersReembedded, skippedCap }
}

export async function registerKnowledgeReembedSweep(boss: PgBoss, deps: KnowledgeDeps): Promise<void> {
  await registerCron(
    boss,
    'knowledge.reembed-sweep',
    '*/10 * * * *',
    async () => {
      const result = await runKnowledgeReembedSweep(boss, deps)
      if (result.documentsQueued > 0 || result.answersReembedded > 0 || result.skippedCap > 0) {
        deps.logger.info(result, 'knowledge.reembed-sweep complete')
      }
    },
    // Under the 10-minute cadence, same discipline as the stuck sweep's 240s-under-300s expiry.
    { policy: 'singleton', singletonKey: 'knowledge.reembed-sweep', retryLimit: 0, expireInSeconds: 480 },
  )
}
