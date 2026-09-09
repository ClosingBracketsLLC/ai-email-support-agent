/**
 * Every database statement the sync walk issues, one exported function each.
 *
 * Two rules hold throughout, both ported from doge-buddy `apps/ops/src/support/ingest.ts`:
 *
 * 1. **Nothing here opens a transaction.** Each function takes an `OrgTx` that `sync.ts` already
 *    owns, so the walk decides what is atomic with what — the reference's IMPORTANT-3 fix, which
 *    made "the message row exists" and "the ticket reflects it" a single fact. It is also what lets
 *    `sync.ts` keep every network fetch OUTSIDE a transaction (the app role's 5 s
 *    idle-in-transaction timeout turns a violation into a loud runtime failure).
 * 2. **One statement where the reference used one statement.** `recordInboundOnTicket` in
 *    particular must stay a single UPDATE: its `spam_flagged` CASE reads the row's PRE-update
 *    `last_inbound_at`, which a second statement would have already moved.
 */
import { and, count, desc, eq, inArray, gte, ne, sql } from 'drizzle-orm'
import { agents, audit, mailboxConnections, messages, tickets, type OrgTx } from '@aesa/db'

export type NewTicket = typeof tickets.$inferInsert
export type NewMessage = typeof messages.$inferInsert

/**
 * Per-sender flood bound (spec §3): once one `customer_email` has opened this many tickets in a UTC
 * day, further NEW threads from that sender fold into their newest existing ticket as messages
 * instead of opening more. An attacker must not be able to starve the triage budget or page the
 * owner at will just by opening threads. Lives here, beside the query that enforces it.
 */
export const MAX_TICKETS_PER_SENDER_PER_DAY = 5

/** Gmail's cursor: a uint64 `historyId` as a decimal string — compared as `numeric`, never as text. */
export interface GmailCursor {
  historyId: string
}
/** Graph's cursor: opaque per-folder delta tokens. Nothing about them is ordered or comparable. */
export interface GraphCursor {
  deltaTokens: Record<string, string>
}

export interface RouteTarget {
  agentId: string
  address: string
}

export interface AgentRow {
  id: string
  address: string
  status: string
  priority: number
  verificationCodeHash: string | null
  /** Non-null while the agent is gated on the connecting user's one-tap consent (spec §2) — a
   * consent-gated agent cannot verify its address by mail alone, even holding a valid code, until
   * that gate clears (`mailboxes.consentAddress`, api-side). */
  consentRequiredFromUserId: string | null
}

export interface TicketRef {
  id: string
  status: string
}

/**
 * The connection's routable agent addresses, in routing order (`priority` ascending, then address —
 * a total order, so two agents sharing a priority still route deterministically).
 *
 * "Active" here means NOT `disabled`: a `pending_verification` agent is still a routing target,
 * because that is exactly how the verification mail addressed to it reaches the interception step
 * (and how ordinary mail to an unverified alias still opens a ticket instead of vanishing).
 * Callers that care about the difference read `status`.
 */
export async function loadActiveAgents(tx: OrgTx, connectionId: string): Promise<AgentRow[]> {
  return tx
    .select({
      id: agents.id,
      address: agents.address,
      status: agents.status,
      priority: agents.priority,
      verificationCodeHash: agents.verificationCodeHash,
      consentRequiredFromUserId: agents.consentRequiredFromUserId,
    })
    .from(agents)
    .where(and(eq(agents.connectionId, connectionId), ne(agents.status, 'disabled')))
    .orderBy(agents.priority, agents.address)
}

export async function findTicketByThread(tx: OrgTx, connectionId: string, providerThreadId: string): Promise<TicketRef | null> {
  const [row] = await tx
    .select({ id: tickets.id, status: tickets.status })
    .from(tickets)
    .where(and(eq(tickets.connectionId, connectionId), eq(tickets.providerThreadId, providerThreadId)))
  return row ?? null
}

/**
 * The RFC 2822 fallback for `findTicketByThread` (ported): every `<…>` token from the message's
 * In-Reply-To + References is looked up against the rfc ids already ingested on this connection.
 *
 * WHY it exists: a provider thread id is NOT a reliable conversation key across the spam boundary —
 * a customer whose first email was junk-foldered gets a brand-new thread id on their inbox
 * follow-up, so thread-keyed lookup alone opens a second ticket for the same conversation. A reply
 * that names a message we already hold belongs to that message's ticket. Newest match wins: a
 * References chain can span several of ours. `rfcIds` is already capped by `tokenizeReferences`, so
 * a hostile 10 KB References header cannot become a 10 KB `IN (...)` list.
 */
