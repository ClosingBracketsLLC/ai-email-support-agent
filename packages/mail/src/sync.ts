/**
 * The provider-agnostic sync walk: one poll of one mailbox connection, turning a provider change
 * feed into tickets and messages. Ported from doge-buddy `apps/ops/src/support/ingest.ts`
 * (`runIngest` / `runResync` / `ingestMessageId`), generalized off Gmail onto the `MailboxClient`
 * port and onto multi-agent address routing.
 *
 * Three invariants shape everything below.
 *
 * **The insert IS the side-effect gate.** `INSERT … ON CONFLICT (connection_id,
 * provider_message_id) DO NOTHING RETURNING id` returning no row means this message was already
 * ingested, and NOTHING else runs for it: no reopen, no tripwire, no counter, no callback. That one
 * fact is what makes a crashed run, a re-delivered push and a resync's redone page all free — the
 * walk is idempotent by construction rather than by bookkeeping.
 *
 * **Bodies are read only for mail we are allowed to read.** Every message is fetched with
 * `format: 'metadata'` first. The full fetch happens ONLY when the message is addressed to an
 * agent on this connection, or already belongs to a ticket we hold. Mail to the mailbox that
 * matches neither is never fetched in full — a product privacy rule, not an optimization.
 *
 * **No network I/O inside a transaction.** Every fetch happens between transactions, never inside
 * one; the app role's 5 s idle-in-transaction timeout turns a violation into a loud failure. One
 * short `withOrg` transaction per message makes "the message row exists" and "the ticket reflects
 * it" a single fact (the reference's IMPORTANT-3 fix: a crash between the two used to lose an
 * escalation permanently, since replay sees the message as already seen).
 */
import { tripwireHit } from '@aesa/core'
import { hashToken, hashesEqual } from '@aesa/crypto'
import { audit, withOrg, type Db } from '@aesa/db'
import { detectAutomated, parseAuthResults } from './auth-results.ts'
import { CursorExpiredError, isMessageGone } from './errors.ts'
import {
  advanceCursorGuarded,
  applyTripwire,
  consumeVerification,
  createTicketIfAbsent,
  findFloodFoldTarget,
  findTicketByReferences,
  findTicketByThread,
  insertMessageGated,
  listTicketThreadIds,
  loadActiveAgents,
  readConnectionSyncState,
  recordInboundOnTicket,
  reopenIfEligible,
  writeResyncState,
  type AgentRow,
  type GmailCursor,
  type GraphCursor,
  type ResyncState,
  type TicketRef,
} from './store.ts'
import { REFERENCES_CAP, tokenizeReferences } from './threading.ts'
import type { ChangeRecord, MailboxClient, NormalizedMessage } from './types.ts'

/** How far back the bounded resync sweeps the mailbox when a cursor has aged out. */
export const RESYNC_WINDOW_DAYS = 30

/** Provider-agnostic label names. Gmail stamps 'SPAM'; the Graph adapter maps Junk Email → 'JUNK'. */
const SPAM_LABELS = new Set(['SPAM', 'JUNK'])
/** A provider autosaves a new DRAFT id per revision, and TRASH is deleted mail. Neither is an event. */
const SKIP_LABELS = ['DRAFT', 'TRASH']
/** The address-verification code the platform mails to an alias (see `interceptVerification`). */
const VERIFICATION_CODE_RE = /\b(\d{6})\b/

