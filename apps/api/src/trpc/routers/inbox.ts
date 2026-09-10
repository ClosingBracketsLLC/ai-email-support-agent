/**
 * `inbox.list` / `ticket` / `resolve`. Both queries join `categories` and `agents` for display labels
 * and LEFT JOIN the ticket's ONE live draft (the partial unique in migration 0011 guarantees at most
 * one), so an inbox row can show its draft chip without a second round-trip. `resolve` is the owner's
 * "I've dealt with this" — it runs through the draft service, which also supersedes that live draft.
 */
import { TRPCError } from '@trpc/server'
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import { InboxListInput, ResolveTicketInput, TicketIdInput, type DraftStatus, type InboxSection } from '@aesa/contracts'
import { agents, categories, drafts, messages, tickets, type OrgTx } from '@aesa/db'
import { LIVE_DRAFT_STATUSES, loadLiveDraftView, resolveTicket } from '../../drafts/service.ts'
import { orgProcedure, router } from '../init.ts'

// Spec's three sections. `auto_sending` is empty until Phase 5 grants any category auto-send — the
// section exists now so the app's tab layout is stable across phases instead of appearing later.
// Phase 3 adds `awaiting_review` (a draft is waiting for a decision) beside `needs_owner`.
const SECTION_STATUSES: Record<InboxSection, readonly string[]> = {
  to_review: ['needs_owner', 'awaiting_review'],
  auto_sending: ['auto_sending'],
  recent: ['new', 'triaged', 'waiting_on_customer', 'resolved'],
}

const ticketSummaryColumns = {
  id: tickets.id, subject: tickets.subject, customerEmail: tickets.customerEmail, customerName: tickets.customerName,
  status: tickets.status, needsOwnerReason: tickets.needsOwnerReason, categoryKey: categories.key, categoryLabel: categories.label,
  sentiment: tickets.sentiment, lastInboundAt: tickets.lastInboundAt, inboundCount: tickets.inboundCount,
  agentAddress: agents.address, spamFlagged: tickets.spamFlagged, hasAttachments: tickets.hasAttachments,
}

/** Just enough of the live draft for a list row's chip; the panel loads the full `DraftView`. */
const draftSummaryColumns = {
  draftId: drafts.id, draftStatus: drafts.status, draftConfidence: drafts.confidence,
  draftDecisionReason: drafts.decisionReason, draftExpiresAt: drafts.expiresAt, draftVersion: drafts.version,
}

export interface TicketDraftSummary {
  id: string
  status: DraftStatus
  confidence: number | null
  decisionReason: string
  expiresAt: Date
  version: number
}

/** The join predicate: the ticket's own org, and only the statuses the one-live-draft unique covers. */
const liveDraftJoin = and(
  eq(drafts.ticketId, tickets.id), eq(drafts.orgId, tickets.orgId), inArray(drafts.status, [...LIVE_DRAFT_STATUSES]),
)!

/** Typed as the nullable union on purpose — these are LEFT JOIN columns, null on a ticket with no live draft. */
interface DraftSummaryRow {
  draftId: string | null
  draftStatus: string | null
  draftConfidence: number | null
  draftDecisionReason: string | null
  draftExpiresAt: Date | null
  draftVersion: number | null
}

function toDraftSummary(row: DraftSummaryRow): TicketDraftSummary | null {
  if (!row.draftId) return null
  return {
    id: row.draftId, status: row.draftStatus as DraftStatus, confidence: row.draftConfidence,
    decisionReason: row.draftDecisionReason!, expiresAt: row.draftExpiresAt!, version: row.draftVersion!,
  }
}

/**
 * The documented inbox row. Spelled out rather than derived from `toSummary`: a generic function's
 * `ReturnType` instantiates its type parameter with the constraint, which turned every field of this
 * alias into `unknown` for `drafts.get`'s `ticket` payload (review Important 3). The row types below
 * are the LEFT JOIN nullable unions, so a concrete drizzle row is always assignable to them.
 */
export interface TicketSummary {
  id: string
  subject: string | null
  customerEmail: string | null
  customerName: string | null
  status: string
  needsOwnerReason: string | null
  categoryKey: string | null
  categoryLabel: string | null
  sentiment: string | null
  lastInboundAt: Date | null
  inboundCount: number
  agentAddress: string | null
  spamFlagged: boolean
  hasAttachments: boolean
  draft: TicketDraftSummary | null
}

interface TicketSummaryRow extends DraftSummaryRow {
  id: string
  subject: string | null
  customerEmail: string | null
  customerName: string | null
  status: string
  needsOwnerReason: string | null
  categoryKey: string | null
  categoryLabel: string | null
  sentiment: string | null
  lastInboundAt: Date | null
  inboundCount: number
  agentAddress: string | null
  spamFlagged: boolean
  hasAttachments: boolean
}

/** Drops whatever else a caller's selection carries (`list` adds an internal `sortKey`) and folds the
 * joined draft columns into one `draft` object. */
