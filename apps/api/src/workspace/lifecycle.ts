/**
 * Settings → Workspace's lifecycle half as ONE service module, mirroring `src/billing/service.ts`,
 * `src/llm/service.ts` and `src/memory/service.ts`: every procedure is a plain exported async
 * function `(deps, orgId, …) => result`, a soft outcome is a typed `{ ok: false; code }` (never a
 * thrown error), and `trpc/routers/workspace.ts` does nothing but map those codes onto `TRPCError`s.
 *
 * What lives here is everything an owner can do TO the workspace rather than inside it: the kill
 * switch, the retention window, deletion with its 30-day grace period, and the data export. Every
 * one of them is `ownerProcedure` — an admin manages the workspace, only the owner ends it.
 *
 * Discipline every function here keeps (CLAUDE.md):
 *  - ONE `withOrg` transaction per write, NEVER spanning a network call. `requestDeletion` is
 *    therefore a short READ transaction, then the Stripe cancel, then ONE write transaction — a
 *    transaction that awaited Stripe would hold the workspace row's locks for the whole round trip
 *    and blow through the app role's 5 s idle-in-transaction timeout on a slow one.
 *  - every write is guarded on the value it was READ at (`deletion_requested_at IS NULL`,
 *    `export_state = <what we read>`), and zero rows is a soft outcome the caller reports, never an
 *    error — that is what makes a concurrent second tap, or a sweep, simply win.
 *  - the notification a deletion raises is DISPATCHED after the commit, like `llm/service.ts`'s;
 *    a null job id is a warn, never a throw.
 *
 * Lock order: the only row any of this writes is `workspaces`, which is the LAST of the four ordered
 * row kinds and is never taken here beside a ticket, draft or send — so the global order is not
 * engaged.
 *
 * `presignGet` (used by `exportStatus`) is a local SigV4 computation in the S3 adapter, not a
 * request — see `@aesa/knowledge/storage`'s port doc, which is pinned by a test against an endpoint
 * nothing is listening on. It is still called OUTSIDE the read transaction here, because "no network
 * I/O inside `withOrg`" is cheaper to keep true by construction than to re-verify per adapter.
 */
import { randomUUID } from 'node:crypto'
import { and, eq, isNotNull, isNull } from 'drizzle-orm'
import type pino from 'pino'
import { WORKSPACE_DELETE_GRACE_DAYS, exportObjectKey, type ExportState } from '@aesa/contracts'
import { audit, notifications, readBillingState, workspaces, type AuditActor } from '@aesa/db'
import type { ObjectStore } from '@aesa/knowledge/storage'
import { JOB_NAMES } from '@aesa/queue'
import type { StripePort } from '../billing/stripe.ts'
import type { ApiFacade, EnqueueFn } from '../deps.ts'

export interface LifecycleDeps {
  api: ApiFacade
  enqueue: EnqueueFn
  logger: pino.Logger
  /** null when STRIPE_* is unconfigured (every dev box without keys). A workspace that has no live
   *  subscription deletes fine without it; one that HAS a live subscription cannot (see
   *  `requestDeletion`) — scheduling a purge while the card keeps being charged is the one outcome
   *  worth refusing outright. */
  stripe: StripePort | null
  /** The same bucket the `knowledge` worker writes the export bundle into — `exportStatus` only ever
   *  presigns a GET against it. */
  store: ObjectStore
  /** Test seam; production leaves it unset and reads the wall clock per call. */
  now?: () => Date
}

/** Who is acting — the same shape as `memory/service.ts`'s `MemoryActor`. */
export interface LifecycleActor {
  userId: string
  actor: AuditActor
  ip?: string | null
  userAgent?: string | null
}

const clock = (deps: LifecycleDeps): Date => deps.now?.() ?? new Date()

/** How long a `ready` export's download link stays valid. Seven days is SigV4's own ceiling, and it
 *  matches the copy in the "your export is ready" notification the worker sends. */
export const EXPORT_URL_TTL_SECONDS = 7 * 24 * 60 * 60

/** `deletion_requested_at` + the grace period — the moment `workspace.purge` will actually run. */
export const purgeAfterFor = (deletionRequestedAt: Date): Date =>
  new Date(deletionRequestedAt.getTime() + WORKSPACE_DELETE_GRACE_DAYS * 24 * 60 * 60_000)

/**
 * An org whose `workspaces` row is missing. Unreachable for a signed-in owner — `workspace.create`
 * writes the row in the same call that makes the organization, and every screen that can reach these
 * procedures has already loaded `workspace.get`, which 404s without it. Thrown (and masked to a bare
 * 500 by the tRPC error formatter) rather than folded into a soft code: it is a broken invariant, not
 * an outcome any caller should render.
 */
