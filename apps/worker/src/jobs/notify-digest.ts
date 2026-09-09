/**
 * The `notify.digest` cron: carries `notify.dispatch`'s daily-cap overflow (`notifications` rows
 * left `collapsed`) to the owner as one push per org, instead of leaving them stranded until the
 * cap resets. Cadence and the cap-the-rendered-not-the-stamped rule are ported from doge-buddy's
 * `notifyPendingEscalations` (apps/ops/src/support/escalate.ts): list at most `MAX_LISTED_TITLES`
 * titles in the push body, but mark EVERY collapsed row `sent` regardless of how many made it into
 * the text — the cap only bounds what's rendered, never what's delivered.
 *
 * Scope note (task brief says "collapsed/pending rows older than digest_minutes"): `pending` rows
 * are `notify.dispatch`'s own job to land on `sent`/`collapsed`/`failed`; a `pending` row sitting
 * unprocessed past its age is `mailbox.poll-sweep`'s (g) stuck-notification sweep's problem (it
 * re-enqueues `notify.dispatch`), not this cron's. This cron reads `collapsed` rows only — the
 * digest IS the overflow channel the brief describes, and `pending` never reaches it.
 *
 * `digest_minutes` is a per-org setting, so the cross-org scan below can only find CANDIDATE orgs
 * (any org with at least one collapsed row, regardless of age); each org's own cutoff is computed
 * inside its own `withOrg` tx once that org's setting is known.
 */
import { and, asc, eq, inArray, isNull, lt } from 'drizzle-orm'
import type PgBoss from 'pg-boss'
import type pino from 'pino'
import { resolveSetting } from '@aesa/core'
import { notificationDevices, notifications, orgSettings, tickets, withOrg, withPlatform, type Db } from '@aesa/db'
import { registerCron } from '@aesa/queue'
import type { SendPush } from '../push.ts'

/** Ported cap: bounds only what's RENDERED into the push body, never what's stamped `sent` below. */
const MAX_LISTED_TITLES = 10

export interface NotifyDigestDeps {
  db: Db
  push: SendPush
  logger: pino.Logger
  now?: () => Date
}

function buildDigestBody(titles: string[]): string {
  const listed = titles.slice(0, MAX_LISTED_TITLES)
  const overflow = titles.length - listed.length
  const lines = overflow > 0 ? [...listed, `…and ${overflow} more`] : listed
  return lines.join('\n')
}

interface DueDigest {
  rowIds: string[]
  titles: string[]
  deviceTokens: string[]
  /** Ticket ids from this batch's escalation-kind rows (fix review Finding 2) — stamped inside the
   * SAME tx that marks the batch `sent`, same atomicity reasoning as notify.dispatch's rule 5. */
  escalationTicketIds: string[]
}

/** One org's collapsed backlog older than its own `digest_minutes` setting, plus the devices to
 * push it to. Everything here is one short `withOrg` read — no write yet, since the push itself
 * must run outside any tx. */
async function loadDueDigest(db: Db, orgId: string, now: Date): Promise<DueDigest | null> {
  return withOrg(db, orgId, async (tx) => {
    const settingRows = await tx.select({ value: orgSettings.value }).from(orgSettings).where(eq(orgSettings.key, 'notifications.digest_minutes'))
    const digestMinutes = resolveSetting('notifications.digest_minutes', {
      org: settingRows[0] ? { 'notifications.digest_minutes': settingRows[0].value } : {},
    })
    const cutoff = new Date(now.getTime() - digestMinutes * 60_000)

    const rows = await tx
      .select({ id: notifications.id, title: notifications.title, kind: notifications.kind, payload: notifications.payload })
      .from(notifications)
      .where(and(eq(notifications.orgId, orgId), eq(notifications.status, 'collapsed'), lt(notifications.createdAt, cutoff)))
      .orderBy(asc(notifications.createdAt))
    if (rows.length === 0) return null // under-age (or none) — this org waits for a later tick.

    const deviceRows = await tx
      .select({ expoPushToken: notificationDevices.expoPushToken })
      .from(notificationDevices)
      .where(and(eq(notificationDevices.orgId, orgId), isNull(notificationDevices.disabledAt)))

    const escalationTicketIds = [
      ...new Set(
        rows
          .filter((r) => r.kind === 'escalation')
          .map((r) => (r.payload as { ticketId?: string } | null)?.ticketId)
          .filter((id): id is string => Boolean(id)),
      ),
    ]

    return {
      rowIds: rows.map((r) => r.id),
      titles: rows.map((r) => r.title),
      deviceTokens: deviceRows.map((d) => d.expoPushToken),
      escalationTicketIds,
    }
  })
}