export async function findTicketByReferences(tx: OrgTx, connectionId: string, rfcIds: string[]): Promise<TicketRef | null> {
  if (rfcIds.length === 0) return null
  const [row] = await tx
    .select({ id: tickets.id, status: tickets.status })
    .from(messages)
    .innerJoin(tickets, eq(messages.ticketId, tickets.id))
    .where(and(eq(messages.connectionId, connectionId), inArray(messages.rfcMessageId, rfcIds)))
    .orderBy(desc(messages.sentAt))
    .limit(1)
  return row ?? null
}

/**
 * `ON CONFLICT (connection_id, provider_thread_id) DO NOTHING` + re-read — covers a concurrent poll
 * creating the same thread's ticket between our lookup and our insert. `created` tells the caller
 * whether THIS call opened the ticket, which is what gates the post-commit triage enqueue (an
 * addition to the brief's `{ id, status }`: the walk cannot recover the fact any other way, since a
 * losing insert and a pre-existing ticket are indistinguishable from the returned row).
 */
export async function createTicketIfAbsent(tx: OrgTx, row: NewTicket): Promise<TicketRef & { created: boolean }> {
  const [inserted] = await tx
    .insert(tickets)
    .values(row)
    .onConflictDoNothing({ target: [tickets.connectionId, tickets.providerThreadId] })
    .returning({ id: tickets.id, status: tickets.status })
  if (inserted) return { ...inserted, created: true }

  const existing = await findTicketByThread(tx, row.connectionId, row.providerThreadId)
  if (!existing) throw new Error(`ticket for thread ${row.providerThreadId} vanished after conflict`)
  return { ...existing, created: false }
}

/**
 * THE SIDE-EFFECT GATE. No row returned means this provider message was already ingested — by an
 * earlier poll, a crashed run's committed half, or a resync redoing a page — and the caller must do
 * nothing else for it: no reopen, no tripwire, no counter, no callback. Every downstream effect in
 * the walk hangs off this one boolean, which is what makes replay free.
 */
export async function insertMessageGated(tx: OrgTx, row: NewMessage): Promise<{ id: string } | null> {
  const [inserted] = await tx
    .insert(messages)
    .values(row)
    .onConflictDoNothing({ target: [messages.connectionId, messages.providerMessageId] })
    .returning({ id: messages.id })
  return inserted ?? null
}

export interface RecordInboundInput {
  ticketId: string
  sentAt: Date
  /** The provider filed this message under spam/junk. */
  spamFlagged: boolean
  /**
   * The message's DMARC verdict. Recorded on the message row by the caller; kept on this input so
   * the ticket-side bookkeeping call carries the full inbound fact. The DMARC GATES themselves
   * (reopen, flood fold) are the walk's, not this statement's — no column here is conditioned on it.
   */
  dmarcPass: boolean
  hasAttachments: boolean
  /** `detectAutomated` fired on this message's Auto-Submitted / Precedence / List-Id headers. */
  automated: boolean
}

/**
 * Everything a ticket must reflect once an INBOUND message row has been inserted for it, in ONE
 * statement (ported verbatim in shape from the reference):
 *
 * - `last_inbound_at` is `GREATEST`, not assignment: a change feed can hand us an older message
 *   after a newer one (and the resync walks threads in provider order), and "latest customer
 *   contact" must never move backwards. GREATEST ignores NULLs.
 * - `spam_flagged` MOVES IN STEP with it: it describes the message that WINS `last_inbound_at`, so
 *   it only takes this message's folder fact when this message is that latest one. Both columns are
 *   set in the same statement so the CASE reads the row's PRE-update `last_inbound_at` — splitting
 *   this into two statements silently inverts the flag on out-of-order deliveries.
 * - `inbound_count` + 1 and `has_attachments` OR are monotonic: they describe the thread, not the
 *   newest message.
 * - `is_automated` only ever goes to `true` here. It is a triage verdict column (NULL = untriaged);
 *   a header-level automation signal is hard evidence that does not need a model, but its absence
 *   proves nothing, so a non-automated message leaves whatever triage decided untouched.
 */
