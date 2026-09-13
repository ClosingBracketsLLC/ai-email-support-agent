/**
 * Settings → Workspace's lifecycle half (`src/workspace/lifecycle.ts` behind the `workspace` router):
 * the kill switch, the retention window, "delete this workspace" with its 30-day grace period, and
 * the owner's data export.
 *
 * Two properties this suite exists to pin, both about `requestDeletion` — the one irreversible
 * thing an owner can start from the app:
 *  - the Stripe cancel happens BEFORE anything is written, and a failing cancel writes NOTHING.
 *    `fake.onCall.cancelSubscription` reads the workspaces row back through an INDEPENDENT
 *    connection at the moment the Stripe call starts (the same technique `billing-service.test.ts`
 *    uses): seeing `deletion_requested_at` still null there proves the write had not happened yet —
 *    and, since the service holds no transaction across the call, that it was not merely uncommitted.
 *  - every lifecycle mutation is `ownerProcedure`. An admin manages the workspace; only the owner
 *    deletes it, exports it, or pulls the kill switch.
 *
 * Ruling R16 is pinned here too: `requestExport` REFUSES while an export is `queued`, because
 * `workspace.export` fails a row that is queued for a key that is not the one on its payload.
 */
import { randomUUID } from 'node:crypto'
import { createTRPCClient, httpBatchLink } from '@trpc/client'
import { eq } from 'drizzle-orm'
import superjson from 'superjson'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { WORKSPACE_DELETE_GRACE_DAYS, WORKSPACE_ERROR_MESSAGES, exportObjectKey } from '@aesa/contracts'
import { auditLog, billingSubscriptions, notifications, workspaces } from '@aesa/db'
import { createMemoryStore, type ObjectStore } from '@aesa/knowledge/storage'
import { JOB_NAMES } from '@aesa/queue'
import type { EnqueueFn } from '../src/deps.ts'
import type { AppRouter } from '../src/trpc/router.ts'
import { createAppLogger } from '../src/logging.ts'
import { cancelDeletion, requestDeletion, requestExport, type LifecycleDeps } from '../src/workspace/lifecycle.ts'
import { WEB, createTestApi, listen, signInWithOtp } from './helpers/app.ts'
import { callsTo, createFakeStripe, type FakeStripe } from './helpers/fake-stripe.ts'

const client = (base: string, cookie?: string) => createTRPCClient<AppRouter>({
  links: [httpBatchLink({ url: `${base}/trpc`, transformer: superjson, headers: () => ({ origin: WEB, ...(cookie ? { cookie } : {}) }) })],
})

const DAY_MS = 86_400_000

interface Recorded { name: string; data: Record<string, unknown>; opts: { entityId: string } }

