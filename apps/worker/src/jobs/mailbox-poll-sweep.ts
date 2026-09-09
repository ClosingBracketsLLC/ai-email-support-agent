/**
 * `mailbox.poll-sweep` — the every-2-minutes cross-org cron the spec calls out explicitly: "push is an
 * accelerator, never a dependency". ONE `withPlatform` pass covers all seven sub-sweeps (a)-(g); every
 * enqueue is collected during that pass and only sent AFTER it commits, so a queue outage never rolls
 * back the deletes/updates the pass already made durable.
 *
 * (a)'s selection is fair-select round-robin over orgs (`fairSelectSql`) so one very-overdue org can
 * never crowd out every other org's due connections in a single sweep. "push not configured for its
 * provider" reads literally at the CONNECTION level (`push_subscription_id IS NULL`), not a global
 * per-provider config flag: `registerMailboxPollSweep`'s deps carry no `WorkerConfig`, and a connection
 * with no active subscription — whether because push is globally off, mailbox.renew-watch hasn't
 * reached it yet, or its last subscribe attempt failed — has no signal but this sweep, so it must be
 * polled every cycle regardless of the reason.
 *
 * (e) is ENQUEUE ONLY — a plain SELECT, no write. An earlier revision of this file had this sweep
 * reset the ticket to `new` before enqueueing (on the theory that `runTicketTriage`'s `isSelectable`
 * gate excludes `needs_owner` outright); a `needs_owner -> new` write is not a legal edge in
 * `@aesa/core`'s `ticketTransitions` matrix (`needs_owner` only leads to `triaged`/`resolved`/
 * `waiting_on_customer`), and this platform-role sweep has no `OrgTx` to audit it through even if it
 * were. The fix is on the OTHER side: `runTicketTriage`'s `isSelectable` now accepts
 * `needs_owner`+`needsOwnerReason: 'triage_cap'` as selectable (and no other needs_owner reason), so
 * re-selecting the SAME row this sweep found lets the verdict land through the legal
 * `needs_owner -> triaged/resolved` edges; a still-capped day just re-caps in place via triage's own
 * same-status guarded write.
 */
import { and, eq, lt, sql } from 'drizzle-orm'
import type PgBoss from 'pg-boss'
import type pino from 'pino'
import {
  auditLog, mailboxConnections, mailboxCredentials, notifications, oauthFlows, tickets, webhookEvents, withPlatform, type Db,
} from '@aesa/db'
import { enqueue, fairSelectSql, registerCron } from '@aesa/queue'
import { utcDayString } from '../date-utils.ts'
import { errorMessage } from '../err-message.ts'
import { enqueueNotifyDispatch } from '../notify-stub.ts'
import { mailboxSyncJob } from './mailbox-sync.ts'
import { ticketTriageJob } from './ticket-triage.ts'

/** Per-sweep cap on (a)'s fair-select page — a bound, not a promise every due connection is served in
 *  one pass; the next sweep (2 minutes later) picks up whatever this one's cap left behind. */
const DUE_CONNECTIONS_LIMIT = 200
const CLAIM_EXPIRY_MINUTES = 10
const OAUTH_FLOW_RETENTION_HOURS = 24
const STUCK_NEW_MINUTES = 10
const WEBHOOK_EVENT_RETENTION_DAYS = 7
const STUCK_NOTIFICATION_MINUTES = 10

export interface MailboxPollSweepDeps {
  db: Db
  logger: pino.Logger
  now?: () => Date
}

interface PendingEnqueue {
  kind: 'sync' | 'triage' | 'notify'
  orgId: string
  entityId: string
}

