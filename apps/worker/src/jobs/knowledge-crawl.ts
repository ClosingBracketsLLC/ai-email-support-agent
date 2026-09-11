/**
 * The `knowledge.crawl` job (spec §Knowledge & learning): one crawl of one site becomes one
 * document per page, streamed into the database in batches — the first 20 pages land while the
 * crawl is still running, so the owner's Knowledge screen fills up immediately.
 *
 * **No network I/O inside a `withOrg` transaction.** `crawlSite` runs between transactions and
 * calls back: `onBatch` opens its OWN short transaction per batch and must never hold one across
 * the next fetch, and `onProgress` writes one tiny row update. The chunking itself is done BEFORE
 * the batch transaction opens — it is pure CPU, and it has no business inside a tenant transaction.
 *
 * One crawl per SOURCE at a time (plan deviation 9's per-org concurrency is the `knowledge` role's
 * pg-boss teamSize, not this): the claim below takes
 * `pg_advisory_xact_lock(hashtext('knowledge-crawl:' || org_id))` so two runs for one ORG can never
 * interleave their claims, and the `processing` status plus the claim token then keep a second run
 * off the SAME source. Two different sources of one org still crawl concurrently. The lock is
 * transaction-scoped — it is the CLAIM that serializes, not the crawl, which would otherwise hold a
 * database connection for half an hour.
 *
 * A source stuck `processing` past `CRAWL_LEASE_SECONDS` belongs to an attempt that is already gone,
 * and the next attempt re-claims it. That re-entry RE-WALKS the site from the start URL — nothing is
 * resumed; `crawl_config.progress` is a progress display, not a cursor. Unchanged pages cost a fetch
 * and then skip on their `content_hash`, so the re-walk is cheap in database terms, not in requests.
 * The claim token is what keeps the abandoned attempt from writing over the new one if it wakes up.
 */
import { randomUUID } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import type PgBoss from 'pg-boss'
import { z } from 'zod'
import { KNOWLEDGE_DEFAULT_CRAWL_PAGES, type KnowledgeSourceStatus } from '@aesa/contracts'
import { resolveSetting } from '@aesa/core'
import {
  audit, bumpKnowledgeVersion, bumpMeter, knowledgeChunks, knowledgeDocuments, knowledgeSources,
  KNOWLEDGE_METERS, withOrg, type OrgTx,
} from '@aesa/db'
import {
  CrawlError, crawlSite, createPinnedCrawlFetch, ParseError, prepareDocument,
  type CrawledPage, type CrawlProgress, type CrawlSummary, type PreparedDocument,
} from '@aesa/knowledge'
import { defineJob, enqueue, JOB_NAMES, registerJob, type JobDefinition } from '@aesa/queue'
import { utcDayString } from '../date-utils.ts'
import { errorMessage } from '../err-message.ts'
import {
  failSource, guardedSourceWrite, guardedSourceWriteReturning, loadOrgSettings,
} from '../knowledge/sources.ts'
import type { KnowledgeDeps } from '../knowledge-deps.ts'

export const KnowledgeCrawlPayload = z.object({ orgId: z.string(), sourceId: z.string() })
export type KnowledgeCrawlPayload = z.infer<typeof KnowledgeCrawlPayload>

const ACTOR = 'system:knowledge.crawl' as const

/** How long a claim holds the source. Deliberately SHORTER than the queue's `expireInSeconds` and
 * equal to its `retryDelay`, so the single retry always fires after the lease has lapsed and can
 * actually re-claim; a lease as long as the expiry would make every retry a silent no-op. Measured
 * against the DATABASE's clock (`now()`), never an injected one: `updated_at` is written from the
 * WORKER's clock (drizzle's `$onUpdate`), so only the comparison side can be trusted, and a caller's
 * idea of "now" says nothing about how old the claim is. */
export const CRAWL_LEASE_SECONDS = 300

/** How many ingested pages the FIRST persistence batch carries ("first 20 pages fast", spec §Knowledge). */
const FIRST_BATCH = 20

export const knowledgeCrawlJob: JobDefinition<KnowledgeCrawlPayload> = defineJob({
  name: JOB_NAMES.knowledgeCrawl,
  schema: KnowledgeCrawlPayload,
  // retryLimit 1 with a FIXED 300 s delay (no backoff): the one retry must land after
  // `CRAWL_LEASE_SECONDS` has lapsed, otherwise it finds the source still `processing`, cannot
  // claim, and quietly does nothing. Past that one retry the owner sees a failed source rather than
  // a site being re-walked over and over.
  queue: { expireInSeconds: 1800, retryLimit: 1, retryDelay: CRAWL_LEASE_SECONDS, retryBackoff: false, policy: 'short' },
  handler: async () => {
    throw new Error('knowledge.crawl: this definition has no bound deps — register it through registerKnowledgeCrawl(boss, deps)')
  },
})

