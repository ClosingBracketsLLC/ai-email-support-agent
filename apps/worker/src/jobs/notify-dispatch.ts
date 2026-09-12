/**
 * The `notify.dispatch` job: fans one `notifications` row out to the org's enabled Expo devices.
 * Numbered rules below follow the task brief exactly. All DB access is short `withOrg` transactions
 * (the app role's 5 s idle-in-transaction timeout would kill one that spans network I/O) — the push
 * call itself always runs OUTSIDE a transaction, between the "can we send" read and the "what
 * happened" write.
 */
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import type PgBoss from 'pg-boss'
import type pino from 'pino'
import { z } from 'zod'
import { PUSH_DAILY_CAP } from '@aesa/contracts'
import { notificationDevices, notifications, tickets, usageCounters, withOrg, type Db, type OrgTx } from '@aesa/db'
import { defineJob, enqueue, registerJob, JOB_NAMES, type JobDefinition } from '@aesa/queue'
import { utcDayString } from '../date-utils.ts'
import type { SendPush } from '../push.ts'

/** The usage_counters meter the daily push cap reads and writes. */
const PUSH_METER = 'push_sent'

export const NotifyDispatchPayload = z.object({ orgId: z.string(), notificationId: z.string() })
export type NotifyDispatchPayload = z.infer<typeof NotifyDispatchPayload>

/**
 * The importable definition: producers (`ticket.triage`'s escalations, `mailbox.sync`'s tripwire/
 * reauth notices, `mailbox.poll-sweep`'s stuck-pending retry) `enqueue()` against this — which only
 * ever reads `.name`/`.schema`, never the handler. `registerNotifyDispatch` below builds the real,
 * deps-bound definition and registers THAT.
 */
export const notifyDispatchJob: JobDefinition<NotifyDispatchPayload> = defineJob({
  name: JOB_NAMES.notifyDispatch,
  schema: NotifyDispatchPayload,
  // policy: 'short' (QUEUE_OPTIONS): one delivery per notification id while the job is still
  // `created` — the producers' dedupe-keyed re-insert and the poll sweep's stuck-pending retry both
  // re-enqueue the same id (fix wave W8: `singletonKey` dedupes nothing on `standard`).
  handler: async () => {
    throw new Error('notify.dispatch: this definition has no bound deps — register it through registerNotifyDispatch(boss, deps)')
  },
})

export interface NotifyDispatchDeps {
  db: Db
  push: SendPush
  logger: pino.Logger
  now?: () => Date
}

export async function registerNotifyDispatch(boss: PgBoss, deps: NotifyDispatchDeps): Promise<void> {
  const wired: JobDefinition<NotifyDispatchPayload> = {
    ...notifyDispatchJob,
    handler: async (ctx) => {
      await runNotifyDispatch(deps, ctx.data)
    },
  }
  await registerJob(boss, wired)
}

/** Every producer (`ticket.triage`'s escalations, `mailbox.sync`'s tripwire/reauth notices,
 * `mailbox.poll-sweep`'s stuck-pending retry) sends through this — formerly `notify-stub.ts`'s
 * placeholder, now enqueuing against the real definition above. */
export async function enqueueNotifyDispatch(boss: PgBoss, orgId: string, notificationId: string): Promise<void> {
  await enqueue(boss, notifyDispatchJob, { orgId, notificationId }, { entityId: notificationId })
}

interface ReadyToPush {
  kind: string
  title: string
  body: string
  payload: unknown
  devices: { expoPushToken: string }[]
}

/** Rules 1-3, one short tx: idempotency, the daily cap, and the device fan-out list. Returns null
 * when there is nothing left for the caller to push (already handled, capped, or no devices). */