export interface SyncDeps {
  db: Db
  client: MailboxClient
  orgId: string
  connectionId: string
  provider: 'gmail' | 'microsoft'
  /** The connected mailbox's own address. Never used for direction — see step 5. */
  selfAddress: string
  /** MAIL_FROM: the only sender an address-verification code is ever honoured from. */
  platformSender: string
  tripwireExtras: readonly string[]
  /**
   * Post-commit, gated on the insert: the worker enqueues `ticket.triage`.
   *
   * These two callbacks are the SOLE delivery mechanism — `SyncResult`'s arrays report what the walk
   * decided, they do not re-deliver it, so a caller that acts on both double-enqueues. A callback
   * that throws is caught and logged rather than allowed to abort the walk (one bad enqueue must not
   * cost every later message in the batch its effects); the poll sweep's stuck-`new` re-enqueue is
   * the reconciliation net for the delivery that was lost.
   */
  onNewInboundTicket(ticketId: string): void
  /** Post-commit, gated on the insert: the worker writes the escalation notification. Same
   * delivery and failure contract as `onNewInboundTicket`. */
  onTripwire(ticketId: string): void
  now?: () => Date
  log?: (level: 'info' | 'warn', msg: string, ctx?: Record<string, unknown>) => void
}

/**
 * REPORTING ONLY. Every array below records what this run decided, for logging, tests and health
 * metrics; the work itself was already delivered through `SyncDeps`' callbacks. Acting on these as
 * if they were a work queue enqueues everything twice. An id stays reported even when its callback
 * threw — the walk determined the ticket needs triage, and the failure is in the log, not here.
 */
export interface SyncResult {
  /** Message rows this run actually inserted (both directions) — re-seen messages never count. */
  insertedMessages: number
  /** Tickets this run handed to `onNewInboundTicket`, in call order. */
  newInboundTicketIds: string[]
  /** Tickets this run's tripwire actually flipped to `needs_owner`. */
  tripwiredTicketIds: string[]
  /** The incremental cursor had expired and this run fell back to the bounded resync. */
  resynced: boolean
}

interface SyncContext {
  deps: SyncDeps
  now: () => Date
  log: NonNullable<SyncDeps['log']>
  /** Lowercased once; `NormalizedMessage` addresses are already lowercase addr-specs. */
  platformSender: string
  /** This connection's routable agents, in routing order. Mutated in place by verification. */
  agents: AgentRow[]
  result: SyncResult
  newInboundTicketIds: Set<string>
}

/** What one message's transaction committed — enough to fire the post-commit callbacks correctly. */
interface MessageOutcome {
  ticketId: string
  inserted: boolean
  direction: 'inbound' | 'outbound'
  /** THIS call opened the ticket. */
  created: boolean
  reopened: boolean
  tripwired: boolean
  /** The ticket's status as it stood before this message's bookkeeping. */
  priorStatus: string
}

/**
 * One incremental poll of one connection. `CursorExpiredError` from the change walk is caught and
 * answered with the bounded resync; every other error propagates to the job, which owns the
 * backoff.
 */
export async function runSync(deps: SyncDeps): Promise<SyncResult> {
  const now = deps.now ?? (() => new Date())
  const log = deps.log ?? (() => {})
  const result: SyncResult = { insertedMessages: 0, newInboundTicketIds: [], tripwiredTicketIds: [], resynced: false }

  const loaded = await withOrg(deps.db, deps.orgId, async (tx) => ({
    state: await readConnectionSyncState(tx, deps.connectionId),
    agents: await loadActiveAgents(tx, deps.connectionId),
  }))
  if (!loaded.state) throw new Error(`mailbox connection ${deps.connectionId} not found for org ${deps.orgId}`)

  const ctx: SyncContext = {
    deps,
    now,
    log,
    platformSender: deps.platformSender.toLowerCase(),
    agents: loaded.agents,
    result,
    newInboundTicketIds: new Set(),
  }

  // Step 1: seed-on-null. A fresh mailbox ingests nothing — it only remembers where to start, so
  // connecting a decade-old inbox does not import a decade of mail.
  if (loaded.state.cursor == null) {
    const profile = await deps.client.profile()
    await storeCursor(ctx, profile.cursor, 'seed')
    return finish(ctx)
  }

  try {
    // Step 2: drain EVERY change page before processing any of it. A cursor expiry on page three
    // must not leave a half-applied batch behind — with nothing applied yet there is nothing to
    // unwind, and the resync can start from a clean slate.
    const records: ChangeRecord[] = []
    let drainedCursor: unknown
    let pageToken: string | undefined
    do {
      const page = await deps.client.listChanges(loaded.state.cursor, pageToken)
      records.push(...page.records)
      if (page.newCursor !== undefined) drainedCursor = page.newCursor
      pageToken = page.nextPageToken
    } while (pageToken)

    // A message id can appear in several change records (a label edit after the add); dedupe so the
    // per-message path runs once per poll rather than once per mention.
    const seen = new Set<string>()
    for (const record of records) {
      for (const message of record.messageIds) {
        if (seen.has(message.id)) continue
        seen.add(message.id)
        await ingestMessageId(ctx, message.id)
      }
    }

    await advanceAfterWalk(ctx, records, drainedCursor)
  } catch (err) {
    if (!(err instanceof CursorExpiredError)) throw err
    await runResync(ctx, loaded.state.resyncState)
    result.resynced = true
  }

  return finish(ctx)
}

