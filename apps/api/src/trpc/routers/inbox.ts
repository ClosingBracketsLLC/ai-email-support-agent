/**
 * `inbox.list` / `ticket` — read-only this phase (drafts arrive in Phase 3). Both queries join
 * `categories` and `agents` for display labels only; neither ever exposes anything beyond what the
 * owner's inbox screen needs.
 */
import { TRPCError } from '@trpc/server'
import { and, asc, desc, eq, inArray, lt, sql } from 'drizzle-orm'
import { InboxListInput, TicketIdInput, type InboxSection } from '@aesa/contracts'
import { agents, categories, messages, tickets } from '@aesa/db'
import { orgProcedure, router } from '../init.ts'

// Spec's three sections. `auto_sending` is empty until Phase 5 grants any category auto-send — the
// section exists now so the app's tab layout is stable across phases instead of appearing later.
const SECTION_STATUSES: Record<InboxSection, readonly string[]> = {
  to_review: ['needs_owner'],
  auto_sending: ['auto_sending'],
  recent: ['new', 'triaged', 'waiting_on_customer', 'resolved'],
}

const ticketSummaryColumns = {
  id: tickets.id, subject: tickets.subject, customerEmail: tickets.customerEmail, customerName: tickets.customerName,
  status: tickets.status, needsOwnerReason: tickets.needsOwnerReason, categoryKey: categories.key, categoryLabel: categories.label,
  sentiment: tickets.sentiment, lastInboundAt: tickets.lastInboundAt, inboundCount: tickets.inboundCount,
  agentAddress: agents.address, spamFlagged: tickets.spamFlagged, hasAttachments: tickets.hasAttachments,
}

export const inboxRouter = router({
  list: orgProcedure.input(InboxListInput).query(async ({ ctx, input }) => {
    const cursorDate = input.cursor ? new Date(input.cursor) : null
    const rows = await ctx.deps.api.withOrg(ctx.orgId, (tx) =>
      tx.select(ticketSummaryColumns)
        .from(tickets)
        .leftJoin(categories, eq(categories.id, tickets.categoryId))
        .leftJoin(agents, eq(agents.id, tickets.agentId))
        .where(and(
          eq(tickets.orgId, ctx.orgId),
          inArray(tickets.status, SECTION_STATUSES[input.section]),
          ...(cursorDate ? [lt(tickets.lastInboundAt, cursorDate)] : []),
        ))
        // NULLS LAST (Postgres' DESC default is NULLS FIRST, the opposite of what we want here): a
        // ticket that has never had an inbound message — an owner-initiated thread still awaiting its
        // first reply — sorts after every ticket with a real lastInboundAt. Keyset pagination rides
        // that same column (`InboxListInput.cursor` is a plain ISO datetime, brief's own shape) and so,
        // a known and accepted Phase 2 limitation, cannot resume INTO that null tail once a cursor is
        // in play; only a cursor-less first page can surface those tickets. Real tickets acquire a
        // lastInboundAt as soon as any customer message lands, so this only affects the rare
        // owner-sent-first thread that has had no reply yet.
        .orderBy(sql`${tickets.lastInboundAt} DESC NULLS LAST`, desc(tickets.id))
        .limit(input.limit + 1),
    )

    const hasMore = rows.length > input.limit
    const page = hasMore ? rows.slice(0, input.limit) : rows
    const last = page[page.length - 1]
    const nextCursor = hasMore && last?.lastInboundAt ? last.lastInboundAt.toISOString() : null
    return { tickets: page, nextCursor }
  }),

  ticket: orgProcedure.input(TicketIdInput).query(async ({ ctx, input }) => {
    const result = await ctx.deps.api.withOrg(ctx.orgId, async (tx) => {
      const [row] = await tx.select({
        ...ticketSummaryColumns,
        language: tickets.language, isSpam: tickets.isSpam, isAutomated: tickets.isAutomated, triageQuestions: tickets.triageQuestions,
      })
        .from(tickets)
        .leftJoin(categories, eq(categories.id, tickets.categoryId))
        .leftJoin(agents, eq(agents.id, tickets.agentId))
        .where(and(eq(tickets.orgId, ctx.orgId), eq(tickets.id, input.ticketId)))
      if (!row) return null

      const messageRows = await tx.select({
        id: messages.id, direction: messages.direction, fromAddress: messages.fromAddress, toAddresses: messages.toAddresses,
        subject: messages.subject, bodyText: messages.bodyText, sentAt: messages.sentAt, dmarcPass: messages.dmarcPass, attachments: messages.attachments,
      })
        .from(messages)
        .where(and(eq(messages.orgId, ctx.orgId), eq(messages.ticketId, input.ticketId)))
        .orderBy(asc(messages.sentAt))

      return { ticket: row, messages: messageRows }
    })
    if (!result) throw new TRPCError({ code: 'NOT_FOUND', message: 'ticket not found' })
    return result
  }),
})
