/**
 * `knowledge.stuck-sweep` (Phase 7, carried over from Phase 4's review): `knowledge.ingest` has NO
 * lease of its own — `updated_at` plus a constant is the whole staleness signal — and
 * `knowledge.embed-batch` deliberately lands `embed_failed` rather than rethrowing once its own
 * retry budget is gone (`knowledge-embed-batch.ts`'s `isLastAttempt` comment), precisely because no
 * sweep used to clear a source stuck mid-pipeline. This is that sweep, covering three customers:
 *
 *  - **(1) a `processing` source whose claim has lapsed** (`updated_at` older than
 *    `STUCK_LEASE_SECONDS` — 2 × `knowledge-crawl.ts`'s own `CRAWL_LEASE_SECONDS`, since a source can
 *    be an ingest OR a crawl and this sweep does not know which lease governed it): requeued to
 *    `queued` with `claim_token` cleared and `sweep_attempts` incremented, and the matching job
 *    (`knowledge.ingest` for `upload`/`paste`, `knowledge.crawl` for `crawl`) re-enqueued. At
 *    `STUCK_MAX_ATTEMPTS` the source is failed outright (`reason: 'stuck'`) instead of requeued a
 *    4th time — a source that dies mid-pipeline three times running is not going to succeed on a
 *    fourth attempt, and an owner deserves a failed source over an endless retry loop.
 *  - **(2) a `queued` `paste`/`crawl` source whose enqueue never landed**: both kinds are enqueued
 *    SYNCHRONOUSLY by the api at creation time, so a `queued` row older than `QUEUED_STALE_MINUTES`
 *    with no sign of life means that original `boss.send` failed silently (a database blip between
 *    the insert and the enqueue). Re-enqueued unconditionally; `upload` is deliberately EXCLUDED —
 *    its `queued` window is normal while the owner is still uploading bytes to S3, sometimes for
 *    minutes on a slow connection, and treating that as "stuck" would spam re-enqueues for no reason.
 *  - **(3) an abandoned `queued` upload**: the presigned PUT was issued but the browser never
 *    finished it (a closed tab, a failed upload) — `UPLOAD_ABANDON_HOURS` later, if the object still
 *    is not in the bucket, the source is failed (`reason: 'abandoned'`) so it stops cluttering the
 *    Knowledge screen as a phantom "processing" item forever.
 *
 * Duplicate enqueues are harmless everywhere here: `knowledge.ingest`/`knowledge.crawl` are `short`
 * queues (a duplicate collapses while the earlier job is still `created`) and, even when it is not
 * (the earlier job is `active`/`retry`/gone), each job's OWN claim is a guarded transition off
 * `queued`/stale-`processing` with a fresh claim token — a second job that loses the race to claim
 * simply finds the row already moved and returns having done nothing (CLAUDE.md Guarded writes).
 *
 * Discovery runs `stats.rollup`'s per-org idiom — one `withPlatform` pass, `selectDistinct org_id`
 * capped, and (1)/(2)'s writes each in their own SAVEPOINT via `withOrgIdentity` — but (3) needs
 * `store.head()`, real network I/O, so ITS candidates are only gathered inside that pass; the actual
 * check and the guarded fail write happen afterward, each in a fresh short transaction, never inside
 * an open one (CLAUDE.md Transactions).
 */
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import type PgBoss from 'pg-boss'
import type pino from 'pino'
import { audit, knowledgeSources, withOrgIdentity, withPlatform, type Db } from '@aesa/db'
import type { ObjectStore } from '@aesa/knowledge'
import { registerCron } from '@aesa/queue'
import { errorMessage } from '../err-message.ts'
import { FAILURE_DETAIL_MAX, guardedSourceWrite } from '../knowledge/sources.ts'
import { enqueueKnowledgeCrawl } from './knowledge-crawl.ts'
import { enqueueKnowledgeIngest } from './knowledge-ingest.ts'

const SWEEP_REASON = 'cron:knowledge.stuck-sweep'
const SWEEP_ACTOR = 'system:cron:knowledge.stuck-sweep' as const

/** 2 × `knowledge-crawl.ts`'s `CRAWL_LEASE_SECONDS` (== `knowledge-ingest.ts`'s own
 *  `INGEST_LEASE_SECONDS`, coincidentally the same 300 s): ingest has no lease of its own, so this
 *  sweep is it, and doubling the shorter of the two real leases keeps a healthy in-flight run —
 *  crawling a large site can legitimately take several minutes between batch commits — well clear of
 *  being mistaken for stuck. */
export const STUCK_LEASE_SECONDS = 600
/** Re-queued twice; failed outright on the third stale sighting. */
export const STUCK_MAX_ATTEMPTS = 3
/** How old a `queued` paste/crawl source (synchronously enqueued by the api) must be before its
 *  enqueue is presumed lost. */
