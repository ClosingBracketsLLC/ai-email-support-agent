/**
 * `retention.sweep` (spec §Retention & deletion) — the nightly pass that makes the workspace's own
 * retention promise true. TWO KINDS OF ARM, deliberately different, and both IRREVERSIBLE:
 *
 *  - **Platform-wide deletes** of three append-only tables nobody's retention setting governs:
 *    `llm_calls` (400 days — over a year of billing history, past every dispute window),
 *    `notifications` (90 days — a push nobody opened in a quarter is not evidence of anything) and
 *    TENANT `audit_log` rows (730 days — the trail a compliance question actually reaches for).
 *    The `org_id IS NULL` platform rows are `sweeps.daily`'s arm (h), which keeps them 30 days; the
 *    two arms are disjoint on that column ON PURPOSE, so neither cron can delete the other's rows.
 *  - **Per-workspace body purges** driven by each workspace's OWN `retention_days` (30–730, the
 *    owner's setting): a `messages.body_text` and the three text columns of a TERMINAL `drafts` row
 *    are nulled past that age. Subjects, attachment metadata, timestamps and every counter stay —
 *    the workspace keeps its history, it just stops keeping the customer's words.
 *
 * The body purge is what the `messages_org_unpurged_idx` / `drafts_org_unpurged_idx` partial indexes
 * (migration 0023) exist for, and `body_purged_at` is the work-list stamp that takes a row OUT of
 * that index once it is done. That is also why a second run of this sweep purges nothing: the
 * predicate is `body_purged_at IS NULL`, not "is the body empty".
 *
 * Every delete and every purge runs in `RETENTION_BATCH` slices (`id IN (SELECT id … LIMIT n)`) so a
 * workspace with a decade of mail is never one statement against the 30 s `statement_timeout`.
 *
 * **The per-org half takes ONE SHORT TRANSACTION PER WORKSPACE, and visits every workspace — there
 * is no `LIMIT` (ruling R15).** It began as `stats.rollup`'s shape (one transaction, a SAVEPOINT per
 * org, `ORDER BY org_id LIMIT 500`) and that was wrong here in two ways that compound. The window
 * has no rotation, so past 500 workspaces the same lexicographically-first 500 were swept nightly
 * and the tail never was — silently, with the result reporting a healthy 500; and a starved rollup
 * org loses a day of statistics, while a starved retention org never has its retention promise kept
 * at all, which is the promise the privacy policy makes. The single transaction was also the one
 * long WRITE transaction in the codebase's nightly work. One `withPlatform` per org fixes both.
 * Accepted cost, so nobody optimises it back: one `platform.access` audit row per workspace per
 * night, which `sweeps.daily`'s arm (h) prunes at 30 days, so it reaches a steady state. The per-org
 * work is two partial-index scans that usually match nothing.
 *
 * Every read and write inside an org's transaction carries an EXPLICIT `org_id` predicate: it runs
 * as `aesa_platform` with RLS bypassed and no `app.org_id` set, so nothing here may lean on RLS. An
 * omitted predicate would purge every tenant's bodies at the strictest tenant's setting, which is
 * the one mistake this file cannot afford.
 *
 * `escalations` and everything else a ticket carries are untouched: this sweep only ever nulls the
 * four body columns named below and deletes from the three tables named above.
 */
import { asc, sql } from 'drizzle-orm'
import type PgBoss from 'pg-boss'
import type pino from 'pino'
import { withPlatform, workspaces, type AuditActor, type Db, type PlatformTx } from '@aesa/db'
import { registerCron } from '@aesa/queue'
import { errorMessage } from '../err-message.ts'
import { auditPerOrgArm } from './sweeps-daily.ts'