const workspaceMissing = (orgId: string): Error => new Error(`workspace row missing for org ${orgId}`)

// ---------------------------------------------------------------------------
// the kill switch
// ---------------------------------------------------------------------------

/**
 * "Stop sending, now." The switch every send path already reads — `send.execute`'s
 * `workspace_kill_switch` lever, `drafts.approve`'s `kill_switch` refusal and the `/a/:draftId`
 * review page's own result — so nothing else has to change for it to bite; this is only what lets
 * the owner reach it.
 */
export async function setKillSwitch(
  deps: LifecycleDeps, orgId: string, on: boolean, actor: LifecycleActor,
): Promise<{ killSwitch: boolean }> {
  await deps.api.withOrg(orgId, async (tx) => {
    const updated = await tx.update(workspaces).set({ killSwitch: on })
      .where(eq(workspaces.orgId, orgId))
      .returning({ killSwitch: workspaces.killSwitch })
    if (updated.length === 0) throw workspaceMissing(orgId)
    await audit(tx, {
      actor: actor.actor, action: on ? 'workspace.kill_switch_on' : 'workspace.kill_switch_off',
      entityType: 'workspace', entityId: orgId, detail: { killSwitch: on }, ip: actor.ip, userAgent: actor.userAgent,
    })
  })
  return { killSwitch: on }
}

// ---------------------------------------------------------------------------
// retention
// ---------------------------------------------------------------------------

/**
 * How long this workspace keeps message bodies before the nightly `retention.sweep` purges them.
 * The 30–730 bounds live in `SetRetentionDaysInput` AND in the column's own CHECK, so a value that
 * reached here is already legal on both sides.
 */
export async function setRetentionDays(
  deps: LifecycleDeps, orgId: string, days: number, actor: LifecycleActor,
): Promise<{ retentionDays: number }> {
  await deps.api.withOrg(orgId, async (tx) => {
    const updated = await tx.update(workspaces).set({ retentionDays: days })
      .where(eq(workspaces.orgId, orgId))
      .returning({ retentionDays: workspaces.retentionDays })
    if (updated.length === 0) throw workspaceMissing(orgId)
    await audit(tx, {
      actor: actor.actor, action: 'workspace.retention_set', entityType: 'workspace', entityId: orgId,
      detail: { retentionDays: days }, ip: actor.ip, userAgent: actor.userAgent,
    })
  })
  return { retentionDays: days }
}

// ---------------------------------------------------------------------------
// deletion
// ---------------------------------------------------------------------------

export type RequestDeletionResult =
  | { ok: true; purgeAfter: Date }
  | { ok: false; code: 'confirm_mismatch' | 'deletion_pending' | 'billing_cancel_failed' }

/**
 * "Delete this workspace." Schedules the irreversible purge `workspace.purge-sweep` will run once
 * the grace period is up, and stops the agent in the same breath — a workspace on its way out must
 * not keep answering customers for another 30 days.
 *
 * Order, and why it is this order:
 *  1. read the business name, the pending stamp and the billing row — one short transaction;
 *  2. refuse a confirm string that is not the business name EXACTLY, and a deletion already pending,
 *     before anything at all happens;
 *  3. cancel the live Stripe subscription — network, outside every transaction. A failure REFUSES
 *     the deletion (`billing_cancel_failed`) rather than scheduling one: a purged workspace whose
 *     card is still being charged every month is the worst outcome available here, and the owner can
 *     simply try again;
 *  4. ONE transaction: the stamps, the kill switch, the agent off, the audit row and the owner's
 *     notification, guarded on `deletion_requested_at IS NULL` so a second tap lands `deletion_pending`
 *     instead of restarting the clock;
 *  5. dispatch the notification after the commit.
 */
