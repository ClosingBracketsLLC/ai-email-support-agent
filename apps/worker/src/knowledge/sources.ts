/**
 * The three `knowledge.*` jobs' shared writes against `knowledge_sources`.
 *
 * `guardedSourceWrite` is the knowledge pipeline's version of `ticket-triage.ts`'s ticket-specific
 * `guardedWrite` (CLAUDE.md "Guarded writes"): every status flip carries the status(es) it was READ
 * at, and zero rows is a soft outcome the caller reports — never an error. That is what lets a
 * concurrent run, an owner deleting the source, or a later retry simply win.
 */
import { and, eq, inArray, type SQL } from 'drizzle-orm'
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core'
import type { KnowledgeFailureReason, KnowledgeSourceStatus } from '@aesa/contracts'
import type { SettingKey } from '@aesa/core'
import { audit, knowledgeSources, orgSettings, withOrg, type AuditActor, type Db, type OrgTx } from '@aesa/db'

/** Accepts drizzle `sql` fragments as column values (the crawl's jsonb progress merge), not only literals. */
export type SourcePatch = PgUpdateSetSource<typeof knowledgeSources>

/** Never the file's, the paste's or the page's own text — a failure detail is operator-facing. */
export const FAILURE_DETAIL_MAX = 500

/**
 * `claimToken` is the second half of the guard (`outbound_sends`' pre-send UPDATE, same shape): a
 * claiming run mints one with its `processing` flip and passes it to every later write it makes, so
 * a write arriving from an attempt whose lease has already lapsed — and whose source has since been
 * re-claimed by another attempt — matches nothing instead of clobbering the current holder.
 *
 * `onlyWhen` is one more predicate ANDed into the same UPDATE, for a caller whose write is
 * conditional on something other than the status (`knowledge.embed-batch` records a crawl source's
 * FIRST failure reason and no later one). It is part of the write, not a read before it, so two
 * jobs racing cannot both see "no reason yet".
 */
export async function guardedSourceWrite(
  tx: OrgTx,
  sourceId: string,
  fromStatuses: KnowledgeSourceStatus[],
  patch: SourcePatch,
  claimToken?: string,
  onlyWhen?: SQL,
): Promise<boolean> {
  return (await guardedSourceWriteReturning(tx, sourceId, fromStatuses, patch, claimToken, onlyWhen)) !== null
}

/**
 * The same guarded write, returning the status the row LANDED in — for the callers whose patch
 * decides that status in SQL (`knowledge.crawl`'s end transition, `knowledge.embed-batch`'s late
 * verdict on a crawl source). One round trip instead of a SELECT and an UPDATE that could disagree,
 * and one implementation of the guard for both shapes. `null` is the same soft outcome
 * `guardedSourceWrite`'s `false` is: somebody else owns the row.
 */
export async function guardedSourceWriteReturning(
  tx: OrgTx,
  sourceId: string,
  fromStatuses: KnowledgeSourceStatus[],
  patch: SourcePatch,
  claimToken?: string,
  onlyWhen?: SQL,
): Promise<LandedSource | null> {
  if (fromStatuses.length === 0) return null
  const guards = [eq(knowledgeSources.id, sourceId), inArray(knowledgeSources.status, fromStatuses)]
  if (claimToken !== undefined) guards.push(eq(knowledgeSources.claimToken, claimToken))
  if (onlyWhen !== undefined) guards.push(onlyWhen)
  const rows = await tx
    .update(knowledgeSources)
    .set(patch)
    .where(and(...guards))
    .returning({ status: knowledgeSources.status, failureReason: knowledgeSources.failureReason })
  const landed = rows[0]
  if (!landed) return null
  return {
    status: landed.status as KnowledgeSourceStatus,
    failureReason: landed.failureReason as KnowledgeFailureReason | null,
  }
}

/** The row as the guarded write LEFT it — the post-image, so a reason another job wrote is read at
 *  the same instant the status that describes it was decided. */
export interface LandedSource {
  status: KnowledgeSourceStatus
  failureReason: KnowledgeFailureReason | null
}

/**
 * The terminal landing shared by the claiming jobs: `failed` + a reason the Knowledge screen can
 * label, a truncated detail, one audit row, and the claim released. Guarded on `processing` — and,
 * when the caller holds one, on its claim token — so a source an owner has already deleted or
 * re-queued, or one another attempt has since claimed, is left alone.
 */
export async function failSource(
  db: Db,
  p: { orgId: string; sourceId: string; actor: AuditActor; reason: KnowledgeFailureReason; detail: string; now: Date; claimToken?: string },
): Promise<void> {
  await withOrg(db, p.orgId, async (tx) => {
    const written = await guardedSourceWrite(tx, p.sourceId, ['processing'], {
      status: 'failed',
      failureReason: p.reason,
      failureDetail: p.detail.slice(0, FAILURE_DETAIL_MAX),
      completedAt: p.now,
      claimToken: null,
    }, p.claimToken)
    if (!written) return
    await audit(tx, {
      actor: p.actor, action: 'knowledge.source.failed', entityType: 'knowledge_source', entityId: p.sourceId,
      detail: { reason: p.reason },
    })
  })
}

/** The org's rows for the keys a job resolves, in `resolveSetting`'s `{ org }` shape (ticket-triage.ts's pattern). */
export async function loadOrgSettings(tx: OrgTx, keys: SettingKey[]): Promise<Partial<Record<SettingKey, unknown>>> {
  // The `orgId` predicate is a brace, not the lock: RLS already scopes this read. It is here to
  // match the api's identical helper (`apps/api/src/org-settings.ts`) exactly — a table that ever
  // landed in `RLS_EXEMPT`'s list would otherwise silently read another org's cap.
  const rows = await tx
    .select({ key: orgSettings.key, value: orgSettings.value })
    .from(orgSettings)
    .where(and(eq(orgSettings.orgId, tx.orgId), inArray(orgSettings.key, keys)))
  const out: Partial<Record<SettingKey, unknown>> = {}
  for (const row of rows) out[row.key as SettingKey] = row.value
  return out
}