describe('workspace lifecycle', () => {
  let t: Awaited<ReturnType<typeof createTestApi>>
  let base: string
  let fake: FakeStripe
  let sent: Recorded[]
  /** Every `presignGet` the api issued — the only way to pin the download URL's lifetime. */
  let presigned: { key: string; expiresSeconds: number }[]
  let seq = 0

  beforeAll(async () => {
    fake = createFakeStripe()
    sent = []
    const enqueue: EnqueueFn = async (name, data, opts) => { sent.push({ name, data, opts }); return `job-${sent.length}` }
    presigned = []
    const inner = createMemoryStore()
    const store: ObjectStore = {
      ...inner,
      presignGet: async (key, opts) => { presigned.push({ key, expiresSeconds: opts.expiresSeconds }); return inner.presignGet(key, opts) },
    }
    t = await createTestApi({}, { enqueue, stripe: fake.port, store })
    base = await listen(t.app)
  })
  afterAll(async () => { await t.close() })
  beforeEach(() => {
    sent.length = 0
    presigned.length = 0
    fake.calls.length = 0
    fake.failing.clear()
    for (const key of Object.keys(fake.onCall)) delete fake.onCall[key as keyof FakeStripe['onCall']]
  })

  /** A fresh owner + workspace per case — nothing here is safe to share, deletion least of all. */
  async function setupOrg(businessName = 'Acme') {
    const n = ++seq
    const signed = await signInWithOtp(t.app, t.mail, `lifecycle-${n}@example.com`, 'Owner')
    const c = client(base, signed.cookie)
    const { orgId } = await c.workspace.create.mutate({ businessName, timezone: 'UTC' })
    return { orgId, c, userId: signed.user.id, cookie: signed.cookie, businessName, seq: n }
  }

  const readWorkspace = (orgId: string) =>
    t.api.withOrg(orgId, async (tx) => (await tx.select().from(workspaces).where(eq(workspaces.orgId, orgId)))[0])
  const readAudit = (orgId: string, action: string) =>
    t.api.withOrg(orgId, (tx) => tx.select().from(auditLog).where(eq(auditLog.action, action)))

  /** A live Stripe subscription on the workspace — what `requestDeletion` has to cancel first.
   *  `stripe_customer_id` is unique platform-wide, so each workspace gets its own. */
  const giveSubscription = (orgId: string, subscriptionId: string) =>
    t.api.withOrg(orgId, (tx) => tx.update(billingSubscriptions)
      .set({ plan: 'standard', status: 'active', stripeCustomerId: `cus_${subscriptionId}`, stripeSubscriptionId: subscriptionId })
      .where(eq(billingSubscriptions.orgId, orgId)))

  /** An invited member (never an owner) on the same workspace, with the org made active. */
  async function inviteMember(org: Awaited<ReturnType<typeof setupOrg>>, role: 'member' | 'admin') {
    const email = `lifecycle-${role}-${org.seq}@example.com`
    const signed = await signInWithOtp(t.app, t.mail, email, 'Bob')
    const { invitationId } = await org.c.team.invite.mutate({ email, role })
    await t.app.inject({
      method: 'POST', url: '/api/auth/organization/accept-invitation',
      headers: { origin: WEB, cookie: signed.cookie, 'content-type': 'application/json' }, payload: { invitationId },
    })
    await t.app.inject({
      method: 'POST', url: '/api/auth/organization/set-active',
      headers: { origin: WEB, cookie: signed.cookie, 'content-type': 'application/json' }, payload: { organizationId: org.orgId },
    })
    return client(base, signed.cookie)
  }

  // -------------------------------------------------------------------------------------------
  // the kill switch
  // -------------------------------------------------------------------------------------------

  it('setKillSwitch writes the column, audits on and off, and workspace.get reports it', async () => {
    const org = await setupOrg()
    expect((await org.c.workspace.get.query()).killSwitch).toBe(false)

    expect(await org.c.workspace.setKillSwitch.mutate({ on: true })).toEqual({ killSwitch: true })
    expect(await readWorkspace(org.orgId)).toMatchObject({ killSwitch: true })
    expect((await org.c.workspace.get.query()).killSwitch).toBe(true)
    const on = await readAudit(org.orgId, 'workspace.kill_switch_on')
    expect(on).toHaveLength(1)
    expect(on[0]).toMatchObject({ actor: `user:${org.userId}`, entityType: 'workspace', entityId: org.orgId })

    expect(await org.c.workspace.setKillSwitch.mutate({ on: false })).toEqual({ killSwitch: false })
    expect(await readWorkspace(org.orgId)).toMatchObject({ killSwitch: false })
    expect(await readAudit(org.orgId, 'workspace.kill_switch_off')).toHaveLength(1)
  })

  it('every lifecycle mutation is owner-only — an admin (who may manage everything else) gets FORBIDDEN', async () => {
    const org = await setupOrg()
    const asAdmin = await inviteMember(org, 'admin')

    // The admin can still manage the workspace itself — this is a narrower rung, not a broken one.
    expect(await asAdmin.workspace.advanceOnboarding.mutate()).toMatchObject({ to: expect.any(String) })

    // Awaited one at a time on purpose: httpBatchLink batches everything created in one tick into a
    // single URL, and five procedure names tip it past Fastify's max param length (414).
    for (const call of [
      () => asAdmin.workspace.setKillSwitch.mutate({ on: true }),
      () => asAdmin.workspace.setRetentionDays.mutate({ retentionDays: 90 }),
      () => asAdmin.workspace.requestDeletion.mutate({ confirm: org.businessName }),
      () => asAdmin.workspace.cancelDeletion.mutate(),
      () => asAdmin.workspace.requestExport.mutate(),
    ]) {
      await expect(call()).rejects.toMatchObject({ data: { code: 'FORBIDDEN' } })
    }
    // …and nothing leaked through: no kill switch, no deletion, no export.
    expect(await readWorkspace(org.orgId)).toMatchObject({
      killSwitch: false, deletionRequestedAt: null, exportState: 'none', exportKey: null,
    })
    // Reading the export state IS every teammate's business.
    expect(await asAdmin.workspace.exportStatus.query()).toEqual({ state: 'none', readyAt: null, url: null })
  })

  // -------------------------------------------------------------------------------------------
  // retention
  // -------------------------------------------------------------------------------------------

  it('setRetentionDays refuses 29 at the input and writes + audits 90', async () => {
    const org = await setupOrg()
    await expect(org.c.workspace.setRetentionDays.mutate({ retentionDays: 29 })).rejects.toMatchObject({ data: { code: 'BAD_REQUEST' } })
    await expect(org.c.workspace.setRetentionDays.mutate({ retentionDays: 731 })).rejects.toMatchObject({ data: { code: 'BAD_REQUEST' } })
    expect(await readWorkspace(org.orgId)).toMatchObject({ retentionDays: 180 })

    expect(await org.c.workspace.setRetentionDays.mutate({ retentionDays: 90 })).toEqual({ retentionDays: 90 })
    expect(await readWorkspace(org.orgId)).toMatchObject({ retentionDays: 90 })
    expect((await org.c.workspace.get.query()).retentionDays).toBe(90)
    const rows = await readAudit(org.orgId, 'workspace.retention_set')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.detail).toEqual({ retentionDays: 90 })
  })

  // -------------------------------------------------------------------------------------------
  // deletion
  // -------------------------------------------------------------------------------------------

  it('requestDeletion with the wrong name is BAD_REQUEST and writes nothing — not even a Stripe call', async () => {
    const org = await setupOrg('Acme & Sons')
    await giveSubscription(org.orgId, 'sub_live_wrong_name')

    await expect(org.c.workspace.requestDeletion.mutate({ confirm: 'wrong name' })).rejects.toMatchObject({
      message: WORKSPACE_ERROR_MESSAGES.confirm_mismatch, data: { code: 'BAD_REQUEST' },
    })
    expect(callsTo(fake, 'cancelSubscription')).toHaveLength(0)
    expect(await readWorkspace(org.orgId)).toMatchObject({ deletionRequestedAt: null, deletionRequestedBy: null, killSwitch: false })
    expect(await readAudit(org.orgId, 'workspace.deletion_requested')).toHaveLength(0)
  })

  it('requestDeletion cancels the subscription BEFORE the write, then stamps, kills the switch, disables the agent, audits, pages the owner — and a second request is deletion_pending', async () => {
    const org = await setupOrg('Acme & Sons')
    await giveSubscription(org.orgId, 'sub_live_delete')
    await org.c.workspace.setAgentEnabled.mutate({ enabled: true })

    // Read the row back through an independent connection at the moment Stripe is called.
    let atCancel: Awaited<ReturnType<typeof readWorkspace>>
    fake.onCall.cancelSubscription = async () => { atCancel = await readWorkspace(org.orgId) }

    const before = Date.now()
    const res = await org.c.workspace.requestDeletion.mutate({ confirm: 'Acme & Sons' })

    const cancels = callsTo(fake, 'cancelSubscription')
    expect(cancels).toHaveLength(1)
    expect(cancels[0]!.params).toEqual({ subscriptionId: 'sub_live_delete' })
    expect(atCancel!).toMatchObject({ deletionRequestedAt: null, killSwitch: false, agentEnabled: true })

    const ws = await readWorkspace(org.orgId)
    expect(ws).toMatchObject({ killSwitch: true, agentEnabled: false, deletionRequestedBy: org.userId })
    expect(ws!.deletionRequestedAt).toBeInstanceOf(Date)
    const expectedPurge = ws!.deletionRequestedAt!.getTime() + WORKSPACE_DELETE_GRACE_DAYS * DAY_MS
    expect(res.purgeAfter.getTime()).toBe(expectedPurge)
    expect(res.purgeAfter.getTime()).toBeGreaterThan(before + (WORKSPACE_DELETE_GRACE_DAYS - 1) * DAY_MS)

    const audits = await readAudit(org.orgId, 'workspace.deletion_requested')
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({ actor: `user:${org.userId}`, entityType: 'workspace', entityId: org.orgId })
    expect(audits[0]!.detail).toMatchObject({ subscriptionCancelled: true })

    const [note] = await t.api.withOrg(org.orgId, (tx) => tx.select().from(notifications).where(eq(notifications.orgId, org.orgId)))
    expect(note).toMatchObject({ kind: 'workspace', dedupeKey: `workspace:deletion:${org.orgId}:${ws!.deletionRequestedAt!.toISOString().slice(0, 10)}` })
    expect(note!.payload).toMatchObject({ kind: 'deletion_scheduled' })
    expect(sent.filter((s) => s.name === JOB_NAMES.notifyDispatch)).toEqual([
      { name: JOB_NAMES.notifyDispatch, data: { orgId: org.orgId, notificationId: note!.id }, opts: { entityId: note!.id } },
    ])

    // A second request finds the stamp already set and refuses — and never calls Stripe again.
    await expect(org.c.workspace.requestDeletion.mutate({ confirm: 'Acme & Sons' })).rejects.toMatchObject({
      message: WORKSPACE_ERROR_MESSAGES.deletion_pending, data: { code: 'PRECONDITION_FAILED' },
    })
    expect(callsTo(fake, 'cancelSubscription')).toHaveLength(1)
    expect(await readAudit(org.orgId, 'workspace.deletion_requested')).toHaveLength(1)
  })

  it('the deletion notice and both results tell the truth about the subscription: cancelled immediately, and never restored by Cancel', async () => {
    const subscribed = await setupOrg()
    await giveSubscription(subscribed.orgId, 'sub_live_truth')

    const requested = await subscribed.c.workspace.requestDeletion.mutate({ confirm: 'Acme' })
    expect(requested.subscriptionCancelled).toBe(true)

    // `subscriptions.cancel` is immediate, not `cancel_at_period_end` — so the owner-facing copy must
    // not imply Cancel puts the plan back.
    const [note] = await t.api.withOrg(subscribed.orgId, (tx) =>
      tx.select().from(notifications).where(eq(notifications.orgId, subscribed.orgId)))
    expect(note!.body).toMatch(/subscription/i)
    expect(note!.body).toMatch(/re-?subscrib/i)

    // …and Cancel says so too, so the Workspace screen can point at Billing.
    expect(await subscribed.c.workspace.cancelDeletion.mutate()).toEqual({ ok: true, subscriptionCancelled: true })

    // A workspace that never had a subscription is told none of that, on either call.
    const free = await setupOrg()
    expect((await free.c.workspace.requestDeletion.mutate({ confirm: 'Acme' })).subscriptionCancelled).toBe(false)
    const [freeNote] = await t.api.withOrg(free.orgId, (tx) =>
      tx.select().from(notifications).where(eq(notifications.orgId, free.orgId)))
    expect(freeNote!.body).not.toMatch(/subscription/i)
    expect(await free.c.workspace.cancelDeletion.mutate()).toEqual({ ok: true, subscriptionCancelled: false })
  })

  it('a failing Stripe cancel refuses the deletion outright (BAD_GATEWAY) and writes nothing', async () => {
    const org = await setupOrg()
    await giveSubscription(org.orgId, 'sub_live_boom')
    fake.failing.add('cancelSubscription')

    await expect(org.c.workspace.requestDeletion.mutate({ confirm: 'Acme' })).rejects.toMatchObject({
      message: WORKSPACE_ERROR_MESSAGES.billing_cancel_failed, data: { code: 'BAD_GATEWAY' },
    })
    expect(callsTo(fake, 'cancelSubscription')).toHaveLength(1)
    expect(await readWorkspace(org.orgId)).toMatchObject({ deletionRequestedAt: null, deletionRequestedBy: null, killSwitch: false })
    expect(await readAudit(org.orgId, 'workspace.deletion_requested')).toHaveLength(0)
    expect(await t.api.withOrg(org.orgId, (tx) => tx.select().from(notifications).where(eq(notifications.orgId, org.orgId)))).toHaveLength(0)

    // Once Stripe answers, the same request goes through.
    fake.failing.clear()
    const res = await org.c.workspace.requestDeletion.mutate({ confirm: 'Acme' })
    expect(res.purgeAfter).toBeInstanceOf(Date)
    expect(callsTo(fake, 'cancelSubscription')).toHaveLength(2)
  })

  it('an unconfigured Stripe cannot delete a workspace that still has a live subscription — it refuses and alerts', async () => {
    const org = await setupOrg()
    await giveSubscription(org.orgId, 'sub_live_unconfigured')

    // Driven through the service so the deps can say what no `createTestApi` override can: a replica
    // with STRIPE_* unset, holding a workspace whose card is still being charged. Scheduling a purge
    // there would leave a billed customer with nothing left to cancel the subscription from.
    const lines: string[] = []
    const deps: LifecycleDeps = {
      api: t.api, enqueue: async () => null,
      logger: createAppLogger({ level: 'error', stream: { write: (line: string) => void lines.push(line) } }),
      stripe: null, store: t.store,
    }
    const res = await requestDeletion(deps, org.orgId, 'Acme', { userId: org.userId, actor: `user:${org.userId}` })
    expect(res).toEqual({ ok: false, code: 'billing_cancel_failed' })
    expect(await readWorkspace(org.orgId)).toMatchObject({ deletionRequestedAt: null, killSwitch: false })
    expect(await readAudit(org.orgId, 'workspace.deletion_requested')).toHaveLength(0)
    expect(lines.join('')).toContain('"alert":true')
    expect(lines.join('')).toContain('deletion_billing_unconfigured')

    // The same deps delete a workspace that has no live subscription perfectly well.
    const free = await setupOrg()
    expect(await requestDeletion(deps, free.orgId, 'Acme', { userId: free.userId, actor: `user:${free.userId}` }))
      .toMatchObject({ ok: true })
  })

  it('a workspace with no live subscription is deleted without touching Stripe at all', async () => {
    const org = await setupOrg()
    const res = await org.c.workspace.requestDeletion.mutate({ confirm: 'Acme' })
    expect(res.purgeAfter).toBeInstanceOf(Date)
    expect(callsTo(fake, 'cancelSubscription')).toHaveLength(0)
    expect((await readAudit(org.orgId, 'workspace.deletion_requested'))[0]!.detail).toMatchObject({ subscriptionCancelled: false })
  })

  it('cancelDeletion clears the stamps and audits, but leaves the kill switch on and the agent off; a workspace that is not pending is PRECONDITION_FAILED', async () => {
    const org = await setupOrg()
    // Ruling R18: the sentence is `@aesa/contracts`', not the router's — one place to reword it, and
    // the one string Settings → Workspace keys its own copy on.
    await expect(org.c.workspace.cancelDeletion.mutate()).rejects.toMatchObject({
      message: WORKSPACE_ERROR_MESSAGES.not_pending, data: { code: 'PRECONDITION_FAILED' },
    })

    await org.c.workspace.setAgentEnabled.mutate({ enabled: true })
    await org.c.workspace.requestDeletion.mutate({ confirm: 'Acme' })

    // A workspace that never subscribed is told so — the subscription half is pinned by its own case.
    expect(await org.c.workspace.cancelDeletion.mutate()).toEqual({ ok: true, subscriptionCancelled: false })
    expect(await readWorkspace(org.orgId)).toMatchObject({
      deletionRequestedAt: null, deletionRequestedBy: null,
      // Deliberate: the owner turns these back on themselves, one considered tap at a time.
      killSwitch: true, agentEnabled: false,
    })
    expect(await readAudit(org.orgId, 'workspace.deletion_cancelled')).toHaveLength(1)

    const view = await org.c.workspace.get.query()
    expect(view.deletionRequestedAt).toBeNull()
    expect(view.purgeAfter).toBeNull()

    await expect(org.c.workspace.cancelDeletion.mutate()).rejects.toMatchObject({ data: { code: 'PRECONDITION_FAILED' } })
  })

  it('the deletion page is day-scoped (ruling R19): a re-request on a LATER day pages again, the same day does not', async () => {
    const org = await setupOrg()
    // Driven through the service so `now` can move — the dedupe key has to be a function of the day,
    // and a wall-clock test could never tell a day-scoped key from a lifetime one.
    const day1 = new Date('2026-03-01T09:00:00.000Z')
    const day2 = new Date('2026-03-02T09:00:00.000Z')
    let now = day1
    const deps: LifecycleDeps = {
      api: t.api, logger: createAppLogger({ level: 'silent' }), stripe: fake.port, store: t.store,
      enqueue: async (name, data, opts) => { sent.push({ name, data, opts }); return `job-${sent.length}` },
      now: () => now,
    }
    const actor = { userId: org.userId, actor: `user:${org.userId}` as const }
    const notes = () => t.api.withOrg(org.orgId, (tx) => tx.select().from(notifications).where(eq(notifications.orgId, org.orgId)))

    expect(await requestDeletion(deps, org.orgId, 'Acme', actor)).toMatchObject({ ok: true })
    expect((await notes()).map((n) => n.dedupeKey)).toEqual([`workspace:deletion:${org.orgId}:2026-03-01`])
    expect(sent.filter((s) => s.name === JOB_NAMES.notifyDispatch)).toHaveLength(1)

    // Same day, cancelled and asked for again: one decision made twice in an afternoon — one page.
    expect(await cancelDeletion(deps, org.orgId, actor)).toMatchObject({ ok: true })
    expect(await requestDeletion(deps, org.orgId, 'Acme', actor)).toMatchObject({ ok: true })
    expect(await notes()).toHaveLength(1)
    expect(sent.filter((s) => s.name === JOB_NAMES.notifyDispatch)).toHaveLength(1)

    // A LATER day is a fresh decision to destroy the workspace, and must reach a human again.
    expect(await cancelDeletion(deps, org.orgId, actor)).toMatchObject({ ok: true })
    now = day2
    expect(await requestDeletion(deps, org.orgId, 'Acme', actor)).toMatchObject({ ok: true })
    const after = await notes()
    expect(after.map((n) => n.dedupeKey).sort()).toEqual([
      `workspace:deletion:${org.orgId}:2026-03-01`, `workspace:deletion:${org.orgId}:2026-03-02`,
    ])
    const dispatched = sent.filter((s) => s.name === JOB_NAMES.notifyDispatch)
    expect(dispatched).toHaveLength(2)
    expect(dispatched[1]!.data.notificationId).toBe(after.find((n) => n.dedupeKey.endsWith('2026-03-02'))!.id)
  })

  it('workspace.get carries purgeAfter while a deletion is pending', async () => {
    const org = await setupOrg()
    const { purgeAfter } = await org.c.workspace.requestDeletion.mutate({ confirm: 'Acme' })
    const view = await org.c.workspace.get.query()
    expect(view.deletionRequestedAt).toBeInstanceOf(Date)
    expect(view.purgeAfter).toEqual(purgeAfter)
  })

  // -------------------------------------------------------------------------------------------
  // the export
  // -------------------------------------------------------------------------------------------

  it('requestExport queues one export under the contracts key and enqueues workspace.export; a second request while queued is refused (ruling R16); exportStatus presigns only once ready', async () => {
    const org = await setupOrg()
    expect(await org.c.workspace.exportStatus.query()).toEqual({ state: 'none', readyAt: null, url: null })

    const { exportId } = await org.c.workspace.requestExport.mutate()
    expect(exportId).toMatch(/^[0-9a-f-]{36}$/)

    const key = exportObjectKey(org.orgId, exportId)
    const ws = await readWorkspace(org.orgId)
    expect(ws).toMatchObject({ exportState: 'queued', exportKey: key, exportReadyAt: null })
    expect(ws!.exportRequestedAt).toBeInstanceOf(Date)

    expect(sent.filter((s) => s.name === JOB_NAMES.workspaceExport)).toEqual([
      { name: JOB_NAMES.workspaceExport, data: { orgId: org.orgId, exportId }, opts: { entityId: exportId } },
    ])
    expect((await readAudit(org.orgId, 'workspace.export_requested'))[0]!.detail).toEqual({ exportId })

    expect(await org.c.workspace.exportStatus.query()).toEqual({ state: 'queued', readyAt: null, url: null })
    expect((await org.c.workspace.get.query()).exportState).toBe('queued')

    // R16: moving `export_key` under a job that is still queued would make that job fail the OWNER's
    // new request, so a second request is refused while the first is outstanding.
    await expect(org.c.workspace.requestExport.mutate()).rejects.toMatchObject({
      message: WORKSPACE_ERROR_MESSAGES.export_in_progress, data: { code: 'PRECONDITION_FAILED' },
    })
    expect(await readWorkspace(org.orgId)).toMatchObject({ exportKey: key })
    expect(sent.filter((s) => s.name === JOB_NAMES.workspaceExport)).toHaveLength(1)

    // The worker lands `ready`; only then does the owner get a download URL.
    const readyAt = new Date()
    await t.api.withOrg(org.orgId, (tx) => tx.update(workspaces).set({ exportState: 'ready', exportReadyAt: readyAt }).where(eq(workspaces.orgId, org.orgId)))
    const status = await org.c.workspace.exportStatus.query()
    expect(status).toEqual({ state: 'ready', readyAt, url: `memory://${key}` })
    // Exactly seven days — SigV4's own ceiling, and what the worker's "ready" notification promises.
    expect(presigned).toEqual([{ key, expiresSeconds: 7 * 24 * 60 * 60 }])

    // And a finished export no longer blocks the next one.
    const second = await org.c.workspace.requestExport.mutate()
    expect(second.exportId).not.toBe(exportId)
    expect(await readWorkspace(org.orgId)).toMatchObject({
      exportState: 'queued', exportKey: exportObjectKey(org.orgId, second.exportId), exportReadyAt: null,
    })
  })

  it('the export download link is OWNER-only: a member and an admin see the ready state but never a URL', async () => {
    const org = await setupOrg()
    const asMember = await inviteMember(org, 'member')
    const asAdmin = await inviteMember(org, 'admin')

    const { exportId } = await org.c.workspace.requestExport.mutate()
    const key = exportObjectKey(org.orgId, exportId)
    const readyAt = new Date()
    await t.api.withOrg(org.orgId, (tx) => tx.update(workspaces)
      .set({ exportState: 'ready', exportReadyAt: readyAt }).where(eq(workspaces.orgId, org.orgId)))

    // The bundle is not a member-visible subset: `workspace.export` writes the COMPLETE audit log
    // (every colleague's every action, which no member-facing procedure exposes — `activity` gives a
    // count) and the Stripe customer and subscription ids. So the STATE is everyone's and the URL is
    // the owner's, matching `requestExport`'s own rung.
    expect(await asMember.workspace.exportStatus.query()).toEqual({ state: 'ready', readyAt, url: null })
    expect(await asAdmin.workspace.exportStatus.query()).toEqual({ state: 'ready', readyAt, url: null })
    expect(presigned).toEqual([])

    expect(await org.c.workspace.exportStatus.query()).toEqual({ state: 'ready', readyAt, url: `memory://${key}` })
    expect(presigned).toEqual([{ key, expiresSeconds: 7 * 24 * 60 * 60 }])
  })

  it('a failed export can be retried, and exportStatus presigns nothing for it', async () => {
    const org = await setupOrg()
    await org.c.workspace.requestExport.mutate()
    await t.api.withOrg(org.orgId, (tx) => tx.update(workspaces).set({ exportState: 'failed', exportReadyAt: null }).where(eq(workspaces.orgId, org.orgId)))

    expect(await org.c.workspace.exportStatus.query()).toEqual({ state: 'failed', readyAt: null, url: null })
    const retry = await org.c.workspace.requestExport.mutate()
    expect(await readWorkspace(org.orgId)).toMatchObject({ exportState: 'queued', exportKey: exportObjectKey(org.orgId, retry.exportId) })
  })

  it('a null workspace.export job id rolls the claim back to failed and alerts, instead of stranding the workspace queued forever', async () => {
    const org = await setupOrg()
    const lines: string[] = []
    const deps: LifecycleDeps = {
      api: t.api, enqueue: async () => null, stripe: fake.port, store: t.store,
      logger: createAppLogger({ level: 'error', stream: { write: (line: string) => void lines.push(line) } }),
    }
    const actor = { userId: org.userId, actor: `user:${org.userId}` as const }

    const res = await requestExport(deps, org.orgId, actor)
    expect(res).toMatchObject({ ok: true })

    // Without the rollback the row sits `queued` with no job behind it, and R16 then refuses every
    // future export FOREVER — `workspace.export` is the only thing that ever moves the state, so
    // nothing would reset it short of hand-written SQL.
    expect(await readWorkspace(org.orgId)).toMatchObject({ exportState: 'failed', exportReadyAt: null })
    expect(lines.join('')).toContain('"alert":true')
    expect(lines.join('')).toContain('enqueue_returned_null')

    // Which means the owner sees a failure they can simply retry.
    expect(await org.c.workspace.exportStatus.query()).toMatchObject({ state: 'failed', url: null })
    const retry = await org.c.workspace.requestExport.mutate()
    expect(await readWorkspace(org.orgId)).toMatchObject({ exportState: 'queued', exportKey: exportObjectKey(org.orgId, retry.exportId) })
  })

  it('one workspace never sees another\'s lifecycle state', async () => {
    const a = await setupOrg()
    const b = await setupOrg()
    await a.c.workspace.setKillSwitch.mutate({ on: true })
    await a.c.workspace.requestExport.mutate()
    await a.c.workspace.requestDeletion.mutate({ confirm: 'Acme' })

    expect(await b.c.workspace.exportStatus.query()).toEqual({ state: 'none', readyAt: null, url: null })
    const view = await b.c.workspace.get.query()
    expect(view).toMatchObject({ killSwitch: false, deletionRequestedAt: null, purgeAfter: null, exportState: 'none' })
    // The refusals are per-workspace too: b has no pending deletion and no queued export.
    await expect(b.c.workspace.cancelDeletion.mutate()).rejects.toMatchObject({ data: { code: 'PRECONDITION_FAILED' } })
    expect((await b.c.workspace.requestExport.mutate()).exportId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('an unknown id cannot be smuggled in: every lifecycle call reads the org from the session alone', async () => {
    const org = await setupOrg()
    // No procedure here takes an org id — the only thing a caller controls is the confirm string.
    await expect(org.c.workspace.requestDeletion.mutate({ confirm: randomUUID() })).rejects.toMatchObject({ data: { code: 'BAD_REQUEST' } })
    expect(await readWorkspace(org.orgId)).toMatchObject({ deletionRequestedAt: null })
  })
})