export async function recordInboundOnTicket(tx: OrgTx, input: RecordInboundInput): Promise<void> {
  const at = input.sentAt.toISOString()
  await tx
    .update(tickets)
    .set({
      lastInboundAt: sql`greatest(${tickets.lastInboundAt}, ${at}::timestamptz)`,
      spamFlagged: sql`case
        when ${at}::timestamptz >= coalesce(${tickets.lastInboundAt}, '-infinity'::timestamptz)
        then ${input.spamFlagged}::boolean
        else ${tickets.spamFlagged}
      end`,
      inboundCount: sql`${tickets.inboundCount} + 1`,
      hasAttachments: sql`${tickets.hasAttachments} or ${input.hasAttachments}::boolean`,
      isAutomated: sql`case when ${input.automated}::boolean then true else ${tickets.isAutomated} end`,
    })
    .where(eq(tickets.id, input.ticketId))
}

/**
 * The guarded reopen. `needs_owner` is the owner's queue and is NEVER auto-reopened; every other
 * non-parked status is already live. Runs BEFORE the tripwire so a reopened ticket carrying
 * escalation-class content still ends up escalated.
 *
 * DMARC-gated per the spec: an unauthenticated message can claim any From, so letting one reopen a
 * closed conversation would hand an attacker a free way to resurrect (and re-page) tickets. The
 * message is still recorded — only the state change is withheld.
 *
 * The budgets reset with the reopen: a new conversation gets its own attempts rather than
 * inheriting a stale count. The redraft-cycle clear is defence in depth — both source states
 * already cleared those columns on entry, but repeating it here makes "a `new` ticket never carries
 * a stale redraft cycle" self-contained instead of transitive through every upstream writer.
 */
export async function reopenIfEligible(tx: OrgTx, ticketId: string, dmarcPass: boolean): Promise<boolean> {
  if (!dmarcPass) return false
  const rows = await tx
    .update(tickets)
    .set({ status: 'new', triageFailureCount: 0, agentFailureCount: 0, ownerRedraftFeedback: null, redraftCount: 0 })
    .where(and(eq(tickets.id, ticketId), inArray(tickets.status, ['resolved', 'waiting_on_customer'])))
    .returning({ id: tickets.id })
  return rows.length > 0
}

/**
 * The deterministic escalation floor's write. Guarded on `status <> 'needs_owner'` so a ticket the
 * owner already holds is not churned, and the boolean it returns is what tells the caller whether
 * to send the (post-commit) notification.
 *
 * `escalation_notified_at` MUST be cleared by every transition INTO `needs_owner`: a ticket that was
 * escalated and notified once, then resolved, then re-escalated by a fresh tripwire hit would
 * otherwise stay permanently invisible to the notifier's `escalation_notified_at IS NULL` selection
 * — the owner is never paged for the reopened case.
 *
 * `needs_owner_reason` is the enum value `'tripwire'` (contracts' NEEDS_OWNER_REASONS); the phrase
 * that actually matched goes to the audit trail, which is the only place a fixed-vocabulary column
 * cannot hold it. The phrase is always one of the baseline/workspace tripwire entries — never
 * customer text — so it is safe to record.
 */
export async function applyTripwire(tx: OrgTx, ticketId: string, keyword: string): Promise<boolean> {
  const rows = await tx
    .update(tickets)
    .set({ status: 'needs_owner', needsOwnerReason: 'tripwire', escalationNotifiedAt: null })
    .where(and(eq(tickets.id, ticketId), ne(tickets.status, 'needs_owner')))
    .returning({ id: tickets.id })
  if (rows.length === 0) return false
  await audit(tx, {
    actor: 'system:mailbox.sync',
    action: 'ticket.tripwire',
    entityType: 'ticket',
    entityId: ticketId,
    detail: { keyword },
  })
  return true
}