function finish(ctx: SyncContext): SyncResult {
  ctx.result.newInboundTicketIds = [...ctx.newInboundTicketIds]
  return ctx.result
}

/**
 * Step 8, and only after this batch's writes have committed.
 *
 * gmail advances to the maximum history-RECORD id, compared as BigInt: history ids are uint64
 * decimal strings, so a lexicographic max ('9' > '10') silently rewinds the cursor and re-ingests
 * (or, worse, skips) whole ranges. graph has nothing to compare — it stores the delta cursor the
 * drain produced, which only exists once every page has been served.
 */
async function advanceAfterWalk(ctx: SyncContext, records: ChangeRecord[], drainedCursor: unknown): Promise<void> {
  if (ctx.deps.provider === 'gmail') {
    let max: bigint | null = null
    for (const record of records) {
      let id: bigint
      try {
        id = BigInt(record.id)
      } catch {
        ctx.log('warn', 'mailbox.sync_bad_change_id', { changeId: record.id })
        continue
      }
      if (max === null || id > max) max = id
    }
    if (max === null) return // an empty feed leaves the cursor exactly where it was
    await storeCursor(ctx, { historyId: max.toString() }, 'walk')
    return
  }

  if (drainedCursor === undefined) return
  await storeCursor(ctx, drainedCursor, 'walk')
}

async function storeCursor(ctx: SyncContext, raw: unknown, phase: 'seed' | 'walk'): Promise<void> {
  const cursor = normalizeCursor(ctx.deps.provider, raw)
  if (!cursor) {
    ctx.log('warn', 'mailbox.sync_unusable_cursor', { phase, provider: ctx.deps.provider })
    return
  }
  await withOrg(ctx.deps.db, ctx.deps.orgId, (tx) => advanceCursorGuarded(tx, ctx.deps.connectionId, cursor))
}

/** The port hands cursors back as `unknown`; this is the one place their shape is asserted. */
function normalizeCursor(provider: 'gmail' | 'microsoft', value: unknown): GmailCursor | GraphCursor | null {
  if (typeof value !== 'object' || value === null) return null

  if (provider === 'gmail') {
    const { historyId } = value as { historyId?: unknown }
    // Guarded as `numeric` in SQL, so a non-decimal id would make the predicate raise rather than
    // simply not match — reject it here instead.
    return typeof historyId === 'string' && /^\d+$/.test(historyId) ? { historyId } : null
  }

  const { deltaTokens } = value as { deltaTokens?: unknown }
  if (typeof deltaTokens !== 'object' || deltaTokens === null) return null
  const tokens: Record<string, string> = {}
  for (const [folder, token] of Object.entries(deltaTokens)) {
    if (typeof token === 'string') tokens[folder] = token
  }
  return { deltaTokens: tokens }
}

