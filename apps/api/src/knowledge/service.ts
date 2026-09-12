/**
 * The `knowledge` tRPC surface (uploads, paste, crawl, list, delete, flagged chunks, gaps) as ONE
 * service module, mirroring `apps/api/src/drafts/service.ts` + `routers/drafts.ts`: every procedure
 * is a plain exported async function `(deps, orgId, actor, input) => result`, soft outcomes are a
 * typed `{ ok: false; code; message? }` (never a thrown error), and `routers/knowledge.ts` does
 * nothing but map those codes onto `TRPCError`s. Task 11's E2E calls these functions directly with
 * `{ api, enqueue, store, logger }` — no logic may live only in the router.
 *
 * Discipline every function here keeps (CLAUDE.md):
 *  - one `withOrg` transaction per call, holding no network I/O — the presign (`startUpload`) runs
 *    BEFORE the transaction opens and the object delete (`deleteSource`) AFTER it has returned;
 *  - every write guarded on what it was read at (a status IN list, `injection_flagged = true`), so
 *    zero rows is a soft outcome, never an error;
 *  - `enqueue` only after the transaction commits, and a collapsed duplicate (`null`) is logged at
 *    debug, never thrown — the three `knowledge.*` queues are `short`-policy, so a second identical
 *    enqueue while the first is still `created` is expected, not a bug.
 */
import { randomUUID, createHash } from 'node:crypto'
import { and, count, desc, eq, inArray, ne, sql } from 'drizzle-orm'
import type pino from 'pino'
import {
  KNOWLEDGE_DEFAULT_CRAWL_PAGES,
  type KnowledgeFailureReason, type KnowledgeInjectionReason, type KnowledgeSourceKind, type KnowledgeSourceStatus,
  type PasteInput, type StartCrawlInput, type StartUploadInput,
} from '@aesa/contracts'
import { resolveSetting } from '@aesa/core'
import {
  audit, bumpKnowledgeVersion, knowledgeChunks, knowledgeDocuments, knowledgeSources, workspaces,
  type AuditActor, type OrgTx,
} from '@aesa/db'
import { uploadKey, type ObjectStore } from '@aesa/knowledge/storage'
import { normalizeUrl } from '@aesa/knowledge/url'
import { JOB_NAMES } from '@aesa/queue'
import type { ApiFacade, EnqueueFn } from '../deps.ts'
import { loadOrgSettings } from '../org-settings.ts'
import { isUniqueViolation } from '../pg-error.ts'
import { computeGaps, type GapsView } from './gaps.ts'

/** Who is acting — the same shape as `drafts/service.ts`'s `DraftActor`, minus `source` (knowledge
 * has no session-less email surface). */
export interface KnowledgeActor {
  userId: string
  actor: AuditActor
  ip?: string | null
  userAgent?: string | null
}

export interface KnowledgeServiceDeps {
  api: ApiFacade
  enqueue: EnqueueFn
  store: ObjectStore
  logger: pino.Logger
  /** Test seam; production leaves it unset and reads the wall clock per call. */
  now?: () => Date
}

const clock = (deps: KnowledgeServiceDeps): Date => deps.now?.() ?? new Date()

/** The one-click upload URL's lifetime — the brief's `expiresSeconds: 600`. */
const UPLOAD_URL_TTL_SECONDS = 600
/** `flaggedChunks`'s cap, newest first. */
const FLAGGED_CHUNKS_LIMIT = 200

type SoftCode = 'not_found' | 'forbidden_cap' | 'bad_request'
interface SoftFailure { ok: false; code: SoftCode; message?: string }

/** The FORBIDDEN's message. A settings key (`knowledge.max_sources`) is an implementation detail;
 * the app composes its own banner from `list`'s `caps` anyway, so this only has to be intelligible
 * wherever a raw tRPC message surfaces (a log, a script, a curl). */
function capFailure(cap: number): SoftFailure {
  return { ok: false, code: 'forbidden_cap', message: `Source limit reached (${cap})` }
}

// ---------------------------------------------------------------------------
// the source view
// ---------------------------------------------------------------------------

export interface KnowledgeCrawlProgress { fetched: number; ingested: number; skipped: number }

export interface KnowledgeSourceView {
  id: string
  kind: KnowledgeSourceKind
  status: KnowledgeSourceStatus
  title: string
  url: string | null
  mime: string | null
  byteSize: number | null
  documentCount: number
  chunkCount: number
  failureReason: KnowledgeFailureReason | null
  crawlProgress: KnowledgeCrawlProgress | null
  createdAt: Date
  completedAt: Date | null
}