/**
 * The flood bound's lookup: null means "create the ticket normally". Non-null is the sender's NEWEST
 * ticket ON THIS CONNECTION, which this message joins instead of opening yet another one — the
 * message itself is never dropped, so the reopen and the tripwire still run on it.
 *
 * The two scopes differ deliberately:
 *
 * - The **count** is organization-wide. A sender who floods two connected mailboxes at once is one
 *   flood, and the bound exists to protect one owner's attention, not one mailbox's.
 * - The **target** is connection-scoped. A ticket carries `connection_id` and its thread belongs to
 *   that mailbox; folding a message that arrived on connection B onto a ticket living on connection
 *   A would leave the ticket holding a message the agent cannot reply into (a reply goes out through
 *   the ticket's own connection and thread). When the sender's newest ticket is on another
 *   connection, this returns null and the caller opens a normal ticket here — still bounded, because
 *   from the sixth ticket onward every further message on THIS connection folds onto it.
 */
export async function findFloodFoldTarget(
  tx: OrgTx,
  connectionId: string,
  now: Date,
  customerEmail: string | null,
): Promise<TicketRef | null> {
  if (!customerEmail) return null

  const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const [today] = await tx
    .select({ value: count() })
    .from(tickets)
    .where(and(eq(tickets.customerEmail, customerEmail), gte(tickets.createdAt, midnight)))
  if ((today?.value ?? 0) < MAX_TICKETS_PER_SENDER_PER_DAY) return null

  const [newest] = await tx
    .select({ id: tickets.id, status: tickets.status })
    .from(tickets)
    .where(and(eq(tickets.customerEmail, customerEmail), eq(tickets.connectionId, connectionId)))
    .orderBy(desc(tickets.createdAt))
    .limit(1)
  return newest ?? null
}

/** The address round-trip succeeded: the agent may now route and reply, and the code is spent. */
export async function consumeVerification(tx: OrgTx, agentId: string): Promise<void> {
  await tx
    .update(agents)
    .set({ status: 'active', verificationCodeHash: null, verificationExpiresAt: null })
    .where(eq(agents.id, agentId))
}

/** Every provider thread this connection already has a ticket for — the resync's step-3 re-walk. */
export async function listTicketThreadIds(tx: OrgTx, connectionId: string): Promise<string[]> {
  const rows = await tx
    .selectDistinct({ providerThreadId: tickets.providerThreadId })
    .from(tickets)
    .where(eq(tickets.connectionId, connectionId))
  return rows.map((r) => r.providerThreadId)
}

/**
 * Stores the walk's new cursor.
 *
 * **gmail** is guarded and forward-only: history ids are uint64 strings, so the comparison is
 * `numeric` (a text compare would rank '9' above '10' and corrupt state) and a NULL cursor always
 * loses to a real one. The guard is defence against a concurrent poll that got further than we did
 * — under a lease it should be unreachable, and it costs one predicate.
 *
 * **graph** replaces unconditionally: delta tokens are opaque and unordered, so there is nothing to
 * compare. The walk only ever produces one at a FULL drain, which is what makes replacement safe.
 */
export async function advanceCursorGuarded(tx: OrgTx, connectionId: string, cursor: GmailCursor | GraphCursor): Promise<void> {
  if ('historyId' in cursor) {
    await tx
      .update(mailboxConnections)
      .set({ cursor })
      .where(
        and(
          eq(mailboxConnections.id, connectionId),
          sql`((${mailboxConnections.cursor} ->> 'historyId') IS NULL OR (${mailboxConnections.cursor} ->> 'historyId')::numeric < ${cursor.historyId}::numeric)`,
        ),
      )
    return
  }
  await tx.update(mailboxConnections).set({ cursor }).where(eq(mailboxConnections.id, connectionId))
}

/** The in-progress bounded resync's bookmark; see `runSync`'s resync path for what it is for. */
export interface ResyncState {
  startedAt: string
  pagesDone: number
}

export async function readConnectionSyncState(
  tx: OrgTx,
  connectionId: string,
): Promise<{ cursor: unknown; resyncState: ResyncState | null } | null> {
  const [row] = await tx
    .select({ cursor: mailboxConnections.cursor, resyncState: mailboxConnections.resyncState })
    .from(mailboxConnections)
    .where(eq(mailboxConnections.id, connectionId))
  if (!row) return null
  return { cursor: row.cursor, resyncState: (row.resyncState as ResyncState | null) ?? null }
}

export async function writeResyncState(tx: OrgTx, connectionId: string, state: ResyncState | null): Promise<void> {
  await tx.update(mailboxConnections).set({ resyncState: state }).where(eq(mailboxConnections.id, connectionId))
}