async function loadForDispatch(db: Db, orgId: string, notificationId: string, day: string, now: Date): Promise<ReadyToPush | null> {
  return withOrg(db, orgId, async (tx) => {
    // Rule 1: idempotent re-delivery — a notification not still 'pending' has already been
    // dispatched (or collapsed/failed) by an earlier delivery of this same job.
    const [n] = await tx
      .select({ kind: notifications.kind, title: notifications.title, body: notifications.body, payload: notifications.payload, status: notifications.status })
      .from(notifications)
      .where(eq(notifications.id, notificationId))
    if (!n || n.status !== 'pending') return null

    // Rule 2: daily cap. The digest cron carries anything collapsed here past its `digest_minutes`.
    const [counterRow] = await tx
      .select({ value: usageCounters.value })
      .from(usageCounters)
      .where(and(eq(usageCounters.day, day), eq(usageCounters.meter, PUSH_METER)))
    if ((counterRow?.value ?? 0) >= PUSH_DAILY_CAP) {
      await tx.update(notifications).set({ status: 'collapsed' }).where(eq(notifications.id, notificationId))
      return null
    }

    // Rule 3: no enabled devices means nothing to do — not an error.
    const devices = await tx
      .select({ expoPushToken: notificationDevices.expoPushToken })
      .from(notificationDevices)
      .where(and(eq(notificationDevices.orgId, orgId), isNull(notificationDevices.disabledAt)))
    if (devices.length === 0) {
      await tx.update(notifications).set({ status: 'sent', sentAt: now }).where(eq(notifications.id, notificationId))
      return null
    }

    return { kind: n.kind, title: n.title, body: n.body, payload: n.payload, devices }
  })
}

/** Rule 5: the escalation kind stamps the ticket's escalation_notified_at, once, on push success —
 * called INSIDE the same tx as the status flip below (fix review Finding 1): splitting these across
 * two transactions let a crash between them leave the notification 'sent' with the ticket never
 * stamped, forever — rule 1's idempotency guard blocks any retry once status is no longer 'pending'. */
async function stampEscalatedTicket(tx: OrgTx, payload: unknown, now: Date): Promise<void> {
  const ticketId = (payload as { ticketId?: string } | null)?.ticketId
  if (!ticketId) return
  await tx.update(tickets).set({ escalationNotifiedAt: now }).where(and(eq(tickets.id, ticketId), isNull(tickets.escalationNotifiedAt)))
}

export async function runNotifyDispatch(deps: NotifyDispatchDeps, payload: NotifyDispatchPayload): Promise<void> {
  const { orgId, notificationId } = payload
  const now = deps.now?.() ?? new Date()
  const day = utcDayString(now)

  const ready = await loadForDispatch(deps.db, orgId, notificationId, day, now)
  if (!ready) return

  // Rule 4: push OUTSIDE any tx. `kind` is stamped onto `data` (controller ruling) so the app's
  // push-tap routing (apps/app/src/lib/push-routing.ts) can read `data.kind` directly instead of
  // inferring it from which payload field happens to be present.
  const result = await deps.push({
    to: ready.devices.map((d) => d.expoPushToken),
    title: ready.title,
    body: ready.body,
    data: { kind: ready.kind, ...((ready.payload as Record<string, unknown> | null) ?? {}) },
    // Only the two reply pushes are actionable from the notification shade — the app registers a
    // category per kind (apps/app/src/lib/push.ts): `draft_review` gets `Review` alone (a pending
    // draft has nothing to hold), `auto_send` gets `Review` and `Hold`, because that reply is
    // already queued and the hold window is the whole point of the push. Every other kind is
    // informational, so it carries no category and the OS renders no action buttons.
    ...(ready.kind === 'auto_send' ? { categoryId: 'auto_send' }
      : ready.kind === 'draft_review' ? { categoryId: 'draft_review' }
        : {}),
  })

  if (!result.ok) {
    // Terminal per notification: poll-sweep's stuck-pending sweep (g) only retries 'pending' rows,
    // never 'failed' — a real send failure must not become a retry storm. At-least-once delivery
    // for THIS kind of event instead comes from the producers' own dedupe-keyed re-insert path.
    await withOrg(deps.db, orgId, (tx) => tx.update(notifications).set({ status: 'failed' }).where(eq(notifications.id, notificationId)))
    return
  }

  await withOrg(deps.db, orgId, async (tx) => {
    await tx.update(notifications).set({ status: 'sent', sentAt: now }).where(eq(notifications.id, notificationId))
    await tx
      .insert(usageCounters)
      .values({ orgId, day, meter: PUSH_METER, value: 1 })
      .onConflictDoUpdate({ target: [usageCounters.orgId, usageCounters.day, usageCounters.meter], set: { value: sql`${usageCounters.value} + 1` } })
    if (result.invalidTokens.length > 0) {
      await tx
        .update(notificationDevices)
        .set({ disabledAt: now })
        .where(and(eq(notificationDevices.orgId, orgId), inArray(notificationDevices.expoPushToken, result.invalidTokens)))
    }
    // Finding 1: same tx as the status flip above — see stampEscalatedTicket's own doc comment.
    if (ready.kind === 'escalation') await stampEscalatedTicket(tx, ready.payload, now)
  })
}
