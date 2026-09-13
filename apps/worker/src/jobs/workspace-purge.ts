/**
 * `workspace.purge` (spec §Retention & deletion) — the job that actually deletes a workspace, and
 * `workspace.purge-sweep`, the nightly cron that finds the ones whose grace period has run out.
 *
 * **ORDER IS LOAD-BEARING: `purgeWorkspace` FIRST, `purgeAuthRows` SECOND.** `workspaces.org_id`
 * references `organization.id` with NO ACTION, so deleting the organization while a `workspaces` row
 * still points at it raises `23503`. Each function documents its own internal order; this job is
 * their first real caller and therefore the place the order BETWEEN them is stated and tested
 * (`workspace-purge.test.ts` purges an org that has a `workspaces` row, end to end).
 *
 * Three phases, for the usual reason: a bucket delete is network I/O and a `withPlatform`
 * transaction never spans one (CLAUDE.md, Transactions).
 *
 *  1. **read** — one platform transaction re-reads `deletion_requested_at` and collects every object
 *     key the org owns. The re-read is the whole safety of the enqueue → run gap: an owner who
 *     cancelled the deletion after the sweep enqueued this job must win, and they do, because
 *     nothing is trusted from the payload except the org id.
 *  2. **objects** — the store deletes, outside every transaction, best-effort. A key that will not
 *     delete is logged at error level WITH the key: nothing else will ever sweep it, so the runbook
 *     needs the list to finish the job by hand. It never aborts the row purge — customer rows in a
 *     database the owner asked to be emptied are the bigger exposure. A key that is not under
 *     `orgs/<orgId>/` is not deleted at all: an irreversible delete is the last operation that
 *     should act on a key it cannot account for, so it is skipped and paged instead.
 *  3. **rows** — one platform transaction: every tenant table, then `workspaces`, then the auth rows,
 *     then ONE platform audit row (`org_id NULL`). The tenant trail is gone by design — it is tenant
 *     data — so the platform keeps the fact that the purge happened, and nothing else. A throw here
 *     leaves the workspace HALF purged (objects gone, rows present), so it alerts before rethrowing.
 *
 * The job is idempotent by construction: phase 1 finds no `workspaces` row on a second run and
 * returns `skipped`, which is also what makes pg-boss's retries safe.
 */
import { and, eq, isNotNull, sql } from 'drizzle-orm'
import type PgBoss from 'pg-boss'
import type pino from 'pino'
import { z } from 'zod'
import { WORKSPACE_DELETE_GRACE_DAYS } from '@aesa/contracts'
import {
  auditLog, knowledgeSources, purgeAuthRows, purgeWorkspace, withPlatform, workspaces, type Db,
} from '@aesa/db'
import type { ObjectStore } from '@aesa/knowledge'
import { defineJob, enqueue, JOB_NAMES, registerCron, registerJob, type RegisteredJobDefinition } from '@aesa/queue'
import { errorMessage } from '../err-message.ts'

export const WorkspacePurgePayload = z.object({ orgId: z.string() })
export type WorkspacePurgePayload = z.infer<typeof WorkspacePurgePayload>

const PURGE_ACTOR = 'system:job:workspace.purge' as const

/** The importable definition: `workspace.purge-sweep` `enqueue()`s against this (it only ever reads
 *  `.name`/`.schema`). `registerWorkspacePurge` builds the deps-bound definition and registers THAT. */
export const workspacePurgeJob: RegisteredJobDefinition<WorkspacePurgePayload> = defineJob({
  name: JOB_NAMES.workspacePurge,
  schema: WorkspacePurgePayload,
  handler: async () => {
    throw new Error('workspace.purge: this definition has no bound deps — register it through registerWorkspacePurge(boss, deps)')
  },
})

export interface WorkspacePurgeDeps {
  db: Db
  store: ObjectStore
  logger: pino.Logger
  now?: () => Date
}

export interface WorkspacePurgeSweepDeps {
  db: Db
  logger: pino.Logger
  now?: () => Date
}

/** Phase 1's answer: `null` when this org must not be purged. */
interface PurgePlan {
  /** Keys this org demonstrably owns — every one under `orgs/<orgId>/`. Only these are deleted. */
  objectKeys: string[]
  /** Keys stored against this org that are NOT under its own prefix. Never deleted; always paged. */
  foreignKeys: string[]
}