/**
 * `fairSelectSql` returns `{text, values}` shaped for a raw `pg` client (its own test uses one
 * directly) — this repo's ESLint gate forbids importing `pg`/`drizzle-orm/node-postgres` outside
 * `packages/db`, `apps/*\/src/index.ts`, tests and scripts, so a job file must run it through the
 * `PlatformTx` handle instead. Its `text` carries exactly one `$1` (the LIMIT), so it can be spliced
 * into a drizzle `sql` template with `sql.raw()` around the trusted, code-authored fragments and the
 * limit interpolated normally (drizzle binds it as its own parameter) — same SQL, run through the ORM.
 */
function fairSelectQuery(p: Parameters<typeof fairSelectSql>[0]) {
  const { text, values } = fairSelectSql(p)
  const marker = '$1'
  const idx = text.indexOf(marker)
  if (idx === -1 || values.length !== 1) throw new Error('fairSelectQuery: expected fairSelectSql to produce exactly one $1 placeholder')
  const before = text.slice(0, idx)
  const after = text.slice(idx + marker.length)
  return sql`${sql.raw(before)}${values[0]}${sql.raw(after)}`
}

export async function runMailboxPollSweep(boss: PgBoss, deps: MailboxPollSweepDeps): Promise<void> {
  const now = deps.now?.() ?? new Date()
  const pending: PendingEnqueue[] = []

  // `now` (not literal SQL `now()`) drives every time-relative predicate below, including (a)'s raw
  // SQL fragment — the whole sweep must move together under `deps.now` for tests to be deterministic.
  const nowLiteral = `'${now.toISOString()}'::timestamptz`
  const staleSyncCutoff = new Date(now.getTime() - 30 * 60_000)

  await withPlatform(deps.db, 'cron:mailbox.poll-sweep', async (tx) => {
    // (a) connections due a sync — fair round-robin over orgs.
    const dueQuery = fairSelectQuery({
      from: 'mailbox_connections',
      where: `
        status = 'connected'
        AND (backoff_until IS NULL OR backoff_until < ${nowLiteral})
        AND (
          push_subscription_id IS NULL
          OR push_expires_at < ${nowLiteral}
          OR consecutive_failures > 0
          OR last_sync_at IS NULL
          OR last_sync_at < '${staleSyncCutoff.toISOString()}'::timestamptz
        )
      `,
      orderBy: 'last_sync_at ASC NULLS FIRST',
      limit: DUE_CONNECTIONS_LIMIT,
    })
    const due = (await tx.execute<{ id: string; org_id: string }>(dueQuery)).rows
    for (const row of due) pending.push({ kind: 'sync', orgId: row.org_id, entityId: row.id })

    // (b) pending_claim connections older than 10 minutes: delete credentials + connection, audit.
    // No provider revoke here — the sealed tokens were never opened; revocation-by-deletion is the
    // recorded ruling (Task 15 brief).
    const claimCutoff = new Date(now.getTime() - CLAIM_EXPIRY_MINUTES * 60_000)
    const expiredClaims = await tx
      .select({ id: mailboxConnections.id, orgId: mailboxConnections.orgId })
      .from(mailboxConnections)
      .where(and(eq(mailboxConnections.status, 'pending_claim'), lt(mailboxConnections.createdAt, claimCutoff)))
    for (const c of expiredClaims) {
      await tx.delete(mailboxCredentials).where(eq(mailboxCredentials.connectionId, c.id))
      await tx.delete(mailboxConnections).where(eq(mailboxConnections.id, c.id))
      await tx.insert(auditLog).values({
        orgId: c.orgId, actor: 'system:cron:mailbox.poll-sweep', action: 'mailbox.claim_expired',
        entityType: 'mailbox_connection', entityId: c.id, detail: {},
      })
    }

    // (c) oauth_flows past expiry -> expired; expired rows older than 24h -> deleted.
    await tx.update(oauthFlows).set({ status: 'expired' }).where(and(eq(oauthFlows.status, 'pending'), lt(oauthFlows.expiresAt, now)))
    const oauthDeleteCutoff = new Date(now.getTime() - OAUTH_FLOW_RETENTION_HOURS * 60 * 60_000)
    await tx.delete(oauthFlows).where(and(eq(oauthFlows.status, 'expired'), lt(oauthFlows.expiresAt, oauthDeleteCutoff)))

    // (d) tickets stuck 'new' (triage never ran or crashed) -> re-enqueue ticket.triage.
    const newCutoff = new Date(now.getTime() - STUCK_NEW_MINUTES * 60_000)
    const stuckNew = await tx
      .select({ id: tickets.id, orgId: tickets.orgId })
      .from(tickets)
      .where(and(eq(tickets.status, 'new'), lt(tickets.lastInboundAt, newCutoff)))
    for (const t of stuckNew) pending.push({ kind: 'triage', orgId: t.orgId, entityId: t.id })

    // (e) triage-cap re-entry — see file header. ENQUEUE ONLY: needs_owner -> new is not a legal
    // edge in @aesa/core's ticketTransitions matrix, and this sweep runs as the platform role with
    // no audit trail for a ticket-status write anyway. ticket.triage itself now accepts
    // needs_owner/triage_cap as selectable (its own guarded write lands the verdict through the
    // legal needs_owner -> triaged/resolved edges); a still-capped day just re-caps in place via the
    // same-status guarded write, so this sweep never needs to touch the row at all.
    const todayStart = new Date(`${utcDayString(now)}T00:00:00.000Z`)
    const capRows = await tx
      .select({ id: tickets.id, orgId: tickets.orgId })
      .from(tickets)
      .where(
        and(
          eq(tickets.status, 'needs_owner'),
          eq(tickets.needsOwnerReason, 'triage_cap'),
          sql`COALESCE(${tickets.lastTriagedAt}, ${tickets.updatedAt}) < ${todayStart}`,
        ),
      )
    for (const t of capRows) pending.push({ kind: 'triage', orgId: t.orgId, entityId: t.id })

    // (f) webhook_events retention.
    const webhookCutoff = new Date(now.getTime() - WEBHOOK_EVENT_RETENTION_DAYS * 24 * 60 * 60_000)
    await tx.delete(webhookEvents).where(lt(webhookEvents.receivedAt, webhookCutoff))

    // (g) notifications stuck pending (dispatch crashed) -> re-enqueue notify.dispatch.
    const notifCutoff = new Date(now.getTime() - STUCK_NOTIFICATION_MINUTES * 60_000)
    const stuckNotifs = await tx
      .select({ id: notifications.id, orgId: notifications.orgId })
      .from(notifications)
      .where(and(eq(notifications.status, 'pending'), lt(notifications.createdAt, notifCutoff)))
    for (const n of stuckNotifs) pending.push({ kind: 'notify', orgId: n.orgId, entityId: n.id })
  })

  for (const item of pending) {
    try {
      if (item.kind === 'sync') {
        await enqueue(boss, mailboxSyncJob, { orgId: item.orgId, connectionId: item.entityId }, { entityId: item.entityId })
      } else if (item.kind === 'triage') {
        await enqueue(boss, ticketTriageJob, { orgId: item.orgId, ticketId: item.entityId }, { entityId: item.entityId, debounceSeconds: 10 })
      } else {
        await enqueueNotifyDispatch(boss, item.orgId, item.entityId)
      }
    } catch (err) {
      deps.logger.warn({ kind: item.kind, entityId: item.entityId, error: errorMessage(err) }, 'mailbox.poll_sweep_enqueue_failed')
    }
  }
}

export async function registerMailboxPollSweep(boss: PgBoss, deps: MailboxPollSweepDeps): Promise<void> {
  await registerCron(
    boss,
    'mailbox.poll-sweep',
    '*/2 * * * *',
    async () => {
      await runMailboxPollSweep(boss, deps)
    },
    { policy: 'singleton', singletonKey: 'mailbox.poll-sweep', retryLimit: 0, expireInSeconds: 110 },
  )
}