/**
 * The bounded, resumable resync. A change feed 404s once its start cursor has aged out of the
 * provider's retention window — there is no incremental diff left to recover, so this rebuilds from
 * a scoped mailbox scan instead: agent-addressed mail in the last `RESYNC_WINDOW_DAYS`, plus every
 * already-known ticket thread (for follow-ups that dropped every agent address from their headers).
 *
 * The ORDERING is load-bearing, and each step is durable before the next begins:
 *
 * 1. Capture `profile()`'s fresh cursor FIRST, before touching the database at all. Anything that
 *    lands in the mailbox from this instant on is still covered by the NEXT poll's incremental walk
 *    starting from this cursor — the resync only has to account for what happened before it.
 * 2. Page through the address window, each page's ids running through the SAME per-message path as
 *    the incremental walk. The insert gate is what makes a redone page free: a message already
 *    ingested (including by a previous, interrupted resync attempt) is a no-op, never a reopen.
 *    Each page's writes are durable before the next page is even requested.
 * 3. Then every already-known ticket thread's live messages. The address window cannot see a
 *    follow-up that dropped every agent address, but its thread is already ours. A per-thread
 *    failure (a thread the owner deleted outright, 404ing) is caught PER THREAD and skipped —
 *    never allowed to fail the resync. An uncaught throw here is a poison pill: step 4 would never
 *    run, so every subsequent poll would expire again, re-enter this resync, and die on the same
 *    dead thread forever.
 * 4. Only THEN store the pre-captured cursor. Storing last is what makes step 1's early capture
 *    safe: an interrupted resync stores nothing, so the next poll either expires again (and redoes
 *    the bounded scan, freely) or resumes incrementally — either way nothing already committed
 *    gets a side effect twice.
 *
 * `resync_state` is the progress bookmark, written after every page and cleared at the end: it
 * records which attempt is in flight and how far it got. The work-skipping itself comes from the
 * insert gate, not from the bookmark — which is why a resumed attempt can safely re-request page
 * one rather than trying to persist an opaque provider page token.
 */
async function runResync(ctx: SyncContext, prior: ResyncState | null): Promise<void> {
  const { deps } = ctx

  const profile = await deps.client.profile()
  const preCaptured = profile.cursor

  const seen = new Set<string>()
  const startedAt = prior?.startedAt ?? ctx.now().toISOString()
  let pagesDone = prior?.pagesDone ?? 0

  const addresses = ctx.agents.map((a) => a.address)
  let pageToken: string | undefined
  do {
    const page = await deps.client.listMessagesForResync(addresses, RESYNC_WINDOW_DAYS, pageToken)
    for (const { id } of page.ids) {
      if (seen.has(id)) continue
      seen.add(id)
      await ingestMessageId(ctx, id)
    }
    pagesDone += 1
    await withOrg(deps.db, deps.orgId, (tx) => writeResyncState(tx, deps.connectionId, { startedAt, pagesDone }))
    pageToken = page.nextPageToken
  } while (pageToken)

  const threadIds = await withOrg(deps.db, deps.orgId, (tx) => listTicketThreadIds(tx, deps.connectionId))
  const failedThreads: string[] = []
  for (const threadId of threadIds) {
    let ids: { id: string }[]
    try {
      ids = await deps.client.getThreadMessageIds(threadId)
    } catch (err) {
      failedThreads.push(threadId)
      ctx.log('warn', 'mailbox.resync_thread_failed', { threadId, error: err instanceof Error ? err.message : String(err) })
      continue
    }
    for (const { id } of ids) {
      if (seen.has(id)) continue
      seen.add(id)
      await ingestMessageId(ctx, id)
    }
  }
  if (failedThreads.length > 0) {
    ctx.log('warn', 'mailbox.resync_threads_skipped', { count: failedThreads.length, threadIds: failedThreads })
  }

  // Step 4, and the bookmark clear rides in the SAME transaction: "the resync finished" and "the
  // cursor it captured is stored" are one fact, so a crash between them cannot leave a completed
  // resync still advertising itself as in flight.
  const cursor = normalizeCursor(deps.provider, preCaptured)
  if (!cursor) ctx.log('warn', 'mailbox.sync_unusable_cursor', { phase: 'resync', provider: deps.provider })
  await withOrg(deps.db, deps.orgId, async (tx) => {
    if (cursor) await advanceCursorGuarded(tx, deps.connectionId, cursor)
    await writeResyncState(tx, deps.connectionId, null)
  })
}