interface SourceRow {
  id: string; kind: string; status: string; title: string; url: string | null; mime: string | null; byteSize: number | null
  documentCount: number; chunkCount: number; failureReason: string | null
  crawlConfig: unknown; createdAt: Date; completedAt: Date | null
}

/** `crawl_config.progress` is jsonb, read defensively (same discipline as the worker's own
 * `crawlConfigOf` in `knowledge-crawl.ts`) — null for a non-crawl source or one that hasn't
 * reported progress yet, never a half-shaped object. */
function crawlProgressOf(kind: string, raw: unknown): KnowledgeCrawlProgress | null {
  if (kind !== 'crawl' || typeof raw !== 'object' || raw === null) return null
  const progress = (raw as { progress?: unknown }).progress
  if (typeof progress !== 'object' || progress === null) return null
  const { fetched, ingested, skipped } = progress as Record<string, unknown>
  if (typeof fetched !== 'number' || typeof ingested !== 'number' || typeof skipped !== 'number') return null
  return { fetched, ingested, skipped }
}

function toSourceView(row: SourceRow): KnowledgeSourceView {
  return {
    id: row.id, kind: row.kind as KnowledgeSourceKind, status: row.status as KnowledgeSourceStatus, title: row.title,
    url: row.url, mime: row.mime, byteSize: row.byteSize, documentCount: row.documentCount, chunkCount: row.chunkCount,
    failureReason: row.failureReason as KnowledgeFailureReason | null,
    crawlProgress: crawlProgressOf(row.kind, row.crawlConfig), createdAt: row.createdAt, completedAt: row.completedAt,
  }
}