interface ClaimedCrawl {
  url: string
  maxPages: number
  /** This attempt's claim token: every later write of this run is guarded on it. */
  token: string
}

/**
 * What may be logged about a driver failure. NOT `errorMessage(cause)`: a `DrizzleQueryError`'s own
 * message is `Failed query: <sql>\nparams: <every bound parameter>`, and for the batch transaction
 * those parameters are the CRAWLED PAGE's text — the same reason `{ err }` (pino copies every
 * enumerable property, and drizzle assigns `query` and `params` as own properties) is wrong here.
 * Its `cause` is pg's own error, whose `message` ("permission denied for table knowledge_chunks")
 * and `code` name the failure without a byte of row data (final-B5).
 */
function driverSummary(cause: unknown): { name?: string; code?: string; message?: string } | null {
  if (!(cause instanceof Error)) return cause === undefined ? null : { name: typeof cause }
  // The nested error is the driver's; only ITS message is logged, never the wrapper's.
  const pg = cause.cause instanceof Error ? cause.cause : null
  const { code } = (pg ?? cause) as unknown as { code?: unknown }
  return {
    // The CLASS, not `err.name`: drizzle never sets `name`, so every wrapper would log as "Error".
    name: cause.constructor?.name ?? cause.name,
    ...(typeof code === 'string' ? { code } : {}),
    ...(pg ? { message: pg.message } : {}),
  }
}

/** `{ maxPages, progress }` — jsonb, so it is read defensively rather than trusted. */
function crawlConfigOf(raw: unknown): Record<string, unknown> {
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? { ...(raw as Record<string, unknown>) } : {}
}

/**
 * tx1: the advisory-locked claim. `queued` always; `processing` only once the lease has expired
 * (the crashed-mid-crawl case). Returns null when someone else holds the source.
 */