function toSummary(row: TicketSummaryRow): TicketSummary {
  return {
    id: row.id, subject: row.subject, customerEmail: row.customerEmail, customerName: row.customerName,
    status: row.status, needsOwnerReason: row.needsOwnerReason, categoryKey: row.categoryKey, categoryLabel: row.categoryLabel,
    sentiment: row.sentiment, lastInboundAt: row.lastInboundAt, inboundCount: row.inboundCount,
    agentAddress: row.agentAddress, spamFlagged: row.spamFlagged, hasAttachments: row.hasAttachments,
    draft: toDraftSummary(row),
  }
}

/**
 * A cursor that passed the input schema but is still not a real instant never reaches drizzle: the
 * page is served WITHOUT it and the response says `degraded`, so the app can say "showing the newest"
 * instead of the client hanging on an error (Phase 2 carry-over). zod's own `.datetime()` already
 * rejects an impossible calendar day; this is the belt on that brace.
 */
export function parseCursor(cursor: string | undefined): { cursorDate: Date | null; degraded: boolean } {
  if (cursor === undefined) return { cursorDate: null, degraded: false }
  const parsed = new Date(cursor)
  return Number.isNaN(parsed.getTime()) ? { cursorDate: null, degraded: true } : { cursorDate: parsed, degraded: false }
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

/** The summary `drafts.get` needs beside its draft — the same shape a list row carries. */
export async function loadTicketSummary(tx: OrgTx, orgId: string, ticketId: string): Promise<TicketSummary | null> {
  const [row] = await tx.select({ ...ticketSummaryColumns, ...draftSummaryColumns })
    .from(tickets)
    .leftJoin(categories, eq(categories.id, tickets.categoryId))
    .leftJoin(agents, eq(agents.id, tickets.agentId))
    .leftJoin(drafts, liveDraftJoin)
    .where(and(eq(tickets.orgId, orgId), eq(tickets.id, ticketId)))
    .limit(1)
  return row ? toSummary(row) : null
}

export const inboxRouter = router({
  list: orgProcedure.input(InboxListInput).query(async ({ ctx, input }) => {
    const { cursorDate, degraded } = parseCursor(input.cursor)
    const rows = await ctx.deps.api.withOrg(ctx.orgId, (tx) =>
      tx.select({ ...ticketSummaryColumns, ...draftSummaryColumns, sortKey })
        .from(tickets)
        .leftJoin(categories, eq(categories.id, tickets.categoryId))
        .leftJoin(agents, eq(agents.id, tickets.agentId))
        .leftJoin(drafts, liveDraftJoin)
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
    return { tickets: page.map(toSummary), nextCursor, degraded }
  }),

  ticket: orgProcedure.input(TicketIdInput).query(async ({ ctx, input }) => {
    const result = await ctx.deps.api.withOrg(ctx.orgId, async (tx) => {
      const [row] = await tx.select({
        ...ticketSummaryColumns, ...draftSummaryColumns,
        language: tickets.language, isSpam: tickets.isSpam, isAutomated: tickets.isAutomated,
        triageQuestions: tickets.triageQuestions, redraftCount: tickets.redraftCount,
      })
        .from(tickets)
        .leftJoin(categories, eq(categories.id, tickets.categoryId))
        .leftJoin(agents, eq(agents.id, tickets.agentId))
        .leftJoin(drafts, liveDraftJoin)
        .where(and(eq(tickets.orgId, ctx.orgId), eq(tickets.id, input.ticketId)))
      if (!row) return null

      const messageRows = await tx.select({
        id: messages.id, direction: messages.direction, fromAddress: messages.fromAddress, toAddresses: messages.toAddresses,
        subject: messages.subject, bodyText: messages.bodyText, sentAt: messages.sentAt, dmarcPass: messages.dmarcPass, attachments: messages.attachments,
      })
        .from(messages)
        .where(and(eq(messages.orgId, ctx.orgId), eq(messages.ticketId, input.ticketId)))
        .orderBy(asc(messages.sentAt))

      // The full draft (body, rationale, guardrail findings, the send and its undo window) — the
      // summary above is only the chip; the review panel opens on this.
      const draft = await loadLiveDraftView(tx, ctx.orgId, input.ticketId, { status: row.status, needsOwnerReason: row.needsOwnerReason })

      const ticket = {
        ...toSummary(row),
        language: row.language, isSpam: row.isSpam, isAutomated: row.isAutomated,
        triageQuestions: row.triageQuestions, redraftCount: row.redraftCount,
      }
      return { ticket, messages: messageRows, draft }
    })
    if (!result) throw new TRPCError({ code: 'NOT_FOUND', message: 'ticket not found' })
    return result
  }),

  /** "Mark resolved". Never throws for a foreign or already-resolved ticket — it simply resolved nothing. */
  resolve: orgProcedure.input(ResolveTicketInput).mutation(async ({ ctx, input }) => {
    const resolved = await resolveTicket(
      { api: ctx.deps.api, enqueue: ctx.deps.enqueue, logger: ctx.deps.logger },
      ctx.orgId,
      input.ticketId,
      { userId: ctx.user.id, actor: ctx.actor, source: 'app', ip: ctx.ip, userAgent: ctx.userAgent },
    )
    return { resolved }
  }),
})
