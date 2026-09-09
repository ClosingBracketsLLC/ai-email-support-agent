import { randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_CATEGORIES } from '@aesa/contracts'
import { categories, ensureDefaultCategories, mailboxConnections, messages, notifications, tickets, withOrg } from '../src/index.ts'
import { createDb } from '../src/raw.ts'
import { createTestDatabase, createTestOrganization } from './helpers/test-db.ts'

describe('support schema (agents, categories, tickets, messages, notifications)', () => {
  let t: Awaited<ReturnType<typeof createTestDatabase>>
  let app: ReturnType<typeof createDb>
  let orgId: string
  let connectionId: string

  beforeAll(async () => {
    t = await createTestDatabase()
    app = createDb(t.url)
    orgId = await createTestOrganization(app)
    const usr = await app.pool.query<{ id: string }>(
      `INSERT INTO "user" (name, email) VALUES ($1, $2) RETURNING id`,
      ['Owner', `owner-${randomBytes(4).toString('hex')}@example.com`],
    )
    const userId = usr.rows[0]!.id
    connectionId = await withOrg(app.db, orgId, async (tx) => {
      const [row] = await tx.insert(mailboxConnections).values({
        orgId, provider: 'gmail', providerAccountId: 'acct-1', emailAddress: 'support@acme.com',
        status: 'connected', connectedByUserId: userId,
      }).returning({ id: mailboxConnections.id })
      return row!.id
    })
  })
  afterAll(async () => { await app.pool.end(); await t.drop() })

  it('ensureDefaultCategories seeds 8 rows once and is idempotent', async () => {
    await withOrg(app.db, orgId, (tx) => ensureDefaultCategories(tx))
    const rows1 = await withOrg(app.db, orgId, (tx) => tx.select().from(categories))
    expect(rows1).toHaveLength(8)
    expect(rows1.map((r) => r.key).sort()).toEqual([...DEFAULT_CATEGORIES.map((c) => c.key)].sort())

    // labels are owner-editable; a re-seed must not clobber an edit
    await withOrg(app.db, orgId, (tx) => tx.update(categories).set({ label: 'Edited label' }).where(eq(categories.key, 'other')))

    await withOrg(app.db, orgId, (tx) => ensureDefaultCategories(tx))
    const rows2 = await withOrg(app.db, orgId, (tx) => tx.select().from(categories))
    expect(rows2).toHaveLength(8)
    expect(rows2.find((r) => r.key === 'other')!.label).toBe('Edited label')
  })

  it('tickets: INSERT ... ON CONFLICT (connection_id, provider_thread_id) DO NOTHING RETURNING id', async () => {
    const insertOnce = () =>
      withOrg(app.db, orgId, (tx) =>
        tx.insert(tickets)
          .values({ orgId, connectionId, providerThreadId: 'thread-1' })
          .onConflictDoNothing({ target: [tickets.connectionId, tickets.providerThreadId] })
          .returning({ id: tickets.id }))

    const first = await insertOnce()
    expect(first).toHaveLength(1)

    const second = await insertOnce()
    expect(second).toHaveLength(0)
  })

  it('messages: INSERT ... ON CONFLICT (connection_id, provider_message_id) DO NOTHING RETURNING id', async () => {
    const [ticket] = await withOrg(app.db, orgId, (tx) =>
      tx.insert(tickets).values({ orgId, connectionId, providerThreadId: 'thread-2' }).returning({ id: tickets.id }))

    const insertOnce = () =>
      withOrg(app.db, orgId, (tx) =>
        tx.insert(messages)
          .values({ orgId, ticketId: ticket!.id, connectionId, providerMessageId: 'msg-1', direction: 'inbound' })
          .onConflictDoNothing({ target: [messages.connectionId, messages.providerMessageId] })
          .returning({ id: messages.id }))

    const first = await insertOnce()
    expect(first).toHaveLength(1)

    const second = await insertOnce()
    expect(second).toHaveLength(0)
  })

  it('notifications: dedupe_key unique — second insert with the same key conflicts', async () => {
    const dedupeKey = `dk-${randomBytes(4).toString('hex')}`
    await withOrg(app.db, orgId, (tx) =>
      tx.insert(notifications).values({ orgId, kind: 'escalation', title: 'Escalated', body: 'A ticket needs you', dedupeKey }))

    await expect(
      withOrg(app.db, orgId, (tx) =>
        tx.insert(notifications).values({ orgId, kind: 'escalation', title: 'Escalated again', body: 'body', dedupeKey })),
    ).rejects.toMatchObject({ cause: { code: '23505' } })
  })

  it('RLS smoke: withOrg(orgA) sees zero tickets belonging to orgB', async () => {
    const mkConnection = async (org: string, label: string) => {
      const usr = await app.pool.query<{ id: string }>(
        `INSERT INTO "user" (name, email) VALUES ($1, $2) RETURNING id`,
        [label, `${label}-${randomBytes(4).toString('hex')}@example.com`],
      )
      return withOrg(app.db, org, async (tx) => {
        const [row] = await tx.insert(mailboxConnections).values({
          orgId: org, provider: 'gmail', providerAccountId: `acct-${label}`, emailAddress: `${label}@example.com`,
          status: 'connected', connectedByUserId: usr.rows[0]!.id,
        }).returning({ id: mailboxConnections.id })
        return row!.id
      })
    }

    const orgA = await createTestOrganization(app)
    const orgB = await createTestOrganization(app)
    const connA = await mkConnection(orgA, 'a')
    const connB = await mkConnection(orgB, 'b')

    await withOrg(app.db, orgA, (tx) => tx.insert(tickets).values({ orgId: orgA, connectionId: connA, providerThreadId: 'thread-a' }))
    // inserted via a second, independent withOrg — orgA must never see this row
    await withOrg(app.db, orgB, (tx) => tx.insert(tickets).values({ orgId: orgB, connectionId: connB, providerThreadId: 'thread-b' }))

    const seenFromA = await withOrg(app.db, orgA, (tx) => tx.select().from(tickets))
    expect(seenFromA).toHaveLength(1)
    expect(seenFromA[0]!.orgId).toBe(orgA)
  })
})