const SOURCE_LIST_COLUMNS = {
  id: knowledgeSources.id, kind: knowledgeSources.kind, status: knowledgeSources.status, title: knowledgeSources.title,
  url: knowledgeSources.url, mime: knowledgeSources.mime, byteSize: knowledgeSources.byteSize,
  documentCount: knowledgeSources.documentCount, chunkCount: knowledgeSources.chunkCount,
  failureReason: knowledgeSources.failureReason,
  crawlConfig: knowledgeSources.crawlConfig, createdAt: knowledgeSources.createdAt, completedAt: knowledgeSources.completedAt,
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

export interface KnowledgeListResult {
  knowledgeVersion: number
  counts: { sources: number; readyChunks: number; flaggedChunks: number }
  sources: KnowledgeSourceView[]
  /** The SAME org-resolved values `checkSourceCap`/`startCrawl` clamp against — the app's own
   * page-cap control and cap-reached copy read these rather than hard-coding a number the api could
   * silently outgrow. See `checkSourceCap`'s note on what "resolved" means today. */
  caps: { maxSources: number; maxCrawlPages: number }
  /** Echoes the caller's own role check (`canManageWorkspace`) — the router resolves it, since role
   * belongs to `ctx.member`, not to anything this service otherwise reads. */
  canManage: boolean
}

export async function listSources(deps: KnowledgeServiceDeps, orgId: string, canManage: boolean): Promise<KnowledgeListResult> {
  return deps.api.withOrg(orgId, async (tx) => {
    const [workspace] = await tx.select({ knowledgeVersion: workspaces.knowledgeVersion }).from(workspaces).where(eq(workspaces.orgId, orgId)).limit(1)
    const rows = await tx.select(SOURCE_LIST_COLUMNS).from(knowledgeSources).where(eq(knowledgeSources.orgId, orgId)).orderBy(desc(knowledgeSources.createdAt))

    const [chunkCounts] = await tx.select({
      ready: sql<number>`count(*) FILTER (WHERE ${knowledgeChunks.embedding} IS NOT NULL AND NOT ${knowledgeChunks.injectionFlagged})`,
      flagged: sql<number>`count(*) FILTER (WHERE ${knowledgeChunks.injectionFlagged})`,
    }).from(knowledgeChunks).where(eq(knowledgeChunks.orgId, orgId))

    const settings = await loadOrgSettings(tx, ['knowledge.max_sources', 'knowledge.max_crawl_pages'])
    const maxSources = resolveSetting('knowledge.max_sources', { org: settings })
    const maxCrawlPages = resolveSetting('knowledge.max_crawl_pages', { org: settings })

    return {
      knowledgeVersion: workspace?.knowledgeVersion ?? 0,
      counts: { sources: rows.length, readyChunks: Number(chunkCounts?.ready ?? 0), flaggedChunks: Number(chunkCounts?.flagged ?? 0) },
      sources: rows.map(toSourceView),
      caps: { maxSources, maxCrawlPages },
      canManage,
    }
  })
}

// ---------------------------------------------------------------------------
// the max_sources cap
// ---------------------------------------------------------------------------

/**
 * "Non-failed sources" (controller ruling): `status <> 'failed'` — a failed source doesn't hold a
 * slot, so an owner can always retry after cleaning up.
 *
 * What the cap resolves to TODAY: `resolveSetting` is called with `{ org }` only, so it is the org's
 * own `org_settings` override if it has one and the settings-catalog default otherwise
 * (`knowledge.max_sources` 100, `knowledge.max_crawl_pages` 200). `@aesa/core`'s `planSettingDefaults`
 * exists but has no caller — plan-tier resolution arrives with Phase 7's billing, which owns both the
 * org's `plan` column and the `{ plan }` argument at every `resolveSetting` site. Nothing here claims
 * a plan layer that is not live.
 *
 * Read-then-insert, with no lock: two concurrent calls that both read `cap − 1` both pass, so the
 * org can land one row over its cap. Deliberately unlike `agents.ts`'s sandbox cap (an
 * `pg_advisory_xact_lock`-serialized gate) — that cap guards a real-money model call per run; this
 * one guards a count against a limit in the tens or hundreds (`knowledge.max_sources` defaults to
 * 100), where a rare off-by-one from a genuine race is cheap to notice and clean up, and not worth
 * a lock on every upload/paste/crawl start.
 */
async function checkSourceCap(tx: OrgTx, orgId: string): Promise<{ ok: true } | SoftFailure> {
  const settings = await loadOrgSettings(tx, ['knowledge.max_sources'])
  const cap = resolveSetting('knowledge.max_sources', { org: settings })
  const [row] = await tx.select({ value: count() })
    .from(knowledgeSources)
    .where(and(eq(knowledgeSources.orgId, orgId), ne(knowledgeSources.status, 'failed')))
  if ((row?.value ?? 0) >= cap) return capFailure(cap)
  return { ok: true }
}

// ---------------------------------------------------------------------------
// startUpload / completeUpload
// ---------------------------------------------------------------------------

export type StartUploadResult =
  | { ok: true; sourceId: string; url: string; headers: Record<string, string>; expiresAt: Date }
  | SoftFailure

/**
 * An abandoned `queued` upload — the presign call below throws, or the owner simply never PUTs the
 * file — holds a `knowledge.max_sources` slot until the owner deletes it by hand: nothing here ever
 * expires a `queued` source on its own. A daily sweep for stale `queued` uploads is a Phase 7
 * carry-over (the same shape `sweeps.daily` already gives draft/run-event retention), not this task.
 */
export async function startUpload(
  deps: KnowledgeServiceDeps, orgId: string, actor: KnowledgeActor, input: StartUploadInput,
): Promise<StartUploadResult> {
  const now = clock(deps)
  // BEFORE the transaction, and deliberately: presigning a PUT is a local SigV4 signature over a
  // key and an expiry — no request leaves the process — but it CAN still throw (a missing bucket
  // config, a store that has to mint a session token). Doing it first means a presign failure
  // strands no `queued` row: nothing has been written yet. `sourceId` is minted here because the
  // object key embeds it, and it is the row's own id a moment later.
  const sourceId = randomUUID()
  const storageKey = uploadKey(orgId, sourceId, input.fileName)
  const presigned = await deps.store.presignPut(storageKey, { contentType: input.mime, expiresSeconds: UPLOAD_URL_TTL_SECONDS })

  const outcome = await deps.api.withOrg(orgId, async (tx) => {
    const capCheck = await checkSourceCap(tx, orgId)
    if (!capCheck.ok) return capCheck

    await tx.insert(knowledgeSources).values({
      id: sourceId, orgId, kind: 'upload', status: 'queued', title: input.fileName,
      storageKey, mime: input.mime, byteSize: input.byteSize, createdBy: actor.userId,
    })
    await audit(tx, {
      actor: actor.actor, action: 'knowledge.source.created', entityType: 'knowledge_source', entityId: sourceId,
      detail: { kind: 'upload', title: input.fileName, mime: input.mime, byteSize: input.byteSize },
      ip: actor.ip, userAgent: actor.userAgent,
    })
    return { ok: true as const }
  })
  if (!outcome.ok) return outcome

  return { ok: true, sourceId, url: presigned.url, headers: presigned.headers, expiresAt: new Date(now.getTime() + UPLOAD_URL_TTL_SECONDS * 1000) }
}

export type CompleteUploadResult = { ok: true } | SoftFailure

/**
 * The job (`knowledge.ingest`) verifies the object actually landed; this call only checks the
 * source is a `queued` upload that belongs to this org before waking it. That check is a plain
 * SELECT, not a guarded UPDATE — safe because `knowledge.ingest`'s own claim (`guardedSourceWrite`,
 * `queued → processing` with a fresh claim token) is what actually matters, and it re-checks the
 * same precondition under its own transaction; a stale read here just means an extra, harmless
 * enqueue the job's claim then no-ops.
 */
export async function completeUpload(
  deps: KnowledgeServiceDeps, orgId: string, actor: KnowledgeActor, input: { sourceId: string },
): Promise<CompleteUploadResult> {
  const outcome = await deps.api.withOrg(orgId, async (tx) => {
    const [source] = await tx.select({ id: knowledgeSources.id, kind: knowledgeSources.kind, status: knowledgeSources.status })
      .from(knowledgeSources).where(and(eq(knowledgeSources.orgId, orgId), eq(knowledgeSources.id, input.sourceId))).limit(1)
    if (!source) return { ok: false as const, code: 'not_found' as const }
    if (source.kind !== 'upload') return { ok: false as const, code: 'bad_request' as const, message: 'source is not an upload' }
    if (source.status !== 'queued') return { ok: false as const, code: 'bad_request' as const, message: `source is ${source.status}, not queued` }

    await audit(tx, {
      actor: actor.actor, action: 'knowledge.source.upload_completed', entityType: 'knowledge_source', entityId: source.id,
      detail: { sourceId: source.id }, ip: actor.ip, userAgent: actor.userAgent,
    })
    return { ok: true as const, sourceId: source.id }
  })
  if (!outcome.ok) return outcome

  const jobId = await deps.enqueue(JOB_NAMES.knowledgeIngest, { orgId, sourceId: outcome.sourceId }, { entityId: outcome.sourceId })
  if (jobId === null) deps.logger.debug({ orgId, sourceId: outcome.sourceId }, 'knowledge.ingest enqueue returned no job id (duplicate collapsed)')
  return { ok: true }
}

// ---------------------------------------------------------------------------
// paste
// ---------------------------------------------------------------------------

export type PasteResult = { ok: true; sourceId: string } | SoftFailure

/** `content_hash` here is a cheap sha256 fingerprint of the raw pasted text — NOT a dedupe key; the
 * ingest job replaces it with the parsed-blocks hash once it has actually chunked the text. */
export async function pasteSource(
  deps: KnowledgeServiceDeps, orgId: string, actor: KnowledgeActor, input: PasteInput,
): Promise<PasteResult> {
  const outcome = await deps.api.withOrg(orgId, async (tx) => {
    const capCheck = await checkSourceCap(tx, orgId)
    if (!capCheck.ok) return capCheck

    const contentHash = createHash('sha256').update(input.text, 'utf8').digest('hex')
    const [row] = await tx.insert(knowledgeSources).values({
      orgId, kind: 'paste', status: 'queued', title: input.title, pastedText: input.text, contentHash, createdBy: actor.userId,
    }).returning({ id: knowledgeSources.id })
    await audit(tx, {
      actor: actor.actor, action: 'knowledge.source.created', entityType: 'knowledge_source', entityId: row!.id,
      detail: { kind: 'paste', title: input.title, textLength: input.text.length }, ip: actor.ip, userAgent: actor.userAgent,
    })
    return { ok: true as const, sourceId: row!.id }
  })
  if (!outcome.ok) return outcome

  const jobId = await deps.enqueue(JOB_NAMES.knowledgeIngest, { orgId, sourceId: outcome.sourceId }, { entityId: outcome.sourceId })
  if (jobId === null) deps.logger.debug({ orgId, sourceId: outcome.sourceId }, 'knowledge.ingest enqueue returned no job id (duplicate collapsed)')
  return outcome
}

// ---------------------------------------------------------------------------
// startCrawl / refreshCrawl
// ---------------------------------------------------------------------------

/** `crawl_config.maxPages`, read defensively (same fallback the worker's `crawlConfigOf` uses). */
function existingMaxPagesOf(raw: unknown): number {
  if (typeof raw === 'object' && raw !== null) {
    const v = (raw as { maxPages?: unknown }).maxPages
    if (typeof v === 'number' && v > 0) return v
  }
  return KNOWLEDGE_DEFAULT_CRAWL_PAGES
}

/** Shared by `startCrawl`'s "found a `ready` row" branch and the standalone `refreshCrawl`:
 * `status → queued`, `crawl_config` reset to just `{ maxPages }` (which is what clears `progress`),
 * the failure trail cleared, guarded on the caller's `fromStatuses`. Returns false when the guard
 * matched nothing (a concurrent writer already moved the source). `maxPages` is the caller's ALREADY
 * -DECIDED budget, not computed here: `startCrawl` re-queuing a `ready` row uses the CALLER's newly
 * clamped `maxPages` (an owner asking to crawl again gets what they just asked for), while
 * `refreshCrawl` — which takes no `maxPages` input at all — keeps the row's own stored budget,
 * reclamped only to a cap that may have shrunk since. */
async function requeueCrawlSource(
  tx: OrgTx, orgId: string, source: { id: string }, fromStatuses: KnowledgeSourceStatus[], maxPages: number, actor: KnowledgeActor,
): Promise<boolean> {
  const rows = await tx.update(knowledgeSources)
    .set({ status: 'queued', crawlConfig: { maxPages }, failureReason: null, failureDetail: null, completedAt: null, claimToken: null })
    .where(and(eq(knowledgeSources.orgId, orgId), eq(knowledgeSources.id, source.id), inArray(knowledgeSources.status, fromStatuses)))
    .returning({ id: knowledgeSources.id })
  if (rows.length === 0) return false
  await audit(tx, {
    actor: actor.actor, action: 'knowledge.source.crawl_requeued', entityType: 'knowledge_source', entityId: source.id,
    detail: { sourceId: source.id, maxPages }, ip: actor.ip, userAgent: actor.userAgent,
  })
  return true
}

export type StartCrawlResult = { ok: true; sourceId: string } | SoftFailure

/**
 * One non-failed crawl source per URL per org (controller ruling): a match on `ready` re-queues
 * that row (the `refreshCrawl` path, with the CALLER's clamped `maxPages` — see
 * `requeueCrawlSource`'s doc comment); a match on `queued`/`processing` returns its id with nothing
 * else done — a crawl is already pending. Only a URL with no live match ever inserts a new row,
 * which is the only branch the `max_sources` cap applies to.
 *
 * `knowledge_sources_org_crawl_url_uidx` (`org_id, url WHERE kind = 'crawl' AND status <> 'failed'`,
 * migration 0018) is the backstop for the race the `existing` read above cannot see: two concurrent
 * `startCrawl` calls for the same brand-new URL can both miss it and both attempt the insert below.
 * The index lets exactly one land; the loser's insert raises pg 23505, caught here and turned into
 * the SAME "already pending" outcome the `queued`/`processing` branch above returns — never a 500.
 * The index still excludes `failed` (same reason the dedupe query does): a failed crawl must stay
 * re-addable rather than colliding with its own dead row.
 */
export async function startCrawl(
  deps: KnowledgeServiceDeps, orgId: string, actor: KnowledgeActor, input: StartCrawlInput,
): Promise<StartCrawlResult> {
  // A plain https-only syntactic check (see `@aesa/knowledge/url`'s own doc comment) — the crawler
  // engine refuses a non-https seed outright, so accepting one here would only ever produce a source
  // that lands `failed` on its first attempt. Outside the transaction: it needs no database read.
  const url = normalizeUrl(input.url)
  if (url === null) return { ok: false, code: 'bad_request', message: 'Crawls need an https:// address' }

  const outcome = await deps.api.withOrg(orgId, async (tx) => {
    const settings = await loadOrgSettings(tx, ['knowledge.max_sources', 'knowledge.max_crawl_pages'])
    const pageCap = resolveSetting('knowledge.max_crawl_pages', { org: settings })

    const [existing] = await tx.select({ id: knowledgeSources.id, status: knowledgeSources.status })
      .from(knowledgeSources)
      .where(and(eq(knowledgeSources.orgId, orgId), eq(knowledgeSources.kind, 'crawl'), eq(knowledgeSources.url, url), ne(knowledgeSources.status, 'failed')))
      .limit(1)

    if (existing) {
      if (existing.status === 'ready') {
        const maxPages = Math.min(input.maxPages, pageCap)
        const requeued = await requeueCrawlSource(tx, orgId, existing, ['ready'], maxPages, actor)
        return { ok: true as const, sourceId: existing.id, shouldEnqueue: requeued }
      }
      // queued | processing: already pending — no new enqueue, no audit.
      return { ok: true as const, sourceId: existing.id, shouldEnqueue: false }
    }

    const capCheck = await checkSourceCap(tx, orgId)
    if (!capCheck.ok) return capCheck

    const maxPages = Math.min(input.maxPages, pageCap)
    // The insert runs inside its own SAVEPOINT (connect/routes.ts's pattern): a unique_violation on
    // `knowledge_sources_org_crawl_url_uidx` otherwise leaves the WHOLE `withOrg` transaction
    // aborted, and the re-read just below (needed to report the row that won the race) would fail
    // with "current transaction is aborted" rather than running.
    let row: { id: string } | undefined
    try {
      ;[row] = await tx.transaction((tx2) => tx2.insert(knowledgeSources).values({
        orgId, kind: 'crawl', status: 'queued', title: url, url, crawlConfig: { maxPages }, createdBy: actor.userId,
      }).returning({ id: knowledgeSources.id }))
    } catch (err) {
      if (!isUniqueViolation(err)) throw err
      // Lost the race: a concurrent startCrawl for the same URL landed first and already enqueued
      // its own knowledge.crawl job for that row — report it exactly like the queued/processing
      // branch above, with no new enqueue and no audit row for an insert that never happened.
      const [race] = await tx.select({ id: knowledgeSources.id })
        .from(knowledgeSources)
        .where(and(eq(knowledgeSources.orgId, orgId), eq(knowledgeSources.kind, 'crawl'), eq(knowledgeSources.url, url), ne(knowledgeSources.status, 'failed')))
        .limit(1)
      if (!race) throw err   // the unique violation guarantees a matching row exists; defensive only
      return { ok: true as const, sourceId: race.id, shouldEnqueue: false }
    }
    await audit(tx, {
      actor: actor.actor, action: 'knowledge.source.created', entityType: 'knowledge_source', entityId: row!.id,
      detail: { kind: 'crawl', url, maxPages }, ip: actor.ip, userAgent: actor.userAgent,
    })
    return { ok: true as const, sourceId: row!.id, shouldEnqueue: true }
  })
  if (!outcome.ok) return outcome

  if (outcome.shouldEnqueue) {
    const jobId = await deps.enqueue(JOB_NAMES.knowledgeCrawl, { orgId, sourceId: outcome.sourceId }, { entityId: outcome.sourceId })
    if (jobId === null) deps.logger.debug({ orgId, sourceId: outcome.sourceId }, 'knowledge.crawl enqueue returned no job id (duplicate collapsed)')
  }
  return { ok: true, sourceId: outcome.sourceId }
}

export type RefreshCrawlResult = { ok: true } | SoftFailure

/**
 * `ready`, `failed` — and `queued` too (final-review ruling). A `queued` crawl normally has a job
 * coming, so re-queuing it enqueues a SECOND one; that is harmless, because the two jobs race for
 * the same `queued → processing` claim and the loser's guarded write matches zero rows and returns.
 * What it buys is the one case with no other way out: a crawl whose job exhausted its retries
 * (`knowledge.crawl` hands the source back to `queued` before it rethrows) sits `queued` with
 * nothing coming for it, and `startCrawl` on the same URL just finds the row and reports it pending.
 * Until the Phase 7 stranded-source sweep ships, "Refresh" is the owner's way out of that.
 * `processing` stays refused: that source holds a live claim token.
 */
export async function refreshCrawl(
  deps: KnowledgeServiceDeps, orgId: string, actor: KnowledgeActor, input: { sourceId: string },
): Promise<RefreshCrawlResult> {
  const outcome = await deps.api.withOrg(orgId, async (tx) => {
    const [source] = await tx.select({ id: knowledgeSources.id, kind: knowledgeSources.kind, status: knowledgeSources.status, crawlConfig: knowledgeSources.crawlConfig })
      .from(knowledgeSources).where(and(eq(knowledgeSources.orgId, orgId), eq(knowledgeSources.id, input.sourceId))).limit(1)
    if (!source) return { ok: false as const, code: 'not_found' as const }
    if (source.kind !== 'crawl') return { ok: false as const, code: 'bad_request' as const, message: 'source is not a crawl' }
    if (source.status === 'processing') {
      return { ok: false as const, code: 'bad_request' as const, message: 'source is processing, not ready, failed or queued' }
    }

    const settings = await loadOrgSettings(tx, ['knowledge.max_crawl_pages'])
    const pageCap = resolveSetting('knowledge.max_crawl_pages', { org: settings })
    // The row's OWN stored budget, only reclamped — `refreshCrawl` takes no `maxPages` input, so
    // there is no caller value to prefer (see `requeueCrawlSource`'s doc comment).
    const maxPages = Math.min(existingMaxPagesOf(source.crawlConfig), pageCap)
    const requeued = await requeueCrawlSource(tx, orgId, source, ['ready', 'failed', 'queued'], maxPages, actor)
    if (!requeued) return { ok: false as const, code: 'bad_request' as const, message: 'source changed status before it could be requeued' }
    return { ok: true as const, sourceId: source.id }
  })
  if (!outcome.ok) return outcome

  const jobId = await deps.enqueue(JOB_NAMES.knowledgeCrawl, { orgId, sourceId: outcome.sourceId }, { entityId: outcome.sourceId })
  if (jobId === null) deps.logger.debug({ orgId, sourceId: outcome.sourceId }, 'knowledge.crawl enqueue returned no job id (duplicate collapsed)')
  return { ok: true }
}

// ---------------------------------------------------------------------------
// deleteSource
// ---------------------------------------------------------------------------

export type DeleteSourceResult = { ok: true } | { ok: false; code: 'not_found' }

export async function deleteSource(
  deps: KnowledgeServiceDeps, orgId: string, actor: KnowledgeActor, input: { sourceId: string },
): Promise<DeleteSourceResult> {
  const outcome = await deps.api.withOrg(orgId, async (tx) => {
    const [source] = await tx.select({ id: knowledgeSources.id, kind: knowledgeSources.kind, storageKey: knowledgeSources.storageKey })
      .from(knowledgeSources).where(and(eq(knowledgeSources.orgId, orgId), eq(knowledgeSources.id, input.sourceId))).limit(1)
    if (!source) return { ok: false as const, code: 'not_found' as const }

    const deleted = await tx.delete(knowledgeSources)
      .where(and(eq(knowledgeSources.orgId, orgId), eq(knowledgeSources.id, source.id)))
      .returning({ id: knowledgeSources.id })
    if (deleted.length === 0) return { ok: false as const, code: 'not_found' as const }

    await bumpKnowledgeVersion(tx, orgId)
    await audit(tx, {
      actor: actor.actor, action: 'knowledge.source.deleted', entityType: 'knowledge_source', entityId: source.id,
      detail: { kind: source.kind }, ip: actor.ip, userAgent: actor.userAgent,
    })
    return { ok: true as const, kind: source.kind, storageKey: source.storageKey }
  })
  if (!outcome.ok) return outcome

  // Outside the transaction, and never allowed to fail the mutation: the row is already gone.
  if (outcome.kind === 'upload' && outcome.storageKey) {
    try {
      await deps.store.delete(outcome.storageKey)
    } catch (err) {
      deps.logger.warn({ sourceId: input.sourceId, err: err instanceof Error ? err.message : String(err) }, 'knowledge: failed to delete the uploaded object')
    }
  }
  return { ok: true }
}

// ---------------------------------------------------------------------------
// flaggedChunks / unflagChunk / deleteChunk
// ---------------------------------------------------------------------------

export interface FlaggedChunkView {
  id: string
  sourceId: string
  sourceTitle: string
  documentUri: string
  headingPath: string[]
  content: string
  /** The code `screenChunk` wrote (`knowledge_chunks.injection_reason`, a plain text column), typed
   * as the contracts enum the app has a label for. The app falls back to generic copy for anything
   * it does not recognise, so a row written before the enum existed still renders. */
  reason: KnowledgeInjectionReason | null
}

export async function flaggedChunks(deps: KnowledgeServiceDeps, orgId: string): Promise<{ chunks: FlaggedChunkView[] }> {
  const rows = await deps.api.withOrg(orgId, (tx) =>
    tx.select({
      id: knowledgeChunks.id, sourceId: knowledgeSources.id, sourceTitle: knowledgeSources.title,
      documentUri: knowledgeDocuments.uri, headingPath: knowledgeChunks.headingPath, content: knowledgeChunks.content,
      reason: knowledgeChunks.injectionReason,
    })
      .from(knowledgeChunks)
      .innerJoin(knowledgeDocuments, eq(knowledgeDocuments.id, knowledgeChunks.documentId))
      .innerJoin(knowledgeSources, eq(knowledgeSources.id, knowledgeDocuments.sourceId))
      .where(and(eq(knowledgeChunks.orgId, orgId), eq(knowledgeChunks.injectionFlagged, true)))
      .orderBy(desc(knowledgeChunks.createdAt))
      .limit(FLAGGED_CHUNKS_LIMIT),
  )
  return { chunks: rows.map((row) => ({ ...row, reason: row.reason as KnowledgeInjectionReason | null })) }
}

export type UnflagChunkResult = { ok: true } | { ok: false; code: 'not_found' }

export async function unflagChunk(
  deps: KnowledgeServiceDeps, orgId: string, actor: KnowledgeActor, input: { chunkId: string },
): Promise<UnflagChunkResult> {
  const outcome = await deps.api.withOrg(orgId, async (tx) => {
    const rows = await tx.update(knowledgeChunks)
      .set({ injectionFlagged: false, injectionReason: null })
      .where(and(eq(knowledgeChunks.orgId, orgId), eq(knowledgeChunks.id, input.chunkId), eq(knowledgeChunks.injectionFlagged, true)))
      // `needsEmbed` is computed in the database rather than `.returning` the vector itself: a
      // 1024-dimension embedding is ~20 KB of text over the wire per row, read only to compare it
      // against null.
      .returning({ id: knowledgeChunks.id, documentId: knowledgeChunks.documentId, needsEmbed: sql<boolean>`${knowledgeChunks.embedding} IS NULL` })
    const row = rows[0]
    if (!row) return { ok: false as const, code: 'not_found' as const }

    await bumpKnowledgeVersion(tx, orgId)
    await audit(tx, {
      actor: actor.actor, action: 'knowledge.chunk.unflagged', entityType: 'knowledge_chunk', entityId: row.id,
      detail: { chunkId: row.id, documentId: row.documentId }, ip: actor.ip, userAgent: actor.userAgent,
    })
    return { ok: true as const, documentId: row.documentId, needsEmbed: row.needsEmbed }
  })
  if (!outcome.ok) return outcome

  if (outcome.needsEmbed) {
    const jobId = await deps.enqueue(JOB_NAMES.knowledgeEmbedBatch, { orgId, documentId: outcome.documentId }, { entityId: outcome.documentId })
    if (jobId === null) deps.logger.debug({ orgId, documentId: outcome.documentId }, 'knowledge.embed-batch enqueue returned no job id (duplicate collapsed)')
  }
  return { ok: true }
}

export type DeleteChunkResult = { ok: true } | { ok: false; code: 'not_found' }

export async function deleteChunk(
  deps: KnowledgeServiceDeps, orgId: string, actor: KnowledgeActor, input: { chunkId: string },
): Promise<DeleteChunkResult> {
  return deps.api.withOrg(orgId, async (tx) => {
    const rows = await tx.delete(knowledgeChunks)
      .where(and(eq(knowledgeChunks.orgId, orgId), eq(knowledgeChunks.id, input.chunkId), eq(knowledgeChunks.injectionFlagged, true)))
      .returning({ id: knowledgeChunks.id, documentId: knowledgeChunks.documentId })
    const row = rows[0]
    if (!row) return { ok: false as const, code: 'not_found' as const }

    await bumpKnowledgeVersion(tx, orgId)
    await audit(tx, {
      actor: actor.actor, action: 'knowledge.chunk.deleted', entityType: 'knowledge_chunk', entityId: row.id,
      detail: { chunkId: row.id, documentId: row.documentId }, ip: actor.ip, userAgent: actor.userAgent,
    })
    return { ok: true as const }
  })
}

// ---------------------------------------------------------------------------
// gaps
// ---------------------------------------------------------------------------

export async function gaps(deps: KnowledgeServiceDeps, orgId: string): Promise<GapsView> {
  const now = clock(deps)
  return deps.api.withOrg(orgId, (tx) => computeGaps(tx, orgId, now))
}