export async function requestDeletion(
  deps: LifecycleDeps, orgId: string, confirm: string, actor: LifecycleActor,
): Promise<RequestDeletionResult> {
  const now = clock(deps)

  const read = await deps.api.withOrg(orgId, async (tx) => {
    const [ws] = await tx.select({ businessName: workspaces.businessName, deletionRequestedAt: workspaces.deletionRequestedAt })
      .from(workspaces).where(eq(workspaces.orgId, orgId))
    if (!ws) throw workspaceMissing(orgId)
    const billing = await readBillingState(tx, now)
    return { ws, billing }
  })

  if (confirm !== read.ws.businessName) return { ok: false, code: 'confirm_mismatch' }
  if (read.ws.deletionRequestedAt !== null) return { ok: false, code: 'deletion_pending' }

  // The same "is there a live subscription" test `startCheckout`'s `already_subscribed` uses: an id
  // plus a state that is still being billed. A `canceled` row needs nothing cancelled again.
  const subscriptionId = read.billing.stripeSubscriptionId
  const live = subscriptionId !== null && (read.billing.state === 'active' || read.billing.state === 'past_due')

  if (live) {
    if (!deps.stripe) {
      // A workspace holding a live Stripe subscription on a process with no Stripe keys is a
      // misconfiguration, not a soft state — and the safe direction is to refuse, because the
      // alternative is a purged tenant whose card keeps being charged with nothing left to cancel it
      // from. (Task 11 replaces this with `alert('billing_unconfigured', …)`.)
      deps.logger.error(
        { alert: true, kind: 'deletion_billing_unconfigured', orgId },
        'workspace.requestDeletion: a live subscription cannot be cancelled — STRIPE_* is not configured',
      )
      return { ok: false, code: 'billing_cancel_failed' }
    }
    try {
      await deps.stripe.cancelSubscription(subscriptionId)
    } catch (err) {
      deps.logger.warn({ err, orgId }, 'billing.cancel_subscription_failed')
      return { ok: false, code: 'billing_cancel_failed' }
    }
  }

  const outcome = await deps.api.withOrg(orgId, async (tx) => {
    const stamped = await tx.update(workspaces)
      .set({ deletionRequestedAt: now, deletionRequestedBy: actor.userId, killSwitch: true, agentEnabled: false })
      .where(and(eq(workspaces.orgId, orgId), isNull(workspaces.deletionRequestedAt)))
      .returning({ deletionRequestedAt: workspaces.deletionRequestedAt })
    // Zero rows: another tap (or another owner) got here first between the read and this write.
    // Their clock stands — this call reports the same thing it would have reported at step 2.
    if (stamped.length === 0) return null

    const purgeAfter = purgeAfterFor(stamped[0]!.deletionRequestedAt!)
    await audit(tx, {
      actor: actor.actor, action: 'workspace.deletion_requested', entityType: 'workspace', entityId: orgId,
      detail: { purgeAfter: purgeAfter.toISOString(), subscriptionCancelled: live },
      ip: actor.ip, userAgent: actor.userAgent,
    })
    const [note] = await tx.insert(notifications)
      .values({
        orgId, kind: 'workspace', title: 'Workspace deletion scheduled',
        body: 'Everything this workspace holds is erased after the grace period. Cancel any time before then in Settings → Workspace.',
        // One page per workspace, ever — not per request and not per day. A deletion cancelled and
        // asked for again is the same owner making the same decision twice; they are looking at the
        // screen that told them, and a second push adds nothing. The row also outlives the cancel,
        // so the outbox keeps the record of having warned them.
        dedupeKey: `workspace:deletion:${orgId}`, payload: { kind: 'deletion_scheduled', purgeAfter: purgeAfter.toISOString() },
      })
      .onConflictDoNothing({ target: notifications.dedupeKey })
      .returning({ id: notifications.id })
    return { purgeAfter, notificationId: note?.id ?? null }
  })

  if (!outcome) return { ok: false, code: 'deletion_pending' }
  if (outcome.notificationId) await dispatchNotification(deps, orgId, outcome.notificationId)
  return { ok: true, purgeAfter: outcome.purgeAfter }
}

export type CancelDeletionResult = { ok: true } | { ok: false; code: 'not_pending' }

/**
 * "Actually, keep it." Clears the stamps and nothing else: the kill switch stays ON and the agent
 * stays OFF, because both are decisions with customer-visible consequences and the owner turns each
 * back on deliberately, from its own control. Guarded on the stamp being set, so the nightly purge
 * having already claimed the workspace reads as `not_pending` rather than as a cancel that did
 * nothing.
 */
export async function cancelDeletion(
  deps: LifecycleDeps, orgId: string, actor: LifecycleActor,
): Promise<CancelDeletionResult> {
  return deps.api.withOrg(orgId, async (tx) => {
    const cleared = await tx.update(workspaces)
      .set({ deletionRequestedAt: null, deletionRequestedBy: null })
      .where(and(eq(workspaces.orgId, orgId), isNotNull(workspaces.deletionRequestedAt)))
      .returning({ orgId: workspaces.orgId })
    if (cleared.length === 0) return { ok: false, code: 'not_pending' }
    await audit(tx, {
      actor: actor.actor, action: 'workspace.deletion_cancelled', entityType: 'workspace', entityId: orgId,
      detail: {}, ip: actor.ip, userAgent: actor.userAgent,
    })
    return { ok: true }
  })
}