/** `llm_calls` is the money trail: over a year of it, past every card-network dispute window. */
export const LLM_CALLS_RETENTION_DAYS = 400
/** A push nobody opened in a quarter is not evidence of anything. */
export const NOTIFICATION_RETENTION_DAYS = 90
/** The tenant audit trail a compliance question actually reaches for: two years. */
export const AUDIT_RETENTION_DAYS = 730
/** There is deliberately NO per-run workspace bound here (ruling R15) — see the file header: a
 *  `LIMIT` with no rotation is a workspace whose retention promise is simply never kept. */

/** Rows per slice. Big enough that a normal night is one or two statements per arm, small enough
 *  that the worst-case one still finishes far inside the app role's 30 s `statement_timeout`. */
export const RETENTION_BATCH = 5_000

const RETENTION_ACTOR: AuditActor = 'system:cron:retention.sweep'

/** The draft statuses whose text is safe to purge: a decision has been made and nothing will read
 *  the body again. A `pending`, `held`, `approved` or `sending` draft is still LIVE — `send.execute`
 *  reads `final_body` off it — so an age past retention never touches one. */
const TERMINAL_DRAFT_STATUSES = ['sent', 'rejected', 'expired', 'superseded', 'failed'] as const

export interface RetentionSweepDeps {
  db: Db
  logger: pino.Logger
  now?: () => Date
}

export interface RetentionSweepResult {
  orgs: number
  messagesPurged: number
  draftsPurged: number
  llmCallsDeleted: number
  notificationsDeleted: number
  auditDeleted: number
}

/**
 * One platform-wide age-based delete, in slices. `table`/`column` are literal identifiers the
 * calling module spells itself (never caller input — `column` defaults to `created_at`; the daily
 * sweep's arm (g) ages `agent_runs` by `started_at`), `extra` is a fixed predicate fragment, and
 * the cutoff is a bound parameter. Returns the total deleted. Exported for `sweeps-daily.ts`'s
 * arm (g), the one other age-based delete large enough to need slicing.
 */
export async function deleteAged(
  tx: PlatformTx, table: string, cutoff: Date, extra?: ReturnType<typeof sql>, column = 'created_at',
): Promise<number> {
  let deleted = 0
  for (;;) {
    const res = await tx.execute(sql`
      DELETE FROM ${sql.identifier(table)}
      WHERE id IN (
        SELECT id FROM ${sql.identifier(table)}
        WHERE ${sql.identifier(column)} < ${cutoff}${extra ? sql` AND ${extra}` : sql``}
        LIMIT ${RETENTION_BATCH}
      )
    `)
    const n = res.rowCount ?? 0
    deleted += n
    if (n < RETENTION_BATCH) return deleted
  }
}

/** One org's message-body purge, in slices; returns how many rows it purged. */
async function purgeMessageBodies(tx: PlatformTx, orgId: string, cutoff: Date, now: Date): Promise<number> {
  let purged = 0
  for (;;) {
    const res = await tx.execute(sql`
      UPDATE messages SET body_text = NULL, body_purged_at = ${now}
      WHERE id IN (
        SELECT id FROM messages
        WHERE org_id = ${orgId} AND body_purged_at IS NULL AND created_at < ${cutoff}
        LIMIT ${RETENTION_BATCH}
      )
    `)
    const n = res.rowCount ?? 0
    purged += n
    if (n < RETENTION_BATCH) return purged
  }
}

/** One org's draft-text purge, in slices. `body` is NOT NULL, so it is emptied rather than nulled. */
async function purgeDraftBodies(tx: PlatformTx, orgId: string, cutoff: Date, now: Date): Promise<number> {
  let purged = 0
  const statuses = sql.join(TERMINAL_DRAFT_STATUSES.map((s) => sql`${s}`), sql`, `)
  for (;;) {
    const res = await tx.execute(sql`
      UPDATE drafts SET body = '', final_body = NULL, rationale = NULL, body_purged_at = ${now}
      WHERE id IN (
        SELECT id FROM drafts
        WHERE org_id = ${orgId} AND body_purged_at IS NULL AND created_at < ${cutoff}
          AND status IN (${statuses})
        LIMIT ${RETENTION_BATCH}
      )
    `)
    const n = res.rowCount ?? 0
    purged += n
    if (n < RETENTION_BATCH) return purged
  }
}

