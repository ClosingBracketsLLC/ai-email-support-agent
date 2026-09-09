/**
 * `runNotifyDispatch` against Postgres, with a stub `SendPush` recording calls — no pg-boss
 * involved (`registerNotifyDispatch` is thin and untested here, same convention as
 * `registerTicketTriage`). One `it` per numbered rule in the task brief; each test gets its own
 * fresh org so per-day usage_counters rows never leak between tests.
 */
import { randomBytes } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import pino from 'pino'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PUSH_DAILY_CAP } from '@aesa/contracts'
import { mailboxConnections, notificationDevices, notifications, tickets, usageCounters, user, withOrg } from '@aesa/db'
import { createDb } from '@aesa/db/raw'
import { createTestDatabase, createTestOrganization } from '@aesa/db/testing'
import { runNotifyDispatch, type NotifyDispatchDeps } from '../src/jobs/notify-dispatch.ts'
import type { PushMessage, SendPush } from '../src/push.ts'

const rand = () => randomBytes(4).toString('hex')
const NOW = new Date('2026-09-09T12:00:00Z')
const TODAY = '2026-09-09'

let t: Awaited<ReturnType<typeof createTestDatabase>>
let app: ReturnType<typeof createDb>
let userId: string

beforeAll(async () => {
  t = await createTestDatabase()
  app = createDb(t.url)
  const [u] = await app.db.insert(user).values({ name: 'Owner', email: `owner-${rand()}@example.com` }).returning()
  userId = u!.id
})
afterAll(async () => {
  await app.pool.end()
  await t.drop()
})

function createStubPush(result: { ok: boolean; invalidTokens: string[] } = { ok: true, invalidTokens: [] }) {
  const calls: PushMessage[] = []
  const send: SendPush = async (msg) => {
    calls.push(msg)
    return result
  }
  return { send, calls }
}

function makeDeps(push: SendPush, db: ReturnType<typeof createDb>['db'] = app.db): NotifyDispatchDeps {
  return { db, push, logger: pino({ level: 'silent' }), now: () => NOW }
}

async function newOrg(): Promise<string> {
  return createTestOrganization(app)
}

async function seedNotification(orgId: string, overrides: Partial<typeof notifications.$inferInsert> = {}): Promise<string> {
  const [row] = await withOrg(app.db, orgId, (tx) =>
    tx
      .insert(notifications)
      .values({ orgId, kind: 'mailbox_reauth', title: 'Reconnect your mailbox', body: 'Body text', dedupeKey: `dk-${rand()}`, ...overrides })
      .returning({ id: notifications.id }))
  return row!.id
}

async function seedDevice(orgId: string, overrides: Partial<typeof notificationDevices.$inferInsert> = {}): Promise<{ id: string; expoPushToken: string }> {
  const token = overrides.expoPushToken ?? `ExponentPushToken[${rand()}]`
  const [row] = await withOrg(app.db, orgId, (tx) =>
    tx
      .insert(notificationDevices)
      .values({ orgId, userId, expoPushToken: token, platform: 'ios', ...overrides })
      .returning({ id: notificationDevices.id, expoPushToken: notificationDevices.expoPushToken }))
  return row!
}

async function readNotification(orgId: string, id: string) {
  const [row] = await withOrg(app.db, orgId, (tx) => tx.select().from(notifications).where(eq(notifications.id, id)))
  return row
}

async function readDevice(orgId: string, id: string) {
  const [row] = await withOrg(app.db, orgId, (tx) => tx.select().from(notificationDevices).where(eq(notificationDevices.id, id)))
  return row
}

async function readMeter(orgId: string, day: string, meter: string): Promise<number> {
  const [row] = await withOrg(app.db, orgId, (tx) =>
    tx.select({ value: usageCounters.value }).from(usageCounters).where(and(eq(usageCounters.day, day), eq(usageCounters.meter, meter))))
  return row?.value ?? 0
}

async function setMeter(orgId: string, day: string, meter: string, value: number): Promise<void> {
  await withOrg(app.db, orgId, (tx) =>
    tx
      .insert(usageCounters)
      .values({ orgId, day, meter, value })
      .onConflictDoUpdate({ target: [usageCounters.orgId, usageCounters.day, usageCounters.meter], set: { value } }))
}