/** Every object a workspace owns is keyed under this — `uploadKey` and `exportObjectKey` both build
 *  it — so a stored key that does not start with it is not this tenant's to delete. */
const orgKeyPrefix = (orgId: string): string => `orgs/${orgId}/`

export async function runWorkspacePurge(
  deps: WorkspacePurgeDeps,
  payload: WorkspacePurgePayload,
  signal: AbortSignal,
): Promise<'purged' | 'skipped'> {
  const now = deps.now?.() ?? new Date()
  const { orgId } = payload

  // --- Phase 1: read. Nothing is trusted from the payload except the org id.
  const plan = await withPlatform(deps.db, 'job:workspace.purge:read', async (tx): Promise<PurgePlan | null> => {
    const [ws] = await tx
      .select({ deletionRequestedAt: workspaces.deletionRequestedAt, exportKey: workspaces.exportKey })
      .from(workspaces)
      .where(eq(workspaces.orgId, orgId))
    if (!ws) {
      // Already purged (this job's own retry, or a duplicate from the sweep) — not an error.
      deps.logger.info({ orgId }, 'workspace_purge_no_workspace_row')
      return null
    }
    if (!ws.deletionRequestedAt) {
      deps.logger.warn({ orgId }, 'workspace_purge_refused_not_requested')
      return null
    }
    const due = new Date(ws.deletionRequestedAt.getTime() + WORKSPACE_DELETE_GRACE_DAYS * 24 * 60 * 60_000)
    if (due > now) {
      deps.logger.warn({ orgId, due: due.toISOString() }, 'workspace_purge_refused_grace_period')
      return null
    }
    const sources = await tx
      .select({ storageKey: knowledgeSources.storageKey })
      .from(knowledgeSources)
      .where(and(eq(knowledgeSources.orgId, orgId), isNotNull(knowledgeSources.storageKey)))
    const stored = sources.map((s) => s.storageKey).filter((k): k is string => k !== null)
    if (ws.exportKey) stored.push(ws.exportKey)

    // The explicit prefix check is the WHOLE safety of the delete that follows, not a redundant
    // brace — the same reasoning `assertSameOrg` applies to a retrieval set, and the same response:
    // a key outside this org's own prefix is evidence something upstream is broken, so it is never
    // acted on and never passed over in silence. No current path writes a foreign key into
    // `knowledge_sources.storage_key` or `workspaces.export_key`; this is what keeps it that way.
    const prefix = orgKeyPrefix(orgId)
    const objectKeys: string[] = []
    const foreignKeys: string[] = []
    for (const key of stored) (key.startsWith(prefix) ? objectKeys : foreignKeys).push(key)
    return { objectKeys, foreignKeys }
  })
  if (!plan) return 'skipped'

  // The ONE place the deadline is checked, and deliberately BEFORE anything is deleted: a purge
  // that ran out of time half way would leave the objects gone and the rows behind. Stopping here
  // costs nothing — the retry (and tomorrow's sweep) re-reads exactly the same plan.
  signal.throwIfAborted()

  for (const key of plan.foreignKeys) {
    // Task 11 replaces this with `alert('purge_failed', { orgId, key })`. An irreversible delete is
    // the last operation that should act on a key it cannot account for, so the key is left alone
    // and an operator is told which row points where.
    deps.logger.error(
      { alert: true, kind: 'purge_failed', orgId, key },
      'workspace.purge: a stored object key is outside this workspace\'s own prefix — NOT deleted; find out which row wrote it',
    )
  }

  // --- Phase 2: objects, outside every transaction. Best-effort, but never silently.
  const failedKeys: string[] = []
  for (const key of plan.objectKeys) {
    try {
      await deps.store.delete(key)
    } catch (err) {
      failedKeys.push(key)
      deps.logger.warn({ orgId, key, error: errorMessage(err) }, 'workspace_purge_object_delete_failed')
    }
  }
  if (failedKeys.length > 0) {
    // Task 11 replaces this with `alert('purge_failed', { orgId, keys })`. Nothing re-sweeps a
    // stranded object, so the runbook needs the keys themselves, not just a count.
    deps.logger.error(
      { alert: true, kind: 'purge_failed', orgId, keys: failedKeys },
      'workspace.purge: these objects could not be deleted and nothing will retry them — delete them by hand',
    )
  }

  // --- Phase 3: rows. Tenant tables, then workspaces, then the auth rows (see the header for why).
  try {
    await withPlatform(deps.db, 'job:workspace.purge', async (tx) => {
      const rows = await purgeWorkspace(tx, orgId)
      await purgeAuthRows(tx, orgId)
      // org_id NULL: this row must survive the purge it describes, and it is a platform fact, not a
      // tenant one. `detail.rows` is the per-table count map — numbers only, never content.
      await tx.insert(auditLog).values({
        orgId: null, actor: PURGE_ACTOR, action: 'workspace.purged', entityType: 'workspace', entityId: orgId,
        detail: {
          rows, objectsDeleted: plan.objectKeys.length - failedKeys.length,
          objectsFailed: failedKeys.length, objectsForeign: plan.foreignKeys.length,
        },
      })
    })
  } catch (err) {
    // Task 11 replaces this with `alert('purge_failed', { orgId, phase: 'rows' })`. By this point
    // phase 2 has already emptied the bucket, so a throw here leaves the workspace HALF purged —
    // objects gone, rows present — which the retry will finish but which nobody should learn about
    // only from a pg-boss failure record. Rethrown unchanged so the retry still happens.
    deps.logger.error(
      { alert: true, kind: 'purge_failed', orgId, phase: 'rows', error: errorMessage(err) },
      'workspace.purge: the row purge failed AFTER the objects were deleted — this workspace is half purged',
    )
    throw err
  }

  deps.logger.info({ orgId, objects: plan.objectKeys.length }, 'workspace_purged')
  return 'purged'
}