/**
 * Steps 3–7 for a single message id. Idempotent and side-effect-safe on a re-seen message, which is
 * what lets the resync reuse it verbatim.
 */
async function ingestMessageId(ctx: SyncContext, messageId: string): Promise<void> {
  const { deps } = ctx

  // Step 3: metadata FIRST — a body is read only for mail that passes routing.
  const meta = await getMessageOrSkip(deps.client, messageId, 'metadata')
  if (!meta) return
  if (SKIP_LABELS.some((label) => meta.labelIds.includes(label))) return

  const routed = matchAgent(ctx.agents, meta)
  // Thread id first, then the RFC 2822 chain. A provider thread id is not a reliable conversation
  // key across the spam boundary (see `findTicketByReferences`), and a reply that names a message
  // we already hold belongs to that message's ticket whatever thread it arrived under.
  //
  // This lookup answers ONE question — may we read this body? — and is deliberately not carried any
  // further: everything downstream re-resolves the ticket inside the write transaction, because a
  // network fetch sits between here and there and a concurrent triage can move the ticket under us.
  const knownBeforeFetch = await withOrg(
    deps.db,
    deps.orgId,
    async (tx) =>
      (await findTicketByThread(tx, deps.connectionId, meta.threadId)) ??
      (await findTicketByReferences(tx, deps.connectionId, referenceTokens(meta))),
  )
  // Unrouted AND unknown: the product may not read this mail, so it never gets a full fetch.
  if (!routed && !knownBeforeFetch) return

  const full = await getMessageOrSkip(deps.client, messageId, 'full')
  if (!full) return

  // Step 4: verification interception, BEFORE any ticket or message write.
  if (await interceptVerification(ctx, routed, full)) return

  // Step 5: the SENT label is the SOLE outbound signal. A From header is attacker-forgeable, so a
  // spoofed message claiming our own address is inbound — which is exactly what we want, since it
  // then goes through DMARC-gated handling rather than being trusted as our own reply.
  const direction: 'inbound' | 'outbound' = full.labelIds.includes('SENT') ? 'outbound' : 'inbound'

  // Platform mail is NEVER customer mail. Anything inbound claiming our own MAIL_FROM is dropped
  // outright — no ticket, no message row — whatever it turned out to contain. It reaches this point
  // only when the interception above declined it: the address was already verified, the code was
  // wrong, or the code had been spent. Ticketing those would put our own sign-in codes and
  // verification mail (and any forgery of them) into the owner's support queue for the agent to
  // answer. The check sits HERE and not before the full fetch because a valid code may live in the
  // body, and after the interception so a good code still activates the agent.
  if (direction === 'inbound' && full.fromAddr === ctx.platformSender) {
    ctx.log('info', 'mailbox.platform_mail_skipped', { messageId: full.id })
    return
  }

  const dmarcPass = parseAuthResults(full.authenticationResults).dmarcPass

  const outcome = await withOrg(deps.db, deps.orgId, async (tx): Promise<MessageOutcome> => {
    // Re-resolved INSIDE the transaction, not carried over from the pre-fetch gate above. The full
    // fetch is a network round trip, and across it a triage run can move this ticket new → triaged;
    // reusing the stale row would report a stale `priorStatus` and silently drop the re-triage
    // enqueue this message is supposed to cause. Ticket identity, `priorStatus` and the flood-fold
    // decision all derive from THIS read.
    let ticket: TicketRef | null =
      (await findTicketByThread(tx, deps.connectionId, full.threadId)) ??
      (await findTicketByReferences(tx, deps.connectionId, referenceTokens(full)))
    let created = false

    // Per-sender flood bound. Inbound only (an outbound-first thread is the owner mailing out) and
    // DMARC-pass only: folding unauthenticated mail onto a real customer's ticket would let an
    // attacker inject text into someone else's conversation just by forging their From.
    if (!ticket && direction === 'inbound' && dmarcPass) {
      ticket = await findFloodFoldTarget(tx, deps.connectionId, ctx.now(), full.fromAddr)
    }
    if (!ticket) {
      const opened = await createTicketIfAbsent(tx, {
        orgId: deps.orgId,
        connectionId: deps.connectionId,
        providerThreadId: full.threadId,
        agentId: routed?.id ?? null,
        // A thread whose first ingested message is OUTBOUND (the owner mailed first, or the walk
        // started mid-thread) takes the customer from the To instead of the From.
        customerEmail: direction === 'inbound' ? full.fromAddr : (full.toAddrs[0] ?? null),
        subject: full.subject,
        status: 'new',
      })
      ticket = { id: opened.id, status: opened.status }
      created = opened.created
    }

    const base = { ticketId: ticket.id, direction, created, priorStatus: ticket.status }

    // Step 6: the gate. Everything below it is conditional on this insert having happened.
    const inserted = await insertMessageGated(tx, {
      orgId: deps.orgId,
      ticketId: ticket.id,
      connectionId: deps.connectionId,
      providerMessageId: full.id,
      direction,
      fromAddress: full.fromAddr,
      toAddresses: full.toAddrs,
      ccAddresses: full.ccAddrs,
      subject: full.subject,
      bodyText: full.bodyText,
      rfcMessageId: full.rfcMessageId,
      inReplyTo: full.inReplyTo,
      refs: full.references,
      authResults: full.authenticationResults,
      dmarcPass,
      attachments: full.attachments,
      sentAt: full.internalDate,
    })
    if (!inserted) return { ...base, inserted: false, reopened: false, tripwired: false }
    if (direction === 'outbound') return { ...base, inserted: true, reopened: false, tripwired: false }

    await recordInboundOnTicket(tx, {
      ticketId: ticket.id,
      sentAt: full.internalDate,
      spamFlagged: full.labelIds.some((label) => SPAM_LABELS.has(label)),
      dmarcPass,
      hasAttachments: full.hasAttachments,
      automated: detectAutomated(full),
    })

    // Reopen BEFORE the tripwire, so a reopened ticket carrying escalation-class content still ends
    // up in the owner's queue rather than back in the agent's.
    const reopened = await reopenIfEligible(tx, ticket.id, dmarcPass)
    const keyword = tripwireHit(`${full.subject ?? ''}\n${full.bodyText ?? ''}`, deps.tripwireExtras)
    const tripwired = keyword === null ? false : await applyTripwire(tx, ticket.id, keyword)

    return { ...base, inserted: true, reopened, tripwired }
  })

  // Step 7: post-commit, every one of them gated on the insert. These are the caller's external
  // effects (a queue enqueue, a notification write) and must not hold a transaction open.
  if (!outcome.inserted) return
  ctx.result.insertedMessages += 1
  if (outcome.direction === 'outbound') return

  // A brand-new ticket and a reopened one both need triage; so does an inserted inbound landing on
  // an already-`triaged` ticket, which is the re-triage trigger (the customer said something new
  // after the last verdict). Deduped per run so one ticket enqueues once.
  if (outcome.created || outcome.reopened || outcome.priorStatus === 'triaged') {
    if (!ctx.newInboundTicketIds.has(outcome.ticketId)) {
      ctx.newInboundTicketIds.add(outcome.ticketId)
      deliver(ctx, 'onNewInboundTicket', outcome.ticketId)
    }
  }
  if (outcome.tripwired) {
    ctx.result.tripwiredTicketIds.push(outcome.ticketId)
    deliver(ctx, 'onTripwire', outcome.ticketId)
  }
}