async function seedTicket(orgId: string, overrides: Partial<typeof tickets.$inferInsert> = {}): Promise<string> {
  const connectionId = await withOrg(app.db, orgId, async (tx) => {
    const [row] = await tx
      .insert(mailboxConnections)
      .values({ orgId, provider: 'gmail', providerAccountId: `acct-${rand()}`, emailAddress: `support-${rand()}@acme.test`, status: 'connected', connectedByUserId: userId })
      .returning({ id: mailboxConnections.id })
    return row!.id
  })
  const [ticket] = await withOrg(app.db, orgId, (tx) =>
    tx.insert(tickets).values({ orgId, connectionId, providerThreadId: `thread-${rand()}`, status: 'needs_owner', needsOwnerReason: 'triage_flags', ...overrides }).returning({ id: tickets.id }))
  return ticket!.id
}

async function readTicket(orgId: string, id: string) {
  const [row] = await withOrg(app.db, orgId, (tx) => tx.select().from(tickets).where(eq(tickets.id, id)))
  return row
}

describe('notify.dispatch', () => {
  it('rule 4 (ok path): pending -> sent, meter incremented, push seam receives the devices/title/body/payload', async () => {
    const orgId = await newOrg()
    const device = await seedDevice(orgId)
    const notificationId = await seedNotification(orgId, { title: 'Ticket flagged', body: 'Needs attention', payload: { ticketId: 'abc' } })
    const { send, calls } = createStubPush({ ok: true, invalidTokens: [] })

    await runNotifyDispatch(makeDeps(send), { orgId, notificationId })

    const after = await readNotification(orgId, notificationId)
    expect(after?.status).toBe('sent')
    expect(after?.sentAt?.getTime()).toBe(NOW.getTime())
    expect(await readMeter(orgId, TODAY, 'push_sent')).toBe(1)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual({ to: [device.expoPushToken], title: 'Ticket flagged', body: 'Needs attention', data: { ticketId: 'abc' } })
  })

  it('rule 1: a notification not pending is a no-op (idempotent re-delivery) — no push, no meter change', async () => {
    const orgId = await newOrg()
    await seedDevice(orgId)
    const notificationId = await seedNotification(orgId, { status: 'sent' })
    const { send, calls } = createStubPush()

    await runNotifyDispatch(makeDeps(send), { orgId, notificationId })

    expect(calls).toHaveLength(0)
    expect(await readMeter(orgId, TODAY, 'push_sent')).toBe(0)
  })

  it('rule 2: the daily cap collapses the notification without ever calling push', async () => {
    const orgId = await newOrg()
    await seedDevice(orgId)
    const notificationId = await seedNotification(orgId)
    await setMeter(orgId, TODAY, 'push_sent', PUSH_DAILY_CAP)
    const { send, calls } = createStubPush()

    await runNotifyDispatch(makeDeps(send), { orgId, notificationId })

    const after = await readNotification(orgId, notificationId)
    expect(after?.status).toBe('collapsed')
    expect(calls).toHaveLength(0)
  })

  it('rule 3: no enabled devices -> sent, nothing to do (not an error, no push)', async () => {
    const orgId = await newOrg()
    const notificationId = await seedNotification(orgId)
    const { send, calls } = createStubPush()

    await runNotifyDispatch(makeDeps(send), { orgId, notificationId })

    const after = await readNotification(orgId, notificationId)
    expect(after?.status).toBe('sent')
    expect(calls).toHaveLength(0)
  })

  it('rule 3: a disabled device is excluded from the fan-out list (only enabled devices count)', async () => {
    const orgId = await newOrg()
    await seedDevice(orgId, { disabledAt: NOW })
    const notificationId = await seedNotification(orgId)
    const { send, calls } = createStubPush()

    await runNotifyDispatch(makeDeps(send), { orgId, notificationId })

    expect((await readNotification(orgId, notificationId))?.status).toBe('sent')
    expect(calls).toHaveLength(0)
  })

  it('rule 4 (invalid token): a DeviceNotRegistered token gets disabled_at stamped on its device row — a second, still-valid device is untouched', async () => {
    const orgId = await newOrg()
    const device = await seedDevice(orgId)
    const stillValid = await seedDevice(orgId)
    const notificationId = await seedNotification(orgId)
    const { send } = createStubPush({ ok: true, invalidTokens: [device.expoPushToken] })

    await runNotifyDispatch(makeDeps(send), { orgId, notificationId })

    const after = await readDevice(orgId, device.id)
    expect(after?.disabledAt?.getTime()).toBe(NOW.getTime())
    const untouched = await readDevice(orgId, stillValid.id)
    expect(untouched?.disabledAt).toBeNull()
    expect((await readNotification(orgId, notificationId))?.status).toBe('sent')
  })

  it('rule 2 (cap boundary): at PUSH_DAILY_CAP - 1, the push still goes through (an off-by-one would collapse it)', async () => {
    const orgId = await newOrg()
    await seedDevice(orgId)
    const notificationId = await seedNotification(orgId)
    await setMeter(orgId, TODAY, 'push_sent', PUSH_DAILY_CAP - 1)
    const { send, calls } = createStubPush({ ok: true, invalidTokens: [] })

    await runNotifyDispatch(makeDeps(send), { orgId, notificationId })

    expect(calls).toHaveLength(1)
    expect((await readNotification(orgId, notificationId))?.status).toBe('sent')
    expect(await readMeter(orgId, TODAY, 'push_sent')).toBe(PUSH_DAILY_CAP)
  })

  it('rule 4 (push failure): !ok -> status failed, terminal — meter is not incremented', async () => {
    const orgId = await newOrg()
    await seedDevice(orgId)
    const notificationId = await seedNotification(orgId)
    const { send } = createStubPush({ ok: false, invalidTokens: [] })

    await runNotifyDispatch(makeDeps(send), { orgId, notificationId })

    expect((await readNotification(orgId, notificationId))?.status).toBe('failed')
    expect(await readMeter(orgId, TODAY, 'push_sent')).toBe(0)
  })

  it("rule 5: an 'escalation' notification stamps the ticket's escalation_notified_at exactly once", async () => {
    const orgId = await newOrg()
    await seedDevice(orgId)
    const ticketId = await seedTicket(orgId)
    const notificationId = await seedNotification(orgId, { kind: 'escalation', payload: { ticketId } })
    const { send, calls } = createStubPush({ ok: true, invalidTokens: [] })

    await runNotifyDispatch(makeDeps(send), { orgId, notificationId })

    const ticketAfterFirst = await readTicket(orgId, ticketId)
    expect(ticketAfterFirst?.escalationNotifiedAt?.getTime()).toBe(NOW.getTime())
    expect(calls).toHaveLength(1)

    // Second dispatch of the SAME notification: status is now 'sent', so rule 1 makes this a
    // total no-op — no second push, and the stamp is untouched (not re-set to a later `now`).
    const LATER = new Date(NOW.getTime() + 60_000)
    await runNotifyDispatch({ ...makeDeps(send), now: () => LATER }, { orgId, notificationId })

    expect(calls).toHaveLength(1)
    const ticketAfterSecond = await readTicket(orgId, ticketId)
    expect(ticketAfterSecond?.escalationNotifiedAt?.getTime()).toBe(NOW.getTime())
  })

  it('rule 5: the escalation_notified_at guard (IS NULL) also protects a SECOND notification for an already-stamped ticket', async () => {
    const orgId = await newOrg()
    await seedDevice(orgId)
    const ticketId = await seedTicket(orgId)
    const firstNotificationId = await seedNotification(orgId, { kind: 'escalation', payload: { ticketId } })
    const { send } = createStubPush({ ok: true, invalidTokens: [] })
    await runNotifyDispatch(makeDeps(send), { orgId, notificationId: firstNotificationId })
    const stampedAt = (await readTicket(orgId, ticketId))?.escalationNotifiedAt?.getTime()

    const LATER = new Date(NOW.getTime() + 60_000)
    const secondNotificationId = await seedNotification(orgId, { kind: 'escalation', payload: { ticketId } })
    await runNotifyDispatch({ ...makeDeps(send), now: () => LATER }, { orgId, notificationId: secondNotificationId })

    expect((await readTicket(orgId, ticketId))?.escalationNotifiedAt?.getTime()).toBe(stampedAt)
  })

  it('fix review Finding 1: the escalation stamp commits in the SAME tx as the status flip — a failing stamp rolls back the whole write', async () => {
    const orgId = await newOrg()
    await seedDevice(orgId)
    // `tickets.id` is a uuid column; a non-uuid payload.ticketId makes the stamp's UPDATE fail at
    // the database level ("invalid input syntax for type uuid"), which — now that the stamp runs
    // inside the SAME withOrg tx as the 'sent' write (Finding 1's fix) — rolls back that entire
    // transaction: the notification must stay 'pending', not commit as 'sent' with no stamp.
    const notificationId = await seedNotification(orgId, { kind: 'escalation', payload: { ticketId: 'not-a-uuid' } })
    const { send, calls } = createStubPush({ ok: true, invalidTokens: [] })

    await expect(runNotifyDispatch(makeDeps(send), { orgId, notificationId })).rejects.toThrow()

    expect(calls).toHaveLength(1) // the push itself (outside any tx) still happened
    const after = await readNotification(orgId, notificationId)
    expect(after?.status).toBe('pending') // NOT 'sent' — the whole write rolled back together
    expect(after?.sentAt).toBeNull()
    expect(await readMeter(orgId, TODAY, 'push_sent')).toBe(0)
  })
})
