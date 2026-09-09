/**
 * The `mailbox.sync` job: one lease-guarded poll of one mailbox connection, wiring `@aesa/mail`'s
 * provider-agnostic `runSync` walk into this worker's job/notification/audit machinery. Ported nowhere
 * (new integration code) — `runSync` itself, and the credential path it depends on (`getAccessToken`),
 * are Tasks 8/11's; this file is the seam that turns their reporting-only outputs into real side
 * effects (enqueues, notification rows) exactly once per committed message.
 *
 * Six steps, per the task brief:
 *  1. CAS-claim the poll lease (`poll_lease_until`, 90 s) — a held lease (another worker mid-sync, or a
 *     crash that hasn't hit the lease's own expiry yet) means this run has nothing to do.
 *  2. `getAccessToken` (Task 8; audited platform read). A `ProviderAuthError` means Task 8 already
 *     flipped the connection to `reauth_required` (only when the hash it tried was still current) —
 *     this job's only remaining work is telling the owner, once per UTC day.
 *  3. Acquire the mail limiter (per-connection + process-wide gates) before ANY provider call.
 *  4. `runSync`, collecting its two callbacks into local arrays — `SyncResult`'s own arrays are
 *     reporting-only (the file header on `@aesa/mail/sync.ts` is explicit: consuming both double-
 *     enqueues), so this is the ONLY place those ids are read.
 *  5. Release the limiter; write health (lease clear, `last_sync_at`/`last_success_at`/
 *     `consecutive_failures`/`backoff_until`) in one `withOrg` tx. A `ProviderRateLimitError` is NOT a
 *     failure — the connection's health is left alone and this job re-enqueues itself after the
 *     provider's own `Retry-After`.
 *  6. Post-commit (so a queue outage never rolls back real mailbox state): `ticket.triage` per new
 *     inbound ticket, and an `escalation` notification (+ `notify.dispatch`) per tripwired ticket. These
 *     run regardless of the run's overall outcome — a run that fails PARTWAY through may have already
 *     committed several messages, each with its own callback already fired.
 */
import { and, eq, isNull, lt, or, sql } from 'drizzle-orm'
import type PgBoss from 'pg-boss'
import type pino from 'pino'
import { z } from 'zod'
import type { KekRing } from '@aesa/crypto'
import { mailboxConnections, notifications, withOrg, workspaces, type Db } from '@aesa/db'
import {
  getAccessToken, ProviderAuthError, ProviderRateLimitError, runSync, type MailboxClient, type MailboxProvider,
} from '@aesa/mail'
import type { MailLimiter } from '@aesa/mail'
import { defineJob, enqueue, registerJob, JOB_NAMES, type JobDefinition } from '@aesa/queue'
import type { WorkerConfig } from '../config.ts'
import { utcDayString } from '../date-utils.ts'
import { errorMessage } from '../err-message.ts'
import { resolveMailProvider } from '../mail-provider.ts'
import { enqueueNotifyDispatch } from '../notify-stub.ts'
import { ticketTriageJob } from './ticket-triage.ts'

/** A held lease shorter than the job's own poll cadence guarantees at most one live sync per
 *  connection at a time without a distinct locking table. */
const LEASE_SECONDS = 90
/** Cap on the exponential backoff a run of consecutive failures accrues. */
const MAX_BACKOFF_MINUTES = 60
/** Used only when the provider's own 429/rate-limit response carried no `Retry-After`. */
const DEFAULT_RATE_LIMIT_RETRY_MS = 60_000

export const MailboxSyncPayload = z.object({ orgId: z.string(), connectionId: z.string() })
export type MailboxSyncPayload = z.infer<typeof MailboxSyncPayload>

/**
 * The importable definition: the api's webhook routes and `mailboxes.claimConnection` (Task 17/18), and
 * this file's own poll-sweep/rate-limit re-enqueues, `enqueue()` against this — which only ever reads
 * `.name`/`.schema` — never against a handler bound to no deps.
 */
export const mailboxSyncJob: JobDefinition<MailboxSyncPayload> = defineJob({
  name: JOB_NAMES.mailboxSync,
  schema: MailboxSyncPayload,
  queue: { expireInSeconds: 300, retryLimit: 3, retryBackoff: true },
  handler: async () => {
    throw new Error('mailbox.sync: this definition has no bound deps — register it through registerMailboxSync(boss, deps)')
  },
})

export interface MailboxSyncDeps {
  db: Db
  ring: KekRing
  config: WorkerConfig
  limiter: MailLimiter
  logger: pino.Logger
  /** Test seam for the client `runSync` walks with; production builds it off `providerFactory`. */
  clientFactory?: (provider: 'gmail' | 'microsoft', accessToken: string, selfAddress: string) => MailboxClient
  /** Test seam for the whole adapter (covers `.refresh` for `getAccessToken` too); production always
   *  resolves the real Gmail/Graph adapter. */
  providerFactory?: (provider: 'gmail' | 'microsoft') => MailboxProvider
  now?: () => Date
}