export const QUEUED_STALE_MINUTES = 10
/** How long a `queued` upload may sit with no object in the bucket before it is presumed abandoned. */
export const UPLOAD_ABANDON_HOURS = 24

/** A bound on how many orgs one 5-minute pass visits — `stats.rollup`'s own `ROLLUP_ORGS_PER_RUN`
 *  value; not exported, since nothing needs to pin the exact number in a test. */
const ORGS_PER_RUN = 500

export interface KnowledgeStuckSweepDeps {
  db: Db
  store: ObjectStore
  logger: pino.Logger
  now?: () => Date
}

interface StuckCandidate { orgId: string; sourceId: string; kind: string; sweepAttempts: number }
interface StaleQueuedCandidate { orgId: string; sourceId: string; kind: string }
interface AbandonCandidate { orgId: string; sourceId: string; storageKey: string | null }
interface PendingEnqueue { orgId: string; sourceId: string; kind: string }

/** The guarded write's re-check at write time — the DATABASE's own `now()`, never the injected
 *  clock (same convention as `knowledge-crawl.ts`'s `stale` column): a source that got un-stuck
 *  between discovery and this write must not be forced into a state a live run already moved past. */
const staleProcessingGuard = sql`${knowledgeSources.updatedAt} < now() - make_interval(secs => ${STUCK_LEASE_SECONDS})`