/**
 * The nightly cron: every workspace whose `deletion_requested_at` is more than
 * `WORKSPACE_DELETE_GRACE_DAYS` old gets one `workspace.purge`. The predicate is deliberately the
 * same one the job re-checks — the sweep is a scheduler, never the authority.
 */
export async function runWorkspacePurgeSweep(boss: PgBoss, deps: WorkspacePurgeSweepDeps): Promise<{ enqueued: number }> {
  const now = deps.now?.() ?? new Date()
  const due = await withPlatform(deps.db, 'cron:workspace.purge-sweep', (tx) =>
    tx
      .select({ orgId: workspaces.orgId })
      .from(workspaces)
      .where(sql`${workspaces.deletionRequestedAt} IS NOT NULL
        AND ${workspaces.deletionRequestedAt} + interval '${sql.raw(String(WORKSPACE_DELETE_GRACE_DAYS))} days' <= ${now}`))

  let enqueued = 0
  for (const { orgId } of due) {
    try {
      await enqueue(boss, workspacePurgeJob, { orgId }, { entityId: orgId })
      enqueued += 1
    } catch (err) {
      // One workspace's enqueue failing must not cost the others their purge; nothing was written,
      // so tomorrow's pass picks this one up again.
      deps.logger.warn({ orgId, error: errorMessage(err) }, 'workspace_purge_sweep_enqueue_failed')
    }
  }
  return { enqueued }
}

export async function registerWorkspacePurge(boss: PgBoss, deps: WorkspacePurgeDeps): Promise<void> {
  const wired: RegisteredJobDefinition<WorkspacePurgePayload> = {
    ...workspacePurgeJob,
    handler: async (ctx) => {
      await runWorkspacePurge(deps, ctx.data, ctx.signal)
    },
  }
  await registerJob(boss, wired)
}

export async function registerWorkspacePurgeSweep(boss: PgBoss, deps: WorkspacePurgeSweepDeps): Promise<void> {
  await registerCron(
    boss,
    'workspace.purge-sweep',
    // 04:15 UTC, after `sweeps.daily` (03:30) and `retention.sweep` (03:45): an org about to be
    // purged outright does not need either of them to have run, but interleaving them would make a
    // failed night harder to read.
    '15 4 * * *',
    async () => {
      const { enqueued } = await runWorkspacePurgeSweep(boss, deps)
      if (enqueued > 0) deps.logger.info({ enqueued }, 'workspace.purge-sweep complete')
    },
    { policy: 'singleton', singletonKey: 'workspace.purge-sweep', retryLimit: 0, expireInSeconds: 300 },
  )
}
