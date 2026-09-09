import { randomUUID } from 'node:crypto'
import { createTRPCClient, httpBatchLink } from '@trpc/client'
import superjson from 'superjson'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { messages, tickets } from '@aesa/db'
import type { AppRouter } from '../src/trpc/router.ts'
import { WEB, createTestApi, insertConnectedMailbox, listen, signInWithOtp } from './helpers/app.ts'

const client = (base: string, cookie?: string) => createTRPCClient<AppRouter>({
  links: [httpBatchLink({ url: `${base}/trpc`, transformer: superjson, headers: () => ({ origin: WEB, ...(cookie ? { cookie } : {}) }) })],
})

describe('inbox router (read-only)', () => {
  let t: Awaited<ReturnType<typeof createTestApi>>
  let base: string
  beforeAll(async () => { t = await createTestApi(); base = await listen(t.app) })
  afterAll(async () => { await t.close() })

  async function insertTicket(orgId: string, connectionId: string, overrides: Partial<typeof tickets.$inferInsert>) {
    const [row] = await t.api.withOrg(orgId, (tx) =>
      tx.insert(tickets).values({ orgId, connectionId, providerThreadId: `thread-${randomUUID()}`, status: 'new', ...overrides }).returning(),
    )
    return row!
  }

  it('routes tickets into the right section by status', async () => {
    const signed = await signInWithOtp(t.app, t.mail, 'owner-sections@example.com', 'Owner')
    const c = client(base, signed.cookie)
    const { orgId } = await c.workspace.create.mutate({ businessName: 'Acme', timezone: 'UTC' })
    const connectionId = await insertConnectedMailbox(t.api, orgId, signed.user.id, 'support@sections.test')
    const now = Date.now()

    const needsOwner = await insertTicket(orgId, connectionId, { status: 'needs_owner', needsOwnerReason: 'tripwire', lastInboundAt: new Date(now) })
    const autoSending = await insertTicket(orgId, connectionId, { status: 'auto_sending', lastInboundAt: new Date(now - 1_000) })
    const fresh = await insertTicket(orgId, connectionId, { status: 'new', lastInboundAt: new Date(now - 2_000) })
    const resolved = await insertTicket(orgId, connectionId, { status: 'resolved', lastInboundAt: new Date(now - 3_000) })
    // A status this phase never surfaces in any of the three sections (Phase 3 adds it to to_review).
    await insertTicket(orgId, connectionId, { status: 'awaiting_review', lastInboundAt: new Date(now - 4_000) })

    const toReview = await c.inbox.list.query({ section: 'to_review' })
    expect(toReview.tickets.map((tk) => tk.id)).toEqual([needsOwner.id])
    expect(toReview.tickets[0]).toMatchObject({ status: 'needs_owner', needsOwnerReason: 'tripwire' })

    const autoSendingSection = await c.inbox.list.query({ section: 'auto_sending' })
    expect(autoSendingSection.tickets.map((tk) => tk.id)).toEqual([autoSending.id])

    const recent = await c.inbox.list.query({ section: 'recent' })
    expect(recent.tickets.map((tk) => tk.id).sort()).toEqual([fresh.id, resolved.id].sort())
  })

  it('keyset-paginates: 25 seeded tickets, limit 20 → nextCursor, second page 5', async () => {
    const signed = await signInWithOtp(t.app, t.mail, 'owner-paginate@example.com', 'Owner')
    const c = client(base, signed.cookie)
    const { orgId } = await c.workspace.create.mutate({ businessName: 'Acme', timezone: 'UTC' })
    const connectionId = await insertConnectedMailbox(t.api, orgId, signed.user.id, 'support@paginate.test')

    const baseTs = Date.parse('2026-01-01T00:00:00Z')
    const created = []
    for (let i = 0; i < 25; i++) {
      created.push(await insertTicket(orgId, connectionId, { status: 'new', lastInboundAt: new Date(baseTs + i * 60_000) }))
    }

    const page1 = await c.inbox.list.query({ section: 'recent', limit: 20 })
    expect(page1.tickets).toHaveLength(20)
    expect(page1.nextCursor).toBeTruthy()
    // Newest (highest lastInboundAt, i === 24) first — DESC order.
    expect(page1.tickets[0]!.id).toBe(created[24]!.id)
    expect(page1.tickets[19]!.id).toBe(created[5]!.id)

    const page2 = await c.inbox.list.query({ section: 'recent', limit: 20, cursor: page1.nextCursor! })
    expect(page2.tickets).toHaveLength(5)
    expect(page2.nextCursor).toBeNull()
    expect(page2.tickets.map((tk) => tk.id)).toEqual(created.slice(0, 5).reverse().map((tk) => tk.id))

    const allIds = new Set([...page1.tickets.map((tk) => tk.id), ...page2.tickets.map((tk) => tk.id)])
    expect(allIds.size).toBe(25)
  })

  it('inbox.ticket returns messages ordered ascending by sentAt; a cross-org id is NOT_FOUND', async () => {
    const signed = await signInWithOtp(t.app, t.mail, 'owner-ticket@example.com', 'Owner')
    const c = client(base, signed.cookie)
    const { orgId } = await c.workspace.create.mutate({ businessName: 'Acme', timezone: 'UTC' })
    const connectionId = await insertConnectedMailbox(t.api, orgId, signed.user.id, 'support@ticket.test')
    const ticket = await insertTicket(orgId, connectionId, {
      status: 'needs_owner', needsOwnerReason: 'tripwire', customerEmail: 'cust@example.com', subject: 'Help',
      lastInboundAt: new Date(), inboundCount: 1,
    })

    const t0 = new Date('2026-01-01T00:00:00Z')
    await t.api.withOrg(orgId, (tx) =>
      tx.insert(messages).values([
        {
          orgId, ticketId: ticket.id, connectionId, providerMessageId: 'm2', direction: 'outbound',
          fromAddress: 'support@ticket.test', toAddresses: ['cust@example.com'], subject: 'Re: Help',
          bodyText: 'second', sentAt: new Date(t0.getTime() + 60_000),
        },
        {
          orgId, ticketId: ticket.id, connectionId, providerMessageId: 'm1', direction: 'inbound',
          fromAddress: 'cust@example.com', toAddresses: ['support@ticket.test'], subject: 'Help',
          bodyText: 'first', sentAt: t0, dmarcPass: true,
        },
      ]),
    )

    const res = await c.inbox.ticket.query({ ticketId: ticket.id })
    expect(res.ticket).toMatchObject({ id: ticket.id, subject: 'Help', customerEmail: 'cust@example.com', status: 'needs_owner' })
    expect(res.messages.map((m) => m.bodyText)).toEqual(['first', 'second'])
    expect(res.messages[0]).toMatchObject({ direction: 'inbound', dmarcPass: true })

    const otherOwner = await signInWithOtp(t.app, t.mail, 'owner-ticket-other@example.com', 'Other')
    const other = client(base, otherOwner.cookie)
    await other.workspace.create.mutate({ businessName: 'Beta', timezone: 'UTC' })
    await expect(other.inbox.ticket.query({ ticketId: ticket.id })).rejects.toMatchObject({ data: { code: 'NOT_FOUND' } })
  })
})
