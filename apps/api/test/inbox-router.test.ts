import { randomUUID } from 'node:crypto'
import { createTRPCClient, httpBatchLink } from '@trpc/client'
import { eq } from 'drizzle-orm'
import superjson from 'superjson'
import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from 'vitest'
import { drafts, messages, outboundSends, tickets, workspaces } from '@aesa/db'
import { loadTicketSummary, parseCursor, type TicketDraftSummary, type TicketSummary } from '../src/trpc/routers/inbox.ts'
import type { AppRouter } from '../src/trpc/router.ts'
import { SEED_DRAFT_BODY, WEB, createTestApi, insertAgent, insertConnectedMailbox, listen, seedPendingDraft, signInWithOtp } from './helpers/app.ts'

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
    // Phase 3: a ticket whose draft is waiting for a decision is `To review` too.
    const awaitingReview = await insertTicket(orgId, connectionId, { status: 'awaiting_review', lastInboundAt: new Date(now - 4_000) })

    const toReview = await c.inbox.list.query({ section: 'to_review' })
    expect(toReview.tickets.map((tk) => tk.id)).toEqual([needsOwner.id, awaitingReview.id])
    expect(toReview.tickets[0]).toMatchObject({ status: 'needs_owner', needsOwnerReason: 'tripwire' })
    expect(toReview.degraded).toBe(false)

    const autoSendingSection = await c.inbox.list.query({ section: 'auto_sending' })
    expect(autoSendingSection.tickets.map((tk) => tk.id)).toEqual([autoSending.id])

    const recent = await c.inbox.list.query({ section: 'recent' })
    expect(recent.tickets.map((tk) => tk.id).sort()).toEqual([fresh.id, resolved.id].sort())
  })

  it('keyset-paginates 25 seeded tickets PLUS one never-replied (NULL last_inbound_at) ticket: limit 20 → nextCursor, second page 6, nothing skipped or duplicated', async () => {
    const signed = await signInWithOtp(t.app, t.mail, 'owner-paginate@example.com', 'Owner')
    const c = client(base, signed.cookie)
    const { orgId } = await c.workspace.create.mutate({ businessName: 'Acme', timezone: 'UTC' })
    const connectionId = await insertConnectedMailbox(t.api, orgId, signed.user.id, 'support@paginate.test')

    const baseTs = Date.parse('2026-01-01T00:00:00Z')
    const created: { id: string; sortKey: number }[] = []
    for (let i = 0; i < 25; i++) {
      const lastInboundAt = new Date(baseTs + i * 60_000)
      const row = await insertTicket(orgId, connectionId, { status: 'new', lastInboundAt })
      created.push({ id: row.id, sortKey: lastInboundAt.getTime() })
    }
    // A never-replied ticket — an owner-initiated thread with no customer reply yet, so
    // last_inbound_at is NULL and the fallback sort key is created_at instead. Placed strictly
    // between i=15 and i=16's timestamps so its rank in the merged 26-item order is predictable
    // and non-trivial (neither first nor last).
    const neverRepliedCreatedAt = new Date(baseTs + 15 * 60_000 + 30_000)
    const neverReplied = await insertTicket(orgId, connectionId, { status: 'new', lastInboundAt: null, createdAt: neverRepliedCreatedAt })
    created.push({ id: neverReplied.id, sortKey: neverRepliedCreatedAt.getTime() })

    const expectedOrder = [...created].sort((a, b) => b.sortKey - a.sortKey).map((row) => row.id)
    expect(expectedOrder).toHaveLength(26)

    const page1 = await c.inbox.list.query({ section: 'recent', limit: 20 })
    expect(page1.tickets).toHaveLength(20)
    expect(page1.nextCursor).toBeTruthy()
    expect(page1.tickets.map((tk) => tk.id)).toEqual(expectedOrder.slice(0, 20))
    expect(page1.tickets.map((tk) => tk.id)).toContain(neverReplied.id)

    const page2 = await c.inbox.list.query({ section: 'recent', limit: 20, cursor: page1.nextCursor! })
    expect(page2.tickets).toHaveLength(6)
    expect(page2.nextCursor).toBeNull()
    expect(page2.tickets.map((tk) => tk.id)).toEqual(expectedOrder.slice(20))

    const allIds = [...page1.tickets.map((tk) => tk.id), ...page2.tickets.map((tk) => tk.id)]
    expect(new Set(allIds).size).toBe(26) // neither skipped nor duplicated across pages
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

  it('to_review carries the live draft summary (and null for a ticket with no draft); inbox.ticket returns the full draft view with undoUntil', async () => {
    const signed = await signInWithOtp(t.app, t.mail, 'owner-drafts@example.com', 'Owner')
    const c = client(base, signed.cookie)
    const { orgId } = await c.workspace.create.mutate({ businessName: 'Acme', timezone: 'UTC' })
    const connectionId = await insertConnectedMailbox(t.api, orgId, signed.user.id, 'support@drafts.test')
    const agentId = await insertAgent(t.api, orgId, connectionId, 'support@drafts.test')
    await t.api.withOrg(orgId, (tx) => tx.update(workspaces).set({ agentEnabled: true }).where(eq(workspaces.orgId, orgId)))
    const now = Date.now()

    const withDraft = await insertTicket(orgId, connectionId, { status: 'awaiting_review', agentId, redraftCount: 1, lastInboundAt: new Date(now) })
    const withoutDraft = await insertTicket(orgId, connectionId, { status: 'needs_owner', needsOwnerReason: 'tripwire', lastInboundAt: new Date(now - 1_000) })
    const draft = await seedPendingDraft(t.api, orgId, withDraft.id, { agentId, viewedAt: new Date() })
    // A decided draft on the same ticket is not the live one — only pending/approved/held/sending join.
    await t.api.withOrg(orgId, (tx) => tx.insert(drafts).values({
      orgId, ticketId: withDraft.id, agentId, version: 2, body: 'older', decision: 'review', decisionReason: 'ok',
      status: 'rejected', threadSnapshotAt: new Date(), expiresAt: new Date(now + 86_400_000),
    }))

    const list = await c.inbox.list.query({ section: 'to_review' })
    expect(list.tickets.map((tk) => tk.id)).toEqual([withDraft.id, withoutDraft.id])
    expect(list.tickets[0]!.draft).toMatchObject({ id: draft.id, status: 'pending', decisionReason: 'ok', version: 1 })
    expect(list.tickets[0]!.draft!.confidence).toBeCloseTo(0.75, 5)
    expect(list.tickets[0]!.draft!.expiresAt).toBeInstanceOf(Date)
    expect(list.tickets[1]!.draft).toBeNull()

    const one = await c.inbox.ticket.query({ ticketId: withDraft.id })
    expect(one.ticket).toMatchObject({ id: withDraft.id, status: 'awaiting_review', redraftCount: 1 })
    expect(one.draft).toMatchObject({ id: draft.id, status: 'pending', body: SEED_DRAFT_BODY, undoUntil: null, send: null })

    const approved = await c.drafts.approve.mutate({ draftId: draft.id })
    const afterApprove = await c.inbox.ticket.query({ ticketId: withDraft.id })
    expect(afterApprove.draft).toMatchObject({ status: 'approved' })
    expect(afterApprove.draft!.undoUntil?.getTime()).toBe(approved.sendAfter.getTime())
    expect(afterApprove.draft!.send).toMatchObject({ id: approved.sendId, status: 'queued' })
    const [send] = await t.api.withOrg(orgId, (tx) => tx.select().from(outboundSends).where(eq(outboundSends.draftId, draft.id)))
    expect(send!.sendAfter.getTime()).toBe(approved.sendAfter.getTime())

    const stillListed = await c.inbox.list.query({ section: 'to_review' })
    expect(stillListed.tickets[0]!.draft).toMatchObject({ id: draft.id, status: 'approved' })
  })

  // Round 2, re-review 2: the failed-draft return path A3 opened was unreachable from the app —
  // `inbox.ticket` served live drafts only, and `failed` is not one, so the "Not sent — … Back to
  // review" banner had nothing to render against.
  it('inbox.ticket falls back to the NEWEST failed draft when no live draft is left, and still prefers a live one', async () => {
    const signed = await signInWithOtp(t.app, t.mail, 'owner-failed-draft@example.com', 'Owner')
    const c = client(base, signed.cookie)
    const { orgId } = await c.workspace.create.mutate({ businessName: 'Acme', timezone: 'UTC' })
    const connectionId = await insertConnectedMailbox(t.api, orgId, signed.user.id, 'support@failed.test')
    const agentId = await insertAgent(t.api, orgId, connectionId, 'support@failed.test')
    const now = Date.now()

    // The state `landTerminal` leaves behind: draft `failed`, its ledger row `failed`, ticket paged.
    const ticket = await insertTicket(orgId, connectionId, {
      status: 'needs_owner', needsOwnerReason: 'send_failed', agentId, lastInboundAt: new Date(now),
    })
    const older = await seedPendingDraft(t.api, orgId, ticket.id, { agentId, status: 'failed' })
    const failed = await seedPendingDraft(t.api, orgId, ticket.id, { agentId, status: 'failed' })
    await t.api.withOrg(orgId, (tx) => tx.update(drafts)
      .set({ decidedAt: new Date(now - 60_000) }).where(eq(drafts.id, older.id)))
    await t.api.withOrg(orgId, (tx) => tx.update(drafts)
      .set({ decidedAt: new Date(now) }).where(eq(drafts.id, failed.id)))
    await t.api.withOrg(orgId, (tx) => tx.insert(outboundSends).values({
      orgId, draftId: failed.id, ticketId: ticket.id, connectionId, agentId,
      status: 'failed', sendAfter: new Date(now), attempts: 3, lastError: 'guardrail:trusted_text_leak',
    }))

    const one = await c.inbox.ticket.query({ ticketId: ticket.id })
    expect(one.draft).toMatchObject({ id: failed.id, status: 'failed', undoUntil: null })
    expect(one.draft!.send).toMatchObject({ status: 'failed', lastError: 'guardrail:trusted_text_leak' })

    // The LIST join stays live-only: a needs_owner/send_failed row carries no draft chip.
    const list = await c.inbox.list.query({ section: 'to_review' })
    expect(list.tickets.find((tk) => tk.id === ticket.id)!.draft).toBeNull()

    // And a live draft always wins: resume it and the fallback stands down.
    expect(await c.drafts.resume.mutate({ draftId: failed.id })).toEqual({ resumed: true })
    const afterResume = await c.inbox.ticket.query({ ticketId: ticket.id })
    expect(afterResume.draft).toMatchObject({ id: failed.id, status: 'pending' })
    expect(afterResume.ticket).toMatchObject({ status: 'awaiting_review' })
  })

  it('a cursor that passes zod but is not a real instant is served WITHOUT the cursor and flagged degraded', async () => {
    // zod 4's own `.datetime()` rejects everything a Date cannot represent (an impossible calendar day
    // included — and V8 would silently ROLL '2026-02-31' over to March rather than refusing it), so
    // `degraded` is the belt on that brace, unit-tested at its source: whatever passes the input
    // schema, `list` never hands drizzle an Invalid Date.
    expect(parseCursor('9999-99-99T99:99:99Z')).toEqual({ cursorDate: null, degraded: true })
    expect(parseCursor(undefined)).toEqual({ cursorDate: null, degraded: false })
    const parsed = parseCursor('2026-01-01T00:00:00.000Z')
    expect(parsed.degraded).toBe(false)
    expect(parsed.cursorDate?.toISOString()).toBe('2026-01-01T00:00:00.000Z')

    const signed = await signInWithOtp(t.app, t.mail, 'owner-degraded@example.com', 'Owner')
    const c = client(base, signed.cookie)
    const { orgId } = await c.workspace.create.mutate({ businessName: 'Acme', timezone: 'UTC' })
    const connectionId = await insertConnectedMailbox(t.api, orgId, signed.user.id, 'support@degraded.test')
    const ticket = await insertTicket(orgId, connectionId, { status: 'new', lastInboundAt: new Date() })

    const res = await c.inbox.list.query({ section: 'recent' })
    expect(res.degraded).toBe(false)
    expect(res.tickets.map((tk) => tk.id)).toEqual([ticket.id])
    await expect(c.inbox.list.query({ section: 'recent', cursor: '2026-02-31T00:00:00Z' })).rejects.toThrow(/Invalid ISO datetime/)
  })

  it('TicketSummary is a concrete type, not a bag of unknown — drafts.get hands it straight to the app', async () => {
    // `export type TicketSummary = ReturnType<typeof toSummary>` on a GENERIC toSummary resolved every
    // field to `unknown` (review Important 3): inbox.list/ticket were fine (T inferred from the real
    // row) but `drafts.get`'s `ticket` payload reached the app untyped. These assertions are checked
    // by `tsc --noEmit` over this file, so the alias cannot silently go back to `unknown`.
    expectTypeOf<TicketSummary['id']>().toEqualTypeOf<string>()
    expectTypeOf<TicketSummary['subject']>().toEqualTypeOf<string | null>()
    expectTypeOf<TicketSummary['status']>().toEqualTypeOf<string>()
    expectTypeOf<TicketSummary['lastInboundAt']>().toEqualTypeOf<Date | null>()
    expectTypeOf<TicketSummary['inboundCount']>().toEqualTypeOf<number>()
    expectTypeOf<TicketSummary['draft']>().toEqualTypeOf<TicketDraftSummary | null>()

    const signed = await signInWithOtp(t.app, t.mail, 'owner-summary@example.com', 'Owner')
    const c = client(base, signed.cookie)
    const { orgId } = await c.workspace.create.mutate({ businessName: 'Acme', timezone: 'UTC' })
    const connectionId = await insertConnectedMailbox(t.api, orgId, signed.user.id, 'support@summary.test')
    const agentId = await insertAgent(t.api, orgId, connectionId, 'support@summary.test')
    const ticket = await insertTicket(orgId, connectionId, { status: 'awaiting_review', agentId, subject: 'Where is my order?' })
    const draft = await seedPendingDraft(t.api, orgId, ticket.id, { agentId, viewedAt: new Date() })

    const summary = await t.api.withOrg(orgId, (tx) => loadTicketSummary(tx, orgId, ticket.id))
    expect(summary).not.toBeNull()
    const subject: string | null = summary!.subject          // compile-time proof: never `unknown`
    const draftStatus: string | undefined = summary!.draft?.status
    expect(subject).toBe('Where is my order?')
    expect(draftStatus).toBe('pending')
    expect(summary!.draft).toMatchObject({ id: draft.id, version: 1 })
    expect(await t.api.withOrg(orgId, (tx) => loadTicketSummary(tx, orgId, randomUUID()))).toBeNull()
  })
})