const daysBefore = (now: Date, days: number): Date => new Date(now.getTime() - days * 24 * 60 * 60_000)

export async function runRetentionSweep(deps: RetentionSweepDeps): Promise<RetentionSweepResult> {
  const now = deps.now?.() ?? new Date()
  const result: RetentionSweepResult = {
    orgs: 0, messagesPurged: 0, draftsPurged: 0, llmCallsDeleted: 0, notificationsDeleted: 0, auditDeleted: 0,
  }

  // --- ONE transaction for the three platform-wide arms (unscoped by org) and the workspace list.
  const orgRows = await withPlatform(deps.db, 'cron:retention.sweep', async (tx) => {
    result.llmCallsDeleted = await deleteAged(tx, 'llm_calls', daysBefore(now, LLM_CALLS_RETENTION_DAYS))
    result.notificationsDeleted = await deleteAged(tx, 'notifications', daysBefore(now, NOTIFICATION_RETENTION_DAYS))
    // `org_id IS NOT NULL` is load-bearing: the NULL rows are `sweeps.daily` arm (h)'s 30-day
    // `platform.access` trail, including the row THIS transaction just wrote for itself.
    result.auditDeleted = await deleteAged(tx, 'audit_log', daysBefore(now, AUDIT_RETENTION_DAYS), sql`org_id IS NOT NULL`)

    // No LIMIT: every workspace, every night (R15). The list is org_id + a small int per row.
    return tx
      .select({ orgId: workspaces.orgId, retentionDays: workspaces.retentionDays })
      .from(workspaces)
      .orderBy(asc(workspaces.orgId))
  })

  // --- The per-org body purge, one SHORT transaction each, driven by that workspace's retention_days.
  for (const { orgId, retentionDays } of orgRows) {
    result.orgs += 1
    const cutoff = daysBefore(now, retentionDays)
    try {
      await withPlatform(deps.db, 'cron:retention.sweep', async (tx) => {
        const purgedMessages = await purgeMessageBodies(tx, orgId, cutoff, now)
        const purgedDrafts = await purgeDraftBodies(tx, orgId, cutoff, now)
        // The map form of `auditPerOrgArm` (`sweeps.daily`, ONE implementation of "one audit row per
        // org per arm"): a bulk UPDATE already knows its count and has no rows to hand over.
        await auditPerOrgArm(tx, RETENTION_ACTOR, 'messages', 'retention.purged', new Map([[orgId, purgedMessages]]))
        await auditPerOrgArm(tx, RETENTION_ACTOR, 'drafts', 'retention.purged', new Map([[orgId, purgedDrafts]]))
        result.messagesPurged += purgedMessages
        result.draftsPurged += purgedDrafts
      })
    } catch (err) {
      // One workspace failing costs only that workspace this night; the next pass re-derives its
      // work list from `body_purged_at`, so nothing is lost.
      deps.logger.warn({ orgId, error: errorMessage(err) }, 'retention_sweep_org_failed')
    }
  }

  return result
}

export async function registerRetentionSweep(boss: PgBoss, deps: RetentionSweepDeps): Promise<void> {
  await registerCron(
    boss,
    'retention.sweep',
    // 03:45 UTC: after `sweeps.daily` (03:30) has expired what it is going to expire, so a draft that
    // became terminal tonight is already terminal when this pass decides whether to purge its text.
    '45 3 * * *',
    async () => {
      const result = await runRetentionSweep(deps)
      deps.logger.info(result, 'retention.sweep complete')
    },
    { policy: 'singleton', singletonKey: 'retention.sweep', retryLimit: 0, expireInSeconds: 1800 },
  )
}