/**
 * Fires one post-commit callback in isolation. The message's own writes are already committed, so a
 * throwing callback has nothing left to roll back — letting it propagate would only abort the walk
 * and cost every LATER message in the batch its effects too, turning one failed enqueue into a
 * batch-wide outage. The failure is logged and the walk continues; the poll sweep's stuck-`new`
 * re-enqueue is what eventually reconciles the ticket whose delivery was lost.
 */
function deliver(ctx: SyncContext, hook: 'onNewInboundTicket' | 'onTripwire', ticketId: string): void {
  try {
    ctx.deps[hook](ticketId)
  } catch (err) {
    ctx.log('warn', 'mailbox.sync_callback_failed', { hook, ticketId, error: err instanceof Error ? err.message : String(err) })
  }
}

/**
 * Agent-address routing: the first agent (by `priority`, then address) whose address appears in
 * To / Cc / Delivered-To. Header ORDER never decides — the owner's priority does.
 */
function matchAgent(agents: AgentRow[], meta: NormalizedMessage): AgentRow | null {
  const addressed = new Set([...meta.toAddrs, ...meta.ccAddrs, ...meta.deliveredTo])
  for (const agent of agents) {
    if (addressed.has(agent.address)) return agent
  }
  return null
}

/** In-Reply-To + References as `<id>` tokens, deduped and capped (a hostile header is bounded). */
function referenceTokens(meta: NormalizedMessage): string[] {
  return [...new Set([...tokenizeReferences(meta.inReplyTo), ...meta.references])].slice(-REFERENCES_CAP)
}