type ConnRow = { provider: string; emailAddress: string; consecutiveFailures: number }

/** Step 1. No row back means someone else holds the lease or the connection is not `connected`. */
async function claimLease(db: Db, orgId: string, connectionId: string): Promise<ConnRow | undefined> {
  const rows = await withOrg(db, orgId, (tx) =>
    tx
      .update(mailboxConnections)
      .set({ pollLeaseUntil: sql.raw(`now() + interval '${LEASE_SECONDS} seconds'`) })
      .where(
        and(
          eq(mailboxConnections.id, connectionId),
          eq(mailboxConnections.orgId, orgId),
          eq(mailboxConnections.status, 'connected'),
          or(isNull(mailboxConnections.pollLeaseUntil), lt(mailboxConnections.pollLeaseUntil, sql`now()`)),
        ),
      )
      .returning({
        provider: mailboxConnections.provider,
        emailAddress: mailboxConnections.emailAddress,
        consecutiveFailures: mailboxConnections.consecutiveFailures,
      }),
  )
  return rows[0]
}

async function clearLease(db: Db, orgId: string, connectionId: string): Promise<void> {
  await withOrg(db, orgId, (tx) => tx.update(mailboxConnections).set({ pollLeaseUntil: null }).where(eq(mailboxConnections.id, connectionId)))
}

/** Step 2's failure path: insert the (day-deduped) reauth notification and enqueue its dispatch. */
async function handleReauth(boss: PgBoss, deps: MailboxSyncDeps, orgId: string, connectionId: string, now: Date): Promise<void> {
  const dedupeKey = `reauth:${connectionId}:${utcDayString(now)}`
  const notificationId = await withOrg(deps.db, orgId, async (tx) => {
    const [row] = await tx
      .insert(notifications)
      .values({
        orgId,
        kind: 'mailbox_reauth',
        title: 'Reconnect your mailbox',
        body: 'We could not refresh access to your mailbox. Reconnect it to keep receiving support email.',
        dedupeKey,
        payload: { connectionId },
      })
      .onConflictDoNothing({ target: notifications.dedupeKey })
      .returning({ id: notifications.id })
    return row?.id
  })
  if (notificationId) await enqueueNotifyDispatch(boss, orgId, notificationId)
}

/** Step 6's tripwire branch: insert the (day-deduped) escalation notification and enqueue its dispatch. */
async function insertEscalation(boss: PgBoss, deps: MailboxSyncDeps, orgId: string, ticketId: string, now: Date): Promise<void> {
  const dedupeKey = `escalation:${ticketId}:${utcDayString(now)}`
  const notificationId = await withOrg(deps.db, orgId, async (tx) => {
    const [row] = await tx
      .insert(notifications)
      .values({
        orgId,
        kind: 'escalation',
        title: 'Ticket flagged for review',
        body: 'A message on this ticket was flagged during sync and needs your attention.',
        dedupeKey,
        payload: { ticketId },
      })
      .onConflictDoNothing({ target: notifications.dedupeKey })
      .returning({ id: notifications.id })
    return row?.id
  })
  if (notificationId) await enqueueNotifyDispatch(boss, orgId, notificationId)
}

