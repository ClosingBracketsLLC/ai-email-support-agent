/**
 * `inbox.list` / `ticket` — read-only this phase (drafts arrive in Phase 3). Both queries join
 * `categories` and `agents` for display labels only; neither ever exposes anything beyond what the
 * owner's inbox screen needs.
 */
import { TRPCError } from '@trpc/server'
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
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

/** Strips the internal `sortKey` field `list`'s own selection adds for pagination — never part of
 * the documented `TicketSummary` shape. */
function toSummary<T extends Record<keyof typeof ticketSummaryColumns, unknown>>(row: T): { [K in keyof typeof ticketSummaryColumns]: T[K] } {
  const summary = {} as { [K in keyof typeof ticketSummaryColumns]: T[K] }
  for (const key of Object.keys(ticketSummaryColumns) as (keyof typeof ticketSummaryColumns)[]) summary[key] = row[key]
  return summary
}

// A ticket that has never had an inbound message (an owner-initiated thread still awaiting its first
// reply) has a NULL last_inbound_at. Sorting/cursoring on last_inbound_at alone (review fix,
// Important) meant the ORDER BY needed NULLS LAST *and* the keyset predicate structurally excluded
// every such ticket the moment any cursor was in play (`last_inbound_at < cursor` is never true when
// the left side is NULL — Postgres treats that comparison as UNKNOWN, not "true", so those rows
// silently vanished from every page after the first). Falling back to the NOT NULL `created_at`
// removes the null tail entirely: every ticket sorts on a real timestamp, so plain `<` keyset
// pagination is correct with no special-casing.
// Typed `string`, not `Date`: drizzle only runs a column's driver-value mapping (Postgres text →
// `Date`) for a field tied to a real `Column` object — a raw `sql` expression comes back from
// node-postgres exactly as Postgres formats it as text ('2026-01-01 00:00:00+00'), which `new Date()`
// still parses correctly (verified below, at the one place that needs a real Date out of it).
const sortKey = sql<string>`COALESCE(${tickets.lastInboundAt}, ${tickets.createdAt})`

export const inboxRouter = router({
  list: orgProcedure.input(InboxListInput).query(async ({ ctx, input }) => {
    const cursorDate = input.cursor ? new Date(input.cursor) : null
    const rows = await ctx.deps.api.withOrg(ctx.orgId, (tx) =>
      tx.select({ ...ticketSummaryColumns, sortKey })
        .from(tickets)
        .leftJoin(categories, eq(categories.id, tickets.categoryId))
        .leftJoin(agents, eq(agents.id, tickets.agentId))
        .where(and(
          eq(tickets.orgId, ctx.orgId),
          inArray(tickets.status, SECTION_STATUSES[input.section]),
          ...(cursorDate ? [sql`${sortKey} < ${cursorDate}`] : []),
        ))
        .orderBy(sql`${sortKey} DESC`, desc(tickets.id))
        .limit(input.limit + 1),
    )

    const hasMore = rows.length > input.limit
    const page = hasMore ? rows.slice(0, input.limit) : rows
    const last = page[page.length - 1]
    // `sortKey` is a raw SQL expression, not a plain column reference — drizzle only runs a column's
    // own driver-value mapping (string → Date) for fields tied to a real `Column`, so this comes back
    // from node-postgres as Postgres' own timestamptz text ('2026-01-01 00:00:00+00'), not a `Date`.
    // `new Date(...)` parses that format correctly (verified against Node's Date parser).
    const nextCursor = hasMore && last ? new Date(last.sortKey).toISOString() : null
    return { tickets: page.map(toSummary), nextCursor }
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
