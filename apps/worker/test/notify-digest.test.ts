/**
 * `runNotifyDigest` against Postgres, with a stub `SendPush` recording calls — no pg-boss
 * involved (`registerNotifyDigest` is thin and untested here). The cross-org `withPlatform` scan
 * means every test's own assertions are scoped to ITS OWN org/notification ids — an earlier test's
 * under-age row is expected to linger as `collapsed` and get re-scanned (and skipped) by every
 * later test in this file; every test shares the same fixed `NOW`, so "under-age relative to NOW"
 * never flips to "due" partway through the file.
 */
import { randomBytes } from 'node:crypto'
import { eq, inArray } from 'drizzle-orm'
import pino from 'pino'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mailboxConnections, notificationDevices, notifications, orgSettings, tickets, user, withOrg } from '@aesa/db'
import { createDb } from '@aesa/db/raw'
import { createTestDatabase, createTestOrganization } from '@aesa/db/testing'
import { runNotifyDigest, type NotifyDigestDeps } from '../src/jobs/notify-digest.ts'
import type { PushMessage, SendPush } from '../src/push.ts'

const rand = () => randomBytes(4).toString('hex')
const NOW = new Date('2026-09-09T12:00:00Z')
const OLD_ENOUGH = new Date(NOW.getTime() - 20 * 60_000) // > default 15-minute digest_minutes
const TOO_RECENT = new Date(NOW.getTime() - 5 * 60_000) // < default 15-minute digest_minutes

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

function createRecordingPush(result: { ok: boolean; invalidTokens: string[] } = { ok: true, invalidTokens: [] }) {
  const calls: PushMessage[] = []
  const send: SendPush = async (msg) => {
    calls.push(msg)
    return result
  }
  return { send, calls }
}

function makeDeps(push: SendPush): NotifyDigestDeps {
  return { db: app.db, push, logger: pino({ level: 'silent' }), now: () => NOW }
}

async function newOrg(): Promise<string> {
  return createTestOrganization(app)
}

async function seedCollapsed(orgId: string, title: string, createdAt: Date, payload: Record<string, unknown> = {}): Promise<string> {
  const [row] = await withOrg(app.db, orgId, (tx) =>
    tx
      .insert(notifications)
      .values({ orgId, kind: 'escalation', title, body: 'b', dedupeKey: `dk-${rand()}`, status: 'collapsed', createdAt, payload })
      .returning({ id: notifications.id }))
  return row!.id
}