export async function runMailboxSync(boss: PgBoss, deps: MailboxSyncDeps, payload: MailboxSyncPayload): Promise<void> {
  if (!deps.config.platformSender) throw new Error('mailbox.sync: MAIL_FROM is not configured')
  const now = deps.now?.() ?? new Date()

  const connRow = await claimLease(deps.db, payload.orgId, payload.connectionId)
  if (!connRow) {
    deps.logger.info({ connectionId: payload.connectionId }, 'mailbox.sync_lease_contended')
    return
  }
  const provider = connRow.provider as 'gmail' | 'microsoft'
  const providerObj = (deps.providerFactory ?? resolveMailProvider)(provider)

  const oauth = provider === 'gmail' ? deps.config.gmailOauth : deps.config.msOauth
  if (!oauth) throw new Error(`mailbox.sync: no OAuth client configured for provider ${provider}`)

  let accessToken: string
  try {
    accessToken = await getAccessToken(
      { db: deps.db, ring: deps.ring, provider: providerObj, clientId: oauth.clientId, clientSecret: oauth.clientSecret.expose() },
      payload.orgId,
      payload.connectionId,
      JOB_NAMES.mailboxSync,
    )
  } catch (err) {
    if (err instanceof ProviderAuthError) {
      await clearLease(deps.db, payload.orgId, payload.connectionId)
      await handleReauth(boss, deps, payload.orgId, payload.connectionId, now)
      return
    }
    throw err
  }

  const release = await deps.limiter.acquire(payload.connectionId)
  const newInboundIds: string[] = []
  const tripwiredIds: string[] = []
  let outcome: 'success' | 'failure' | 'rate_limited' = 'success'
  let retryAfterMs: number | null = null
  try {
    const client = deps.clientFactory
      ? deps.clientFactory(provider, accessToken, connRow.emailAddress)
      : providerObj.client(accessToken, connRow.emailAddress)

    const wsRows = await withOrg(deps.db, payload.orgId, (tx) =>
      tx.select({ tripwireExtraKeywords: workspaces.tripwireExtraKeywords }).from(workspaces).where(eq(workspaces.orgId, payload.orgId)),
    )
    const tripwireExtras = wsRows[0]?.tripwireExtraKeywords ?? []

    await runSync({
      db: deps.db,
      client,
      orgId: payload.orgId,
      connectionId: payload.connectionId,
      provider,
      selfAddress: connRow.emailAddress,
      platformSender: deps.config.platformSender,
      tripwireExtras,
      onNewInboundTicket: (id) => newInboundIds.push(id),
      onTripwire: (id) => tripwiredIds.push(id),
      now: deps.now,
      log: (level, msg, ctx) => deps.logger[level](ctx ?? {}, msg),
    })
  } catch (err) {
    if (err instanceof ProviderRateLimitError) {
      outcome = 'rate_limited'
      retryAfterMs = err.retryAfterMs
    } else {
      outcome = 'failure'
      deps.logger.warn({ connectionId: payload.connectionId, error: errorMessage(err) }, 'mailbox.sync_failed')
    }
  } finally {
    release()
  }

  // Step 5: one withOrg tx clears the lease and, except on a rate limit, writes health.
  await withOrg(deps.db, payload.orgId, async (tx) => {
    if (outcome === 'rate_limited') {
      await tx.update(mailboxConnections).set({ pollLeaseUntil: null }).where(eq(mailboxConnections.id, payload.connectionId))
      return
    }
    if (outcome === 'failure') {
      const newFailures = connRow.consecutiveFailures + 1
      const backoffMinutes = Math.min(2 ** newFailures, MAX_BACKOFF_MINUTES)
      await tx
        .update(mailboxConnections)
        .set({
          pollLeaseUntil: null,
          lastSyncAt: now,
          consecutiveFailures: newFailures,
          backoffUntil: sql`now() + interval '1 minute' * ${backoffMinutes}`,
        })
        .where(eq(mailboxConnections.id, payload.connectionId))
      return
    }
    // Success. Controller ruling (Task 8 carry-over): a rare race can leave a WORKING credential on
    // a reauth_required connection (another worker's slow refresh persists a fresh token after this
    // one already flipped the status) — heal reauth_required -> connected here, since getAccessToken
    // just proved the credential works. Never override any OTHER status (in particular `disabled`,
    // which a user's disconnect may have set mid-run).
    await tx
      .update(mailboxConnections)
      .set({
        pollLeaseUntil: null,
        lastSyncAt: now,
        lastSuccessAt: now,
        consecutiveFailures: 0,
        backoffUntil: null,
        status: sql`CASE WHEN ${mailboxConnections.status} = 'reauth_required' THEN 'connected' ELSE ${mailboxConnections.status} END`,
      })
      .where(eq(mailboxConnections.id, payload.connectionId))
  })

  // Step 6: post-commit, regardless of outcome — a run that failed or got rate-limited partway
  // through may have already committed several messages, each with its callback already fired.
  for (const ticketId of newInboundIds) {
    await enqueue(boss, ticketTriageJob, { orgId: payload.orgId, ticketId }, { entityId: ticketId, debounceSeconds: 10 })
  }
  for (const ticketId of tripwiredIds) {
    await insertEscalation(boss, deps, payload.orgId, ticketId, now)
  }

  if (outcome === 'rate_limited') {
    const delayMs = retryAfterMs ?? DEFAULT_RATE_LIMIT_RETRY_MS
    await enqueue(boss, mailboxSyncJob, payload, { entityId: payload.connectionId, startAfter: new Date(now.getTime() + delayMs) })
  }
}

export async function registerMailboxSync(boss: PgBoss, deps: MailboxSyncDeps): Promise<void> {
  const wired: JobDefinition<MailboxSyncPayload> = {
    ...mailboxSyncJob,
    handler: async (ctx) => {
      await runMailboxSync(boss, deps, ctx.data)
    },
  }
  await registerJob(boss, wired)
}