/**
 * Address verification (spec §2: an alias is proven by an inbound one-time code, never by an
 * outbound test send). The platform mails a 6-digit code TO the address being claimed; when that
 * mail arrives here, it is proof the owner controls the address — so the agent goes active and the
 * mail is consumed: no ticket, no message row, nothing the owner has to clean up.
 *
 * Every condition is required. Only mail from `platformSender` is considered (any sender could
 * otherwise mail six digits at an unverified alias), only an agent still `pending_verification` can
 * be activated, and the code is compared as `hashToken('action', …)` against the stored hash —
 * the plaintext code is never persisted, and a wrong code simply falls through to ordinary routing.
 */
async function interceptVerification(ctx: SyncContext, routed: AgentRow | null, full: NormalizedMessage): Promise<boolean> {
  if (!routed || routed.status !== 'pending_verification') return false
  if (full.fromAddr !== ctx.platformSender) return false
  if (!routed.verificationCodeHash) return false

  const code = VERIFICATION_CODE_RE.exec(`${full.subject ?? ''}\n${full.bodyText ?? ''}`)?.[1]
  if (!code) return false
  if (!hashesEqual(hashToken('action', code), routed.verificationCodeHash)) return false

  await withOrg(ctx.deps.db, ctx.deps.orgId, async (tx) => {
    await consumeVerification(tx, routed.id)
    await audit(tx, {
      actor: 'system:mailbox.sync',
      action: 'agent.address_verified',
      entityType: 'agent',
      entityId: routed.id,
      detail: { address: routed.address },
    })
  })

  // Keep the in-memory routing table honest: a second code mail later in this same run must route
  // normally rather than be intercepted again against a hash that no longer exists.
  routed.status = 'active'
  routed.verificationCodeHash = null
  ctx.log('info', 'mailbox.agent_verified', { agentId: routed.id })
  return true
}

/** A vanished message is routine (deleted mail, expired drafts) — skip it, never fail the poll. */
async function getMessageOrSkip(
  client: MailboxClient,
  messageId: string,
  format: 'metadata' | 'full',
): Promise<NormalizedMessage | null> {
  try {
    return await client.getMessage(messageId, { format })
  } catch (err) {
    if (isMessageGone(err)) return null
    throw err
  }
}