// ---------------------------------------------------------------------------
// the export
// ---------------------------------------------------------------------------

export type RequestExportResult = { ok: true; exportId: string } | { ok: false; code: 'export_in_progress' }

/**
 * "Give me everything." Claims the export slot and hands `workspace.export` the id it will build
 * under; the key is minted with `exportObjectKey` from `@aesa/contracts` — the ONE function the job
 * validates the stored key against — and never spelled out here.
 *
 * **Ruling R16: this MUST refuse while `export_state = 'queued'`.** `workspace.export` lands a row
 * `failed` when a `queued` row's `export_key` names an export id that is not the one on its payload,
 * precisely because that can only be a programming error between the two sides. Letting a second
 * request move `export_key` under a job that is still in flight would turn that branch into a
 * failure the OWNER's newest request caused and never saw — so the refusal here is the enforcement
 * half of that contract, not politeness. `apps/worker/src/jobs/workspace-export.ts`'s "Guards, both
 * ends" header states it from the other side; changing one is a breaking change to the other.
 */
export async function requestExport(
  deps: LifecycleDeps, orgId: string, actor: LifecycleActor,
): Promise<RequestExportResult> {
  const now = clock(deps)
  const exportId = randomUUID()
  const key = exportObjectKey(orgId, exportId)

  const claimed = await deps.api.withOrg(orgId, async (tx) => {
    const [ws] = await tx.select({ exportState: workspaces.exportState }).from(workspaces).where(eq(workspaces.orgId, orgId))
    if (!ws) throw workspaceMissing(orgId)
    if (ws.exportState === 'queued') return false

    // Guarded on the state it was read at: a concurrent request that claimed the slot in between
    // wins, and this one reports the same `export_in_progress` it would have a line earlier.
    const written = await tx.update(workspaces)
      .set({ exportState: 'queued', exportKey: key, exportRequestedAt: now, exportReadyAt: null })
      .where(and(eq(workspaces.orgId, orgId), eq(workspaces.exportState, ws.exportState)))
      .returning({ orgId: workspaces.orgId })
    if (written.length === 0) return false

    await audit(tx, {
      actor: actor.actor, action: 'workspace.export_requested', entityType: 'workspace', entityId: orgId,
      detail: { exportId }, ip: actor.ip, userAgent: actor.userAgent,
    })
    return true
  })
  if (!claimed) return { ok: false, code: 'export_in_progress' }

  const jobId = await deps.enqueue(JOB_NAMES.workspaceExport, { orgId, exportId }, { entityId: exportId })
  if (jobId === null) deps.logger.warn({ orgId, exportId }, 'workspace.export enqueue returned no job id')
  return { ok: true, exportId }
}

export interface ExportStatusView {
  state: ExportState
  readyAt: Date | null
  /** A time-limited download link, and ONLY while the bundle is `ready`. */
  url: string | null
}

export async function exportStatus(deps: LifecycleDeps, orgId: string): Promise<ExportStatusView> {
  const row = await deps.api.withOrg(orgId, async (tx) => {
    const [ws] = await tx.select({
      exportState: workspaces.exportState, exportKey: workspaces.exportKey, exportReadyAt: workspaces.exportReadyAt,
    }).from(workspaces).where(eq(workspaces.orgId, orgId))
    if (!ws) throw workspaceMissing(orgId)
    return ws
  })

  const state = row.exportState as ExportState
  if (state !== 'ready' || !row.exportKey) return { state, readyAt: row.exportReadyAt, url: null }
  return {
    state, readyAt: row.exportReadyAt,
    url: await deps.store.presignGet(row.exportKey, { expiresSeconds: EXPORT_URL_TTL_SECONDS }),
  }
}

/** Post-commit push, exactly as `llm/service.ts` does it: a null job id is a warn, never a throw —
 *  the workspace is already scheduled for deletion and must not un-schedule itself over a push. */
async function dispatchNotification(deps: LifecycleDeps, orgId: string, notificationId: string): Promise<void> {
  const jobId = await deps.enqueue(JOB_NAMES.notifyDispatch, { orgId, notificationId }, { entityId: notificationId })
  if (jobId === null) deps.logger.warn({ orgId, notificationId }, 'notify.dispatch enqueue returned no job id; the digest will collapse it')
}