/** Marks the whole batch `sent` and — Finding 2 — stamps `escalation_notified_at` for every
 * escalation-kind row's ticket, in the SAME tx: an org at the daily cap whose collapsed backlog
 * includes an escalation must still get its ticket stamped once the digest actually paged the
 * owner, exactly like notify.dispatch's own rule 5 does on its own success path. */
async function markSentAndStampEscalations(db: Db, orgId: string, due: DueDigest, now: Date): Promise<void> {
  await withOrg(db, orgId, async (tx) => {
    await tx.update(notifications).set({ status: 'sent', sentAt: now }).where(inArray(notifications.id, due.rowIds))
    if (due.escalationTicketIds.length > 0) {
      await tx
        .update(tickets)
        .set({ escalationNotifiedAt: now })
        .where(and(inArray(tickets.id, due.escalationTicketIds), isNull(tickets.escalationNotifiedAt)))
    }
  })
}

async function disableInvalidDevices(db: Db, orgId: string, tokens: string[], now: Date): Promise<void> {
  if (tokens.length === 0) return
  await withOrg(db, orgId, (tx) =>
    tx.update(notificationDevices).set({ disabledAt: now }).where(and(eq(notificationDevices.orgId, orgId), inArray(notificationDevices.expoPushToken, tokens))))
}

/** One org's due digest: load, push (outside any tx), then mark ALL of the batch's rows `sent` —
 * never just the rendered ones. A failed push leaves the rows `collapsed` for the next 5-minute
 * tick to retry (the never-reject seam's `ok: false`, not an exception). */
async function runOneOrgDigest(deps: NotifyDigestDeps, orgId: string, now: Date): Promise<void> {
  const due = await loadDueDigest(deps.db, orgId, now)
  if (!due) return

  if (due.deviceTokens.length === 0) {
    // Nothing to push to — same "not an error" call as notify.dispatch's rule 3.
    await markSentAndStampEscalations(deps.db, orgId, due, now)
    return
  }

  const count = due.rowIds.length
  const result = await deps.push({
    to: due.deviceTokens,
    title: `${count} update${count === 1 ? '' : 's'} waiting`,
    body: buildDigestBody(due.titles),
    // Controller ruling: stamp `kind` so the app's push-tap routing can read `data.kind` directly.
    data: { kind: 'digest' },
  })

  if (!result.ok) {
    deps.logger.warn({ orgId, count }, 'notify_digest_push_failed')
    return
  }

  await markSentAndStampEscalations(deps.db, orgId, due, now)
  // The digest itself never counts against push_sent (it IS the overflow channel) — only disable
  // whatever tokens Expo reported dead, same bookkeeping notify.dispatch does on its own success path.
  await disableInvalidDevices(deps.db, orgId, result.invalidTokens, now)
}

export async function runNotifyDigest(deps: NotifyDigestDeps): Promise<void> {
  const now = deps.now?.() ?? new Date()

  const orgIds = await withPlatform(deps.db, 'cron:notify.digest', async (tx) => {
    const rows = await tx.selectDistinct({ orgId: notifications.orgId }).from(notifications).where(eq(notifications.status, 'collapsed'))
    return rows.map((r) => r.orgId)
  })

  for (const orgId of orgIds) {
    await runOneOrgDigest(deps, orgId, now)
  }
}

export async function registerNotifyDigest(boss: PgBoss, deps: NotifyDigestDeps): Promise<void> {
  await registerCron(boss, 'notify.digest', '*/5 * * * *', async () => { await runNotifyDigest(deps) },
    { policy: 'singleton', singletonKey: 'notify.digest', retryLimit: 0, expireInSeconds: 280 })
}