export async function runKnowledgeStuckSweep(
  boss: PgBoss,
  deps: KnowledgeStuckSweepDeps,
): Promise<{ requeued: number; failed: number; abandoned: number }> {
  const now = deps.now?.() ?? new Date()
  let requeued = 0
  let failed = 0
  let abandoned = 0
  const toEnqueue: PendingEnqueue[] = []
  const abandonCandidates: AbandonCandidate[] = []

  await withPlatform(deps.db, SWEEP_REASON, async (tx) => {
    const orgRows = await tx.selectDistinct({ orgId: knowledgeSources.orgId }).from(knowledgeSources)
      .orderBy(asc(knowledgeSources.orgId)).limit(ORGS_PER_RUN)

    for (const { orgId } of orgRows) {
      // (1) processing, lease lapsed.
      const stuckRows = await tx.select({
        id: knowledgeSources.id, kind: knowledgeSources.kind, sweepAttempts: knowledgeSources.sweepAttempts,
      }).from(knowledgeSources).where(and(
        eq(knowledgeSources.orgId, orgId), eq(knowledgeSources.status, 'processing'), staleProcessingGuard,
      ))
      const stuck: StuckCandidate[] = stuckRows.map((r) => ({ orgId, sourceId: r.id, kind: r.kind, sweepAttempts: r.sweepAttempts }))

      for (const c of stuck) {
        try {
          await tx.transaction(async (tx2) => {
            const org = withOrgIdentity(tx2, c.orgId)
            if (c.sweepAttempts >= STUCK_MAX_ATTEMPTS) {
              const landedFail = await guardedSourceWrite(org, c.sourceId, ['processing'], {
                status: 'failed', failureReason: 'stuck',
                failureDetail: `no progress after ${c.sweepAttempts} requeue attempts, each ${STUCK_LEASE_SECONDS}s apart`
                  .slice(0, FAILURE_DETAIL_MAX),
                completedAt: now, claimToken: null,
              }, undefined, staleProcessingGuard)
              if (!landedFail) return
              await audit(org, {
                actor: SWEEP_ACTOR, action: 'knowledge.source.failed', entityType: 'knowledge_source', entityId: c.sourceId,
                detail: { reason: 'stuck', attempts: c.sweepAttempts },
              })
              failed += 1
              return
            }
            const landedRequeue = await guardedSourceWrite(org, c.sourceId, ['processing'], {
              status: 'queued', claimToken: null, sweepAttempts: sql`${knowledgeSources.sweepAttempts} + 1`,
            }, undefined, staleProcessingGuard)
            if (!landedRequeue) return
            await audit(org, {
              actor: SWEEP_ACTOR, action: 'knowledge.source.requeued', entityType: 'knowledge_source', entityId: c.sourceId,
              detail: { reason: 'stuck_processing', attempt: c.sweepAttempts + 1 },
            })
            requeued += 1
            toEnqueue.push({ orgId: c.orgId, sourceId: c.sourceId, kind: c.kind })
          })
        } catch (err) {
          deps.logger.warn({ sourceId: c.sourceId, error: errorMessage(err) }, 'knowledge_stuck_sweep_processing_failed')
        }
      }

      // (2) queued paste/crawl, enqueue presumed lost. `upload` is deliberately excluded — see header.
      const staleQueuedRows = await tx.select({ id: knowledgeSources.id, kind: knowledgeSources.kind })
        .from(knowledgeSources).where(and(
          eq(knowledgeSources.orgId, orgId), eq(knowledgeSources.status, 'queued'),
          inArray(knowledgeSources.kind, ['paste', 'crawl']),
          sql`${knowledgeSources.createdAt} < now() - make_interval(secs => ${QUEUED_STALE_MINUTES * 60})`,
        ))
      const staleQueued: StaleQueuedCandidate[] = staleQueuedRows.map((r) => ({ orgId, sourceId: r.id, kind: r.kind }))

      for (const c of staleQueued) {
        try {
          await tx.transaction(async (tx2) => {
            const org = withOrgIdentity(tx2, c.orgId)
            await audit(org, {
              actor: SWEEP_ACTOR, action: 'knowledge.source.requeued', entityType: 'knowledge_source', entityId: c.sourceId,
              detail: { reason: 'queued_stale' },
            })
          })
          requeued += 1
          toEnqueue.push({ orgId: c.orgId, sourceId: c.sourceId, kind: c.kind })
        } catch (err) {
          deps.logger.warn({ sourceId: c.sourceId, error: errorMessage(err) }, 'knowledge_stuck_sweep_queued_failed')
        }
      }

      // (3) candidates only — the object-store HEAD call is network I/O and never runs inside a transaction.
      const abandonRows = await tx.select({ id: knowledgeSources.id, storageKey: knowledgeSources.storageKey })
        .from(knowledgeSources).where(and(
          eq(knowledgeSources.orgId, orgId), eq(knowledgeSources.status, 'queued'), eq(knowledgeSources.kind, 'upload'),
          sql`${knowledgeSources.createdAt} < now() - make_interval(secs => ${UPLOAD_ABANDON_HOURS * 3600})`,
        ))
      for (const r of abandonRows) abandonCandidates.push({ orgId, sourceId: r.id, storageKey: r.storageKey })
    }
  })

  // (3) the deferred half: check, then (only on a miss) a fresh short transaction per source.
  for (const c of abandonCandidates) {
    try {
      const head = c.storageKey ? await deps.store.head(c.storageKey) : null
      if (head !== null) continue // the bytes made it; the owner is just slow, or `knowledge.ingest` will claim it any moment
      await withPlatform(deps.db, SWEEP_REASON, async (tx) => {
        const org = withOrgIdentity(tx, c.orgId)
        const landed = await guardedSourceWrite(org, c.sourceId, ['queued'], {
          status: 'failed', failureReason: 'abandoned',
          failureDetail: `no upload completed within ${UPLOAD_ABANDON_HOURS}h and the object is missing`.slice(0, FAILURE_DETAIL_MAX),
          completedAt: now,
        })
        if (!landed) return
        await audit(org, {
          actor: SWEEP_ACTOR, action: 'knowledge.source.failed', entityType: 'knowledge_source', entityId: c.sourceId,
          detail: { reason: 'abandoned' },
        })
        abandoned += 1
      })
    } catch (err) {
      deps.logger.warn({ sourceId: c.sourceId, error: errorMessage(err) }, 'knowledge_stuck_sweep_abandon_failed')
    }
  }

  // Every write above has already committed — the enqueue rides last, same shape
  // `ticket-backstop-sweep.ts`/`stats-rollup.ts` use.
  for (const e of toEnqueue) {
    try {
      if (e.kind === 'crawl') await enqueueKnowledgeCrawl(boss, e.orgId, e.sourceId)
      else await enqueueKnowledgeIngest(boss, e.orgId, e.sourceId)
    } catch (err) {
      deps.logger.warn({ sourceId: e.sourceId, error: errorMessage(err) }, 'knowledge_stuck_sweep_enqueue_failed')
    }
  }

  return { requeued, failed, abandoned }
}

export async function registerKnowledgeStuckSweep(boss: PgBoss, deps: KnowledgeStuckSweepDeps): Promise<void> {
  await registerCron(
    boss,
    'knowledge.stuck-sweep',
    '*/5 * * * *',
    async () => {
      const result = await runKnowledgeStuckSweep(boss, deps)
      if (result.requeued > 0 || result.failed > 0 || result.abandoned > 0) deps.logger.info(result, 'knowledge.stuck-sweep complete')
    },
    // Under the 5-minute cadence, same discipline as `ticket.backstop-sweep`'s 50s-under-60s expiry.
    { policy: 'singleton', singletonKey: 'knowledge.stuck-sweep', retryLimit: 0, expireInSeconds: 240 },
  )
}