async function seedDevice(orgId: string): Promise<string> {
  const token = `ExponentPushToken[${rand()}]`
  await withOrg(app.db, orgId, (tx) => tx.insert(notificationDevices).values({ orgId, userId, expoPushToken: token, platform: 'ios' }))
  return token
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

async function readDeviceByToken(orgId: string, token: string) {
  const [row] = await withOrg(app.db, orgId, (tx) => tx.select().from(notificationDevices).where(eq(notificationDevices.expoPushToken, token)))
  return row
}

async function setDigestMinutes(orgId: string, minutes: number): Promise<void> {
  await withOrg(app.db, orgId, (tx) =>
    tx
      .insert(orgSettings)
      .values({ orgId, key: 'notifications.digest_minutes', value: minutes })
      .onConflictDoUpdate({ target: [orgSettings.orgId, orgSettings.key], set: { value: minutes } }))
}

async function readStatuses(orgId: string, ids: string[]): Promise<string[]> {
  const rows = await withOrg(app.db, orgId, (tx) => tx.select({ status: notifications.status }).from(notifications).where(inArray(notifications.id, ids)))
  return rows.map((r) => r.status)
}

async function readNotification(orgId: string, id: string) {
  const [row] = await withOrg(app.db, orgId, (tx) => tx.select().from(notifications).where(eq(notifications.id, id)))
  return row
}

function callTo(calls: PushMessage[], token: string): PushMessage | undefined {
  return calls.find((c) => c.to.includes(token))
}

describe('notify.digest', () => {
  it('one push per org: 3 collapsed rows across 2 orgs -> one push per org listing titles, all rows sent', async () => {
    const orgA = await newOrg()
    const orgB = await newOrg()
    const tokenA = await seedDevice(orgA)
    const tokenB = await seedDevice(orgB)
    const a1 = await seedCollapsed(orgA, 'A ticket one', OLD_ENOUGH)
    const a2 = await seedCollapsed(orgA, 'A ticket two', OLD_ENOUGH)
    const b1 = await seedCollapsed(orgB, 'B ticket one', OLD_ENOUGH)
    const { send, calls } = createRecordingPush()

    await runNotifyDigest(makeDeps(send))

    const callA = callTo(calls, tokenA)
    const callB = callTo(calls, tokenB)
    expect(callA?.title).toBe('2 updates waiting')
    expect(callA?.body).toContain('A ticket one')
    expect(callA?.body).toContain('A ticket two')
    expect(callB?.title).toBe('1 update waiting')
    expect(callB?.body).toContain('B ticket one')

    expect(await readStatuses(orgA, [a1, a2])).toEqual(['sent', 'sent'])
    expect(await readStatuses(orgB, [b1])).toEqual(['sent'])
  })

  it('under-age rows wait: a collapsed row younger than digest_minutes is neither pushed nor marked sent', async () => {
    const orgId = await newOrg()
    await seedDevice(orgId)
    const id = await seedCollapsed(orgId, 'Too fresh', TOO_RECENT)
    const { send, calls } = createRecordingPush()

    await runNotifyDigest(makeDeps(send))

    expect(calls.filter((c) => c.body.includes('Too fresh'))).toHaveLength(0)
    expect((await readNotification(orgId, id))?.status).toBe('collapsed')
  })

  it("respects a per-org 'notifications.digest_minutes' override", async () => {
    const orgId = await newOrg()
    await setDigestMinutes(orgId, 1) // 1 minute — TOO_RECENT (5 min old) now counts as due
    await seedDevice(orgId)
    const id = await seedCollapsed(orgId, 'Due under a 1-minute setting', TOO_RECENT)
    const { send } = createRecordingPush()

    await runNotifyDigest(makeDeps(send))

    expect((await readNotification(orgId, id))?.status).toBe('sent')
  })

  it('cap-the-rendered-not-the-stamped: only 10 titles are listed, but every collapsed row is marked sent', async () => {
    const orgId = await newOrg()
    await seedDevice(orgId)
    const ids = await Promise.all(Array.from({ length: 12 }, (_, i) => seedCollapsed(orgId, `Ticket ${i}`, OLD_ENOUGH)))
    const { send, calls } = createRecordingPush()

    await runNotifyDigest(makeDeps(send))

    const call = calls.find((c) => c.title === '12 updates waiting')
    expect(call).toBeDefined()
    expect(call!.body.split('\n')).toHaveLength(11) // 10 titles + the overflow line
    expect(call!.body).toContain('…and 2 more')
    expect(await readStatuses(orgId, ids)).toEqual(Array(12).fill('sent'))
  })

  it('no enabled devices: rows are marked sent with no push attempted (nothing to do)', async () => {
    const orgId = await newOrg()
    const id = await seedCollapsed(orgId, 'No one to tell', OLD_ENOUGH)
    const { send, calls } = createRecordingPush()

    await runNotifyDigest(makeDeps(send))

    expect(calls).toHaveLength(0)
    expect((await readNotification(orgId, id))?.status).toBe('sent')
  })

  it('a failed digest push leaves the rows collapsed for the next tick to retry', async () => {
    const orgId = await newOrg()
    await seedDevice(orgId)
    const id = await seedCollapsed(orgId, 'Retry me', OLD_ENOUGH)
    const { send } = createRecordingPush({ ok: false, invalidTokens: [] })

    await runNotifyDigest(makeDeps(send))

    expect((await readNotification(orgId, id))?.status).toBe('collapsed')
  })

  it('an invalid token surfaced by the digest push gets its device row disabled — a second, still-valid device is untouched', async () => {
    const orgId = await newOrg()
    const token = await seedDevice(orgId)
    const stillValidToken = await seedDevice(orgId)
    await seedCollapsed(orgId, 'Dead device', OLD_ENOUGH)
    const { send } = createRecordingPush({ ok: true, invalidTokens: [token] })

    await runNotifyDigest(makeDeps(send))

    const device = await readDeviceByToken(orgId, token)
    expect(device?.disabledAt?.getTime()).toBe(NOW.getTime())
    const stillValid = await readDeviceByToken(orgId, stillValidToken)
    expect(stillValid?.disabledAt).toBeNull()
  })

  it('fix review Finding 2: a collapsed escalation row gets its ticket stamped once the digest actually sends', async () => {
    const orgId = await newOrg()
    await seedDevice(orgId)
    const ticketId = await seedTicket(orgId)
    const id = await seedCollapsed(orgId, 'Escalated while capped', OLD_ENOUGH, { ticketId })
    const { send } = createRecordingPush()

    await runNotifyDigest(makeDeps(send))

    expect((await readNotification(orgId, id))?.status).toBe('sent')
    expect((await readTicket(orgId, ticketId))?.escalationNotifiedAt?.getTime()).toBe(NOW.getTime())
  })

  it('fix review Finding 2: the escalation_notified_at guard (IS NULL) protects an already-stamped ticket from a later digest', async () => {
    const orgId = await newOrg()
    await seedDevice(orgId)
    const stampedAt = new Date('2026-09-09T10:00:00Z')
    const ticketId = await seedTicket(orgId, { escalationNotifiedAt: stampedAt })
    const id = await seedCollapsed(orgId, 'Already stamped', OLD_ENOUGH, { ticketId })
    const { send } = createRecordingPush()

    await runNotifyDigest(makeDeps(send))

    expect((await readNotification(orgId, id))?.status).toBe('sent')
    expect((await readTicket(orgId, ticketId))?.escalationNotifiedAt?.getTime()).toBe(stampedAt.getTime())
  })
})