async function claim(deps: KnowledgeDeps, orgId: string, sourceId: string): Promise<ClaimedCrawl | null> {
  return withOrg(deps.db, orgId, async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`knowledge-crawl:${orgId}`}))`)

    const [row] = await tx
      .select({
        status: knowledgeSources.status, url: knowledgeSources.url, crawlConfig: knowledgeSources.crawlConfig,
        stale: sql<boolean>`${knowledgeSources.updatedAt} < now() - make_interval(secs => ${CRAWL_LEASE_SECONDS})`,
      })
      .from(knowledgeSources)
      .where(eq(knowledgeSources.id, sourceId))
    if (!row || !row.url) return null

    const from: KnowledgeSourceStatus[] =
      row.status === 'queued' ? ['queued'] : row.status === 'processing' && row.stale ? ['processing'] : []
    const token = randomUUID()
    const claimed = await guardedSourceWrite(tx, sourceId, from, {
      status: 'processing', failureReason: null, failureDetail: null, completedAt: null, claimToken: token,
    })
    if (!claimed) return null

    const config = crawlConfigOf(row.crawlConfig)
    const requested = typeof config.maxPages === 'number' && config.maxPages > 0 ? config.maxPages : KNOWLEDGE_DEFAULT_CRAWL_PAGES
    const cap = resolveSetting('knowledge.max_crawl_pages', { org: await loadOrgSettings(tx, ['knowledge.max_crawl_pages']) })
    return { url: row.url, maxPages: Math.min(requested, cap), token }
  })
}

/** Inserts one page's chunks, replacing the previous set when its content changed. */
async function upsertPage(
  tx: OrgTx,
  orgId: string,
  sourceId: string,
  prepared: PreparedDocument,
): Promise<{ documentId: string; changed: boolean; chunkDelta: number; documentDelta: number }> {
  const [existing] = await tx
    .select({ id: knowledgeDocuments.id, contentHash: knowledgeDocuments.contentHash, version: knowledgeDocuments.version, chunkCount: knowledgeDocuments.chunkCount })
    .from(knowledgeDocuments)
    .where(and(eq(knowledgeDocuments.sourceId, sourceId), eq(knowledgeDocuments.uri, prepared.uri)))

  if (existing && existing.contentHash === prepared.contentHash) {
    return { documentId: existing.id, changed: false, chunkDelta: 0, documentDelta: 0 }
  }

  let documentId: string
  let chunkDelta = prepared.chunks.length
  let documentDelta = 0
  if (existing) {
    // A changed page is re-chunked outright: partial reuse would need chunk-level diffing the
    // retrieval side gains nothing from, and the version bump is what makes the change visible.
    await tx.delete(knowledgeChunks).where(eq(knowledgeChunks.documentId, existing.id))
    await tx
      .update(knowledgeDocuments)
      .set({ contentHash: prepared.contentHash, title: prepared.title, version: existing.version + 1, chunkCount: prepared.chunks.length, embeddedCount: 0 })
      .where(eq(knowledgeDocuments.id, existing.id))
    documentId = existing.id
    chunkDelta = prepared.chunks.length - existing.chunkCount
  } else {
    const [doc] = await tx
      .insert(knowledgeDocuments)
      .values({ orgId, sourceId, uri: prepared.uri, title: prepared.title, contentHash: prepared.contentHash, chunkCount: prepared.chunks.length })
      .returning({ id: knowledgeDocuments.id })
    documentId = doc!.id
    documentDelta = 1
  }

  await tx.insert(knowledgeChunks).values(prepared.chunks.map((chunk) => ({
    orgId, documentId, ordinal: chunk.ordinal, headingPath: chunk.headingPath,
    content: chunk.content, tokenCount: chunk.tokenCount,
    injectionFlagged: chunk.injectionFlagged, injectionReason: chunk.injectionReason,
  })))
  return { documentId, changed: true, chunkDelta, documentDelta }
}

export async function runKnowledgeCrawl(deps: KnowledgeDeps, payload: KnowledgeCrawlPayload, signal: AbortSignal): Promise<void> {
  const { orgId, sourceId } = payload
  // Read at each landing, never once up front: a crawl can run for half an hour, and a walk that
  // starts at 23:58 UTC must meter its later pages against the day they actually happened and stamp
  // `completed_at` with the time it actually finished.
  const nowAt = (): Date => deps.now?.() ?? new Date()

  const claimed = await claim(deps, orgId, sourceId)
  if (!claimed) return

  /** One short transaction per batch, then the enqueues — never an enqueue inside the transaction. */
  const onBatch = async (pages: CrawledPage[]): Promise<void> => {
    // Pure CPU, deliberately outside the transaction below.
    const prepared: PreparedDocument[] = []
    for (const page of pages) {
      try {
        prepared.push(prepareDocument({ blocks: page.blocks, uri: page.url, title: page.title }))
      } catch (err) {
        // A page with nothing extractable is skipped, never fatal — the crawl walks on.
        if (!(err instanceof ParseError)) throw err
        deps.logger.warn({ sourceId, url: page.url, reason: err.code }, 'knowledge.crawl: page yielded no text')
      }
    }
    // Unreachable in practice (the engine never delivers a page with no blocks) — and if it ever
    // happens, nothing was persisted, so there is no version to bump and no page to meter.
    if (prepared.length === 0) return

    const day = utcDayString(nowAt())
    const changedDocumentIds = await withOrg(deps.db, orgId, async (tx) => {
      const changed: string[] = []
      let chunkDelta = 0
      let documentDelta = 0
      for (const doc of prepared) {
        const result = await upsertPage(tx, orgId, sourceId, doc)
        if (result.changed) changed.push(result.documentId)
        chunkDelta += result.chunkDelta
        documentDelta += result.documentDelta
      }
      await guardedSourceWrite(tx, sourceId, ['processing'], {
        documentCount: sql`${knowledgeSources.documentCount} + ${documentDelta}`,
        chunkCount: sql`${knowledgeSources.chunkCount} + ${chunkDelta}`,
      }, claimed.token)
      // Same transaction as the chunk set it describes — and only when that set actually moved. A
      // re-walk of an unchanged site persists nothing, and a version bump with no content change
      // would invalidate every draft's grounding stamp for nothing (final-B minor).
      if (changed.length > 0 || documentDelta !== 0) await bumpKnowledgeVersion(tx, orgId)
      await bumpMeter(tx, orgId, day, KNOWLEDGE_METERS.crawlPages, pages.length)
      return changed
    })

    for (const documentId of changedDocumentIds) await deps.enqueueEmbedBatch(orgId, documentId)
  }

  const onProgress = async (progress: CrawlProgress): Promise<void> => {
    await withOrg(deps.db, orgId, (tx) =>
      guardedSourceWrite(tx, sourceId, ['processing'], {
        crawlConfig: sql`${knowledgeSources.crawlConfig} || ${JSON.stringify({ progress })}::jsonb`,
      }, claimed.token))
  }

  /** Releases the claim so the next attempt can take the source; `crawl_config.progress` stays put. */
  const handBack = async (): Promise<void> => {
    await withOrg(deps.db, orgId, (tx) =>
      guardedSourceWrite(tx, sourceId, ['processing'], { status: 'queued', claimToken: null }, claimed.token))
  }

  let summary: CrawlSummary
  try {
    summary = await crawlSite({
      startUrl: claimed.url,
      maxPages: claimed.maxPages,
      fetch: deps.crawlFetch ?? createPinnedCrawlFetch(),
      resolver: deps.resolver,
      firstBatch: FIRST_BATCH,
      signal,
      onBatch,
      onProgress,
    })
  } catch (err) {
    if (err instanceof CrawlError) {
      // The site was fine and our OWN persistence failed: the owner must not be told their site is
      // broken, and the detail (a driver message) must never reach `failure_detail`. Re-queue and
      // rethrow the underlying error so pg-boss retries after the lease lapses.
      if (err.origin === 'consumer') {
        deps.logger.warn(
          { sourceId, error: errorMessage(err), driver: driverSummary(err.cause) },
          'knowledge.crawl: batch persistence failed; re-queueing the source',
        )
        await handBack()
        throw err.cause ?? err
      }
      // Terminal: the crawl itself could not run (a refused start URL, a dead site).
      await failSource(deps.db, { orgId, sourceId, actor: ACTOR, reason: err.code, detail: err.message, now: nowAt(), claimToken: claimed.token })
      return
    }
    await handBack()
    throw err
  }

  // The job's own deadline fired mid-walk (pg-boss's expiry margin, or a shutdown). What was
  // persisted stands, but the source is NOT `ready` — it has only part of the site. Re-queue it and
  // fail the job so the one retry re-walks.
  if (signal.aborted) {
    await withOrg(deps.db, orgId, async (tx) => {
      const written = await guardedSourceWrite(tx, sourceId, ['processing'], { status: 'queued', claimToken: null }, claimed.token)
      if (!written) return
      await audit(tx, {
        actor: ACTOR, action: 'knowledge.crawl.aborted', entityType: 'knowledge_source', entityId: sourceId,
        detail: { fetched: summary.fetched, ingested: summary.ingested },
      })
    })
    throw new Error('knowledge.crawl: aborted before completion')
  }

  if (summary.ingested === 0) {
    await failSource(deps.db, {
      orgId, sourceId, actor: ACTOR, reason: 'crawl_no_pages',
      detail: `fetched ${summary.fetched}, skipped ${summary.skipped}, refused ${summary.refused.length}`, now: nowAt(),
      claimToken: claimed.token,
    })
    return
  }

  // The end: recount rather than trust the per-batch deltas (a concurrent delete, a re-walk).
  const completedAt = nowAt()
  await withOrg(deps.db, orgId, async (tx) => {
    const [counts] = await tx
      .select({
        documents: sql<number>`count(*)::int`,
        chunks: sql<number>`coalesce(sum(${knowledgeDocuments.chunkCount}), 0)::int`,
      })
      .from(knowledgeDocuments)
      .where(eq(knowledgeDocuments.sourceId, sourceId))
    // `knowledge.embed-batch` never flips a crawl source's status while it is `processing` — it
    // records its verdict as a failure reason and leaves the transition here, because only this job
    // knows the walk is over. The status is decided IN the update (final-B4): a separate SELECT
    // could read a reason an embed job wrote a moment before the UPDATE it is meant to describe —
    // or miss one written a moment after — and the landed status is what the audit row reports.
    const landed = await guardedSourceWriteReturning(tx, sourceId, ['processing'], {
      status: sql`case when ${knowledgeSources.failureReason} is not null then 'failed' else 'ready' end`,
      completedAt,
      claimToken: null,
      documentCount: counts?.documents ?? 0,
      chunkCount: counts?.chunks ?? 0,
    }, claimed.token)
    if (!landed) return
    await audit(tx, {
      actor: ACTOR, action: 'knowledge.crawl.finished', entityType: 'knowledge_source', entityId: sourceId,
      detail: {
        fetched: summary.fetched, ingested: summary.ingested, skipped: summary.skipped,
        refused: summary.refused.length,
        ...(landed.status === 'failed' ? { failureReason: landed.failureReason } : {}),
      },
    })
  })
}

export async function registerKnowledgeCrawl(boss: PgBoss, deps: KnowledgeDeps): Promise<void> {
  const wired: JobDefinition<KnowledgeCrawlPayload> = {
    ...knowledgeCrawlJob,
    handler: async (ctx) => {
      await runKnowledgeCrawl(deps, ctx.data, ctx.signal)
    },
  }
  await registerJob(boss, wired)
}

export async function enqueueKnowledgeCrawl(boss: PgBoss, orgId: string, sourceId: string): Promise<string | null> {
  return enqueue(boss, knowledgeCrawlJob, { orgId, sourceId }, { entityId: sourceId })
}
