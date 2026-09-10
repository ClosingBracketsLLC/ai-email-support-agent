/**
 * `MockMailbox` — an in-memory, deterministic stand-in for the real Gmail (Task 9) and Microsoft
 * Graph (Task 10) adapters, implementing OUR `MailboxClient` port in full. Ported from doge-buddy
 * `packages/gmail/src/mock.ts` (history semantics, draft churn → replaced by fault-injection-only
 * needs since this port has no `saveDraft`/`sendDraft`, deterministic ids, marker round-trip), with
 * three deliberate differences from the reference:
 *
 * 1. **Real pagination.** The reference's `listHistory` returned every matching record in one call.
 *    Here `listChanges` serves `pageSize` (default 3) records per call with `nextPageToken`, and only
 *    the FINAL page (the one with no `nextPageToken`) carries `newCursor` — callers (the sync walk,
 *    Task 11) must drain all pages before trusting the new cursor.
 * 2. **Two modes, one store.** `mode: 'gmail' | 'graph'` share the exact same message store and
 *    history log — there is no per-folder modeling for graph (the spec's three-folder delta walk is
 *    the real Graph adapter's concern, Task 10). The two modes differ only in: the cursor's on-the-
 *    wire shape (`{ historyId }` vs the opaque `{ deltaTokens }`), subscription expiry (7 days vs 3),
 *    and `sendReply`'s capture shape (gmail routes through the real `buildReplyRaw` for byte-exact
 *    header validation; graph models the two-phase send AGAINST A REAL LEDGER — see point 2c).
 * 2b. **Body scrubbing is shared with the adapters.** A `format: 'full'` fetch runs the stored body
 *    through `scrubCardNumbers`, exactly as `normalizeGmailMessage`/`normalizeGraphMessage` do, so
 *    no caller can observe through the mock a card number the real clients would have masked.
 * 2c. **Graph-mode draft ledger + one-shot crash hooks (Task 12).** A fresh graph `sendReply` mints
 *    a `providerDraftId`, records it in a `providerDraftId -> { threadId, sent }` ledger (`drafts()`)
 *    BEFORE calling `onDraftCreated`, then stores the SENT message with its `id` SET TO that same
 *    `providerDraftId` — matching the real adapter's `Prefer: IdType="ImmutableId"` behavior, where
 *    the draft's id survives the send. `existingDraftId` re-entry reads the ledger: an unknown id is
 *    `MailApiError('draft not found', 404)`; an already-`sent` entry is echoed back with nothing
 *    stored twice; an unsent entry completes the send. `failAfter(phase, err)` is a one-shot fault
 *    per phase (same semantics as `maybeThrowPending`, scoped to `sendReply`'s two checkpoints
 *    instead of a whole method): `'createReply'` fires once the draft is ledgered and
 *    `onDraftCreated` has run but nothing is sent yet; `'send'` fires once the SENT message is
 *    already stored (the customer has it — this models a lost response, not a lost send). Gmail has
 *    no draft phase, so `failAfter('createReply', ...)` on a gmail-mode mailbox is checked nowhere
 *    and never fires; `failAfter('send', ...)` applies identically to both modes.
 * 3. **No labels API.** This port never mutates a real mailbox (no `modifyMessage`/`createLabel`
 *    equivalent), so there is only one 404 shape here (`MessageGoneError` from `getMessage`), not the
 *    reference's two. Spam is modeled by passing `labelIds: ['JUNK']` to `receiveInbound`, not by a
 *    separate query flag.
 */
import { MailApiError, CursorExpiredError, MessageGoneError } from './errors.ts'
import { parseAddrSpecs, parseFirstAddrSpec } from './address.ts'
import { buildReplyRaw } from './rfc2822.ts'
import { scrubCardNumbers } from './scrub.ts'
import { tokenizeReferences } from './threading.ts'
import { MARKER_HEADER, type MailboxClient, type NormalizedMessage } from './types.ts'

/** The two checkpoints inside graph-mode `sendReply` that `failAfter` can target — see the file
 * header, point 2c. */
export type SendPhase = 'createReply' | 'send'

export interface MockMailboxOptions {
  mode: 'gmail' | 'graph'
  selfAddress?: string
  /** Records served per `listChanges`/`listMessagesForResync` page. Default 3 — small enough that
   * any test with more than a couple of messages exercises real pagination. */
  pageSize?: number
}

export interface ReceiveInboundInput {
  from: string
  to?: string[]
  cc?: string[]
  deliveredTo?: string[]
  subject: string
  bodyText: string
  threadId?: string
  /** Gmail-label-shaped, reused verbatim in graph mode too (this mock has no folder model): 'JUNK'
   * lands the message in spam, 'DRAFT'/'TRASH' likewise — a downstream sync walk skips those two and
   * spam-flags the ticket for 'JUNK'. Default `['INBOX']`. */
  labelIds?: string[]
  /** Simulates the provider's own SPF/DKIM/DMARC stamp. Default `'mock; dmarc=pass'` — omit-to-fail
   * would make every test have to opt in to the common case. */
  authenticationResults?: string
  inReplyTo?: string
  references?: string
  attachments?: { filename: string; mime: string; size: number }[]
  /** Automated-mail headers, surfaced on both fetch formats exactly as both real adapters surface
   * them (they are on the metadata header list). Default null — ordinary human mail. */
  autoSubmitted?: string
  precedence?: string
  listId?: string
}

export interface MockMailbox extends MailboxClient {
  receiveInbound(m: ReceiveInboundInput): { id: string; threadId: string }
  /** Models the owner's own hand-sent (or any other out-of-band) outbound mail: lands with the SENT
   * label, carries no marker, and is visible on the next `listChanges` — the shape a sync walk uses
   * to test "spoofed inbound has no SENT label" against a genuine owner reply. */
  receiveOutbound(m: { to: string[]; subject: string; bodyText: string; threadId?: string }): { id: string; threadId: string }
  /** Next `listChanges` call throws `CursorExpiredError` (both modes — graph's `syncStateNotFound`
   * surfaces through the same port-level error), then behavior returns to normal. */
  expireCursor(): void
  /** Next call to `method` throws `err`, then normal. */
  failNext(method: keyof MailboxClient, err: Error): void
  /** Subsequent `getMessage(id, ...)` throws `MessageGoneError`. */
  deleteMessage(id: string): void
  /** Rewinds a stored message's `internalDate` — models a provider handing over an OLDER message
   * after a newer one on the same thread (this mock otherwise stamps strictly increasing dates). */
  backdate(id: string, internalDate: Date): void
  /** Inspection helper: every message sent via `sendReply`, oldest first. `raw` is present only in
   * gmail mode (graph's two-phase send never produces an RFC 2822 blob). */
  sentMessages(): { raw?: string; to: string; bodyText: string; threadId: string; markerDraftId: string | null }[]
  /** The current watch/subscription, or `null` before the first `subscribe` / after `unsubscribe`. */
  subscriptionState(): { subscriptionId: string; expiresAt: Date; clientState?: string } | null
  /** One-shot: the next `sendReply` throws `err` AFTER the named phase completed — `'createReply'`
   * = the draft exists and `onDraftCreated` ran, nothing sent; `'send'` = the SENT message is
   * stored (the customer has it) and the response was lost. */
  failAfter(phase: SendPhase, err: Error): void
  /** Graph-mode draft ledger: `providerDraftId -> { threadId, sent }`. */
  drafts(): ReadonlyMap<string, { threadId: string; sent: boolean }>
}

const DEFAULT_SELF_ADDRESS = 'me@mock.aesa'
const DEFAULT_PAGE_SIZE = 3
const DEFAULT_AUTH_RESULTS = 'mock; dmarc=pass'
/** Arbitrary deterministic baseline so real wall-clock values never leak into test output. */
const BASE_INTERNAL_DATE_MS = 1_700_000_000_000
const GMAIL_SUBSCRIPTION_MS = 7 * 24 * 60 * 60 * 1000
const GRAPH_SUBSCRIPTION_MS = 3 * 24 * 60 * 60 * 1000
/** Internal-only key: our unified store models graph's per-folder delta tokens as a single opaque
 * pointer into the same shared history log, since this mock does not model folders (see file header,
 * point 2). Never exposed — `deltaTokens` is `unknown` to every caller. */
const GRAPH_CURSOR_KEY = 'all'

interface StoredMessage {
  id: string
  threadId: string
  labelIds: string[]
  internalDate: Date
  fromRaw: string | null
  to: string[]
  cc: string[]
  deliveredTo: string[]
  subject: string | null
  bodyText: string | null
  rfcMessageId: string
  inReplyTo: string | null
  references: string | null
  authenticationResults: string | null
  autoSubmitted: string | null
  precedence: string | null
  listId: string | null
  /** Value of `X-Aesa-Draft` when this message was produced by `sendReply` with that extra header;
   * null for inbound mail, owner hand-sends via `receiveOutbound`, and unmarked replies. */
  markerDraftId: string | null
  attachments: { filename: string | null; mime: string | null; size: number | null }[]
  /** Superseded (currently only via `deleteMessage`) — `getMessage` throws `MessageGoneError`, but
   * the record stays around for thread-walk bookkeeping consistency. */
  gone: boolean
}

interface ChangeLogEntry {
  id: string
  messageIds: { id: string; threadId: string }[]
}

type GmailCursor = { historyId?: string } | null | undefined
type GraphCursor = { deltaTokens?: Record<string, string> } | null | undefined

export function createMockMailbox(opts: MockMailboxOptions): MockMailbox {
  const mode = opts.mode
  const selfAddress = opts.selfAddress ?? DEFAULT_SELF_ADDRESS
  const pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE
  const subscriptionDurationMs = mode === 'gmail' ? GMAIL_SUBSCRIPTION_MS : GRAPH_SUBSCRIPTION_MS

  const messages = new Map<string, StoredMessage>()
  const historyLog: ChangeLogEntry[] = []
  const pendingMethodFailures = new Map<keyof MailboxClient, Error>()
  const sentReplyLog: { raw?: string; to: string; bodyText: string; threadId: string; markerDraftId: string | null }[] = []
  /** Graph-mode draft ledger (file header, point 2c) — untouched by gmail mode, which has no
   * draft phase to ledger. */
  const draftLedger = new Map<string, { threadId: string; sent: boolean }>()
  /** One-shot `failAfter` faults, keyed by the `sendReply` checkpoint they fire at. */
  const pendingSendFailures = new Map<SendPhase, Error>()

  let historyCounter = 0n
  let idCounter = 0
  let dateCounter = 0
  let subCounter = 0
  let expireCursorPending = false
  let subscription: { subscriptionId: string; expiresAt: Date; clientState?: string } | null = null

  function nextMessageId(): string {
    idCounter += 1
    return `mock-msg-${idCounter}`
  }

  function nextThreadId(): string {
    // Shares the message id's counter space, same as the reference — the two id spaces are never
    // compared, so simple monotonic sharing keeps ids readable without a second counter.
    idCounter += 1
    return `mock-thread-${idCounter}`
  }

  /** The mock's own notion of "now", advancing one simulated second per `tick()` — every stored
   * message ticks it (see `nextInternalDate`), and so does every `subscribe`/`renewSubscription`
   * call (so a bare renew-right-after-subscribe, with no message traffic in between, still observes
   * time having passed). `listMessagesForResync`'s `sinceDays` window is measured against this, not
   * the wall clock — the store's messages are stamped seconds apart starting from a fixed 2023
   * baseline, so a real `Date.now()` cutoff would place every fixture message far outside any
   * realistic resync window. */
  function mockNow(): Date {
    return new Date(BASE_INTERNAL_DATE_MS + dateCounter * 1000)
  }

  function tick(): void {
    dateCounter += 1
  }

  function nextInternalDate(): Date {
    tick()
    return mockNow()
  }

  function pushHistory(messageIds: { id: string; threadId: string }[]): void {
    historyCounter += 1n
    historyLog.push({ id: historyCounter.toString(), messageIds: messageIds.map((m) => ({ ...m })) })
  }

  function maybeThrowPending(method: keyof MailboxClient): void {
    const err = pendingMethodFailures.get(method)
    if (err) {
      pendingMethodFailures.delete(method)
      throw err
    }
  }

  /** Same one-shot shape as `maybeThrowPending`, scoped to a `sendReply` checkpoint instead of a
   * whole method. Checked ONLY at the checkpoint that literally exists for the current mode/path —
   * gmail's `sendReply` never calls this with `'createReply'`, so a pending fault set for that
   * phase simply sits unconsumed (the file header's "no-op" behavior). */
  function maybeThrowFailAfter(phase: SendPhase): void {
    const err = pendingSendFailures.get(phase)
    if (err) {
      pendingSendFailures.delete(phase)
      throw err
    }
  }

  function normalizeAddrList(addrs: string[]): string[] {
    return parseAddrSpecs(addrs.join(', '))
  }

  /** Reads the pointer this cursor represents, defaulting to the origin when the cursor is missing
   * entirely (a caller that never seeded via `profile()`). */
  function cursorPointer(cursor: unknown): bigint {
    if (mode === 'gmail') {
      const c = cursor as GmailCursor
      return BigInt(c?.historyId ?? '0')
    }
    const c = cursor as GraphCursor
    return BigInt(c?.deltaTokens?.[GRAPH_CURSOR_KEY] ?? '0')
  }

  function buildCursor(pointer: bigint): unknown {
    return mode === 'gmail' ? { historyId: pointer.toString() } : { deltaTokens: { [GRAPH_CURSOR_KEY]: pointer.toString() } }
  }

  function storeMessage(input: {
    /** Graph-mode sent copies use this to force the stored id to the providerDraftId (file
     * header, point 2c) instead of minting a fresh one — every other caller omits it. */
    id?: string
    threadId: string
    labelIds: string[]
    fromRaw: string | null
    to?: string[]
    cc?: string[]
    deliveredTo?: string[]
    subject?: string | null
    bodyText: string | null
    inReplyTo?: string | null
    references?: string | null
    authenticationResults?: string | null
    autoSubmitted?: string | null
    precedence?: string | null
    listId?: string | null
    markerDraftId?: string | null
    attachments?: { filename: string; mime: string; size: number }[]
  }): StoredMessage {
    const id = input.id ?? nextMessageId()
    const stored: StoredMessage = {
      id,
      threadId: input.threadId,
      labelIds: [...input.labelIds],
      internalDate: nextInternalDate(),
      fromRaw: input.fromRaw,
      to: normalizeAddrList(input.to ?? []),
      cc: normalizeAddrList(input.cc ?? []),
      deliveredTo: normalizeAddrList(input.deliveredTo ?? []),
      subject: input.subject ?? null,
      bodyText: input.bodyText,
      rfcMessageId: `<${id}@mock.aesa>`,
      inReplyTo: input.inReplyTo ?? null,
      references: input.references ?? null,
      authenticationResults: input.authenticationResults ?? null,
      autoSubmitted: input.autoSubmitted ?? null,
      precedence: input.precedence ?? null,
      listId: input.listId ?? null,
      markerDraftId: input.markerDraftId ?? null,
      attachments: (input.attachments ?? []).map((a) => ({ ...a })),
      gone: false,
    }
    messages.set(id, stored)
    return stored
  }

  function buildNormalizedMessage(msg: StoredMessage, format: 'metadata' | 'full'): NormalizedMessage {
    return {
      id: msg.id,
      threadId: msg.threadId,
      fromAddr: parseFirstAddrSpec(msg.fromRaw),
      toAddrs: [...msg.to],
      ccAddrs: [...msg.cc],
      deliveredTo: [...msg.deliveredTo],
      subject: msg.subject,
      rfcMessageId: msg.rfcMessageId,
      inReplyTo: msg.inReplyTo,
      references: tokenizeReferences(msg.references),
      authenticationResults: msg.authenticationResults,
      autoSubmitted: msg.autoSubmitted,
      precedence: msg.precedence,
      listId: msg.listId,
      internalDate: msg.internalDate,
      labelIds: [...msg.labelIds],
      // Card scrubbing happens in BOTH real adapters' `normalize*Message` (they are the only place
      // a body is ever materialized), so it happens here too: a caller must never be able to see a
      // card number through the mock that it could not see through Gmail or Graph. Metadata fetches
      // carry no body at all, so there is nothing to scrub on that path.
      bodyText: format === 'metadata' || msg.bodyText === null ? null : scrubCardNumbers(msg.bodyText),
      hasAttachments: msg.attachments.length > 0,
      attachments: msg.attachments.map((a) => ({ ...a })),
      markerDraftId: msg.markerDraftId,
    }
  }

  function requireLiveMessage(id: string): StoredMessage {
    const msg = messages.get(id)
    if (!msg || msg.gone) throw new MessageGoneError()
    return msg
  }

  function paginate<T>(items: T[], pageToken: string | undefined): { page: T[]; nextPageToken?: string; drained: boolean } {
    const startIndex = pageToken ? Number(pageToken) : 0
    const page = items.slice(startIndex, startIndex + pageSize)
    const nextIndex = startIndex + page.length
    const drained = nextIndex >= items.length
    return drained ? { page, drained } : { page, nextPageToken: String(nextIndex), drained }
  }

  const mailbox: MockMailbox = {
    async profile() {
      maybeThrowPending('profile')
      return { emailAddress: selfAddress, cursor: buildCursor(historyCounter) }
    },

    async listChanges(cursor, pageToken) {
      maybeThrowPending('listChanges')
      if (expireCursorPending) {
        expireCursorPending = false
        throw new CursorExpiredError()
      }
      const start = cursorPointer(cursor)
      const filtered = historyLog.filter((r) => BigInt(r.id) > start)
      const { page, nextPageToken, drained } = paginate(filtered, pageToken)

      const result: { records: { id: string; messageIds: { id: string; threadId: string }[] }[]; nextPageToken?: string; newCursor?: unknown } = {
        records: page.map((r) => ({ id: r.id, messageIds: r.messageIds.map((m) => ({ ...m })) })),
      }
      if (nextPageToken !== undefined) {
        result.nextPageToken = nextPageToken
      }
      if (drained) {
        const endPointer = filtered.length > 0 ? BigInt(filtered[filtered.length - 1]!.id) : start
        result.newCursor = buildCursor(endPointer)
      }
      return result
    },

    async listMessagesForResync(addresses, sinceDays, pageToken) {
      maybeThrowPending('listMessagesForResync')
      const targets = new Set(addresses.map((a) => a.toLowerCase()))
      const cutoffMs = mockNow().getTime() - sinceDays * 24 * 60 * 60 * 1000

      const matches: { id: string; threadId: string }[] = []
      for (const msg of messages.values()) {
        if (msg.gone) continue
        if (msg.internalDate.getTime() < cutoffMs) continue
        // includeSpamTrash: true semantics — no label filter at all, matching the reference's
        // resync query which also never excludes SPAM/TRASH (only the default listMessages does).
        const hit = msg.to.some((a) => targets.has(a)) || msg.cc.some((a) => targets.has(a)) || msg.deliveredTo.some((a) => targets.has(a))
        if (!hit) continue
        matches.push({ id: msg.id, threadId: msg.threadId })
      }

      const { page, nextPageToken } = paginate(matches, pageToken)
      return nextPageToken === undefined ? { ids: page } : { ids: page, nextPageToken }
    },

    async getThreadMessageIds(threadId) {
      maybeThrowPending('getThreadMessageIds')
      const ids: { id: string }[] = []
      for (const msg of messages.values()) {
        if (msg.gone) continue
        if (msg.threadId !== threadId) continue
        ids.push({ id: msg.id })
      }
      return ids
    },

    async getMessage(id, opts) {
      maybeThrowPending('getMessage')
      const msg = requireLiveMessage(id)
      return buildNormalizedMessage(msg, opts.format)
    },

    async sendReply(r) {
      maybeThrowPending('sendReply')
      const markerDraftId = r.extraHeaders?.[MARKER_HEADER] ?? null

      if (mode === 'gmail') {
        // Routes through the SAME builder the real client uses — identical extraHeader-name
        // validation/sanitizing, and a realistic raw message for sentMessages() to decode.
        const raw = buildReplyRaw({
          from: r.from ?? selfAddress,
          to: r.to,
          subject: r.subject,
          inReplyTo: r.inReplyTo,
          references: r.references,
          bodyText: r.bodyText,
          extraHeaders: r.extraHeaders,
        })
        const msg = storeMessage({
          threadId: r.threadId,
          labelIds: ['SENT'],
          fromRaw: r.from ?? selfAddress,
          to: [r.to],
          subject: r.subject,
          bodyText: r.bodyText,
          inReplyTo: r.inReplyTo,
          references: r.references,
          markerDraftId,
        })
        sentReplyLog.push({ raw, to: r.to, bodyText: r.bodyText, threadId: msg.threadId, markerDraftId })
        pushHistory([{ id: msg.id, threadId: msg.threadId }])
        // Gmail has no draft phase — only the 'send' checkpoint can ever fire here (file header,
        // point 2c); 'createReply' is never checked, so a pending fault for it is a true no-op.
        maybeThrowFailAfter('send')
        return { id: msg.id, threadId: msg.threadId }
      }

      // graph: models the real two-phase createReply -> PATCH -> send against a providerDraftId
      // ledger (`draftLedger`, file header point 2c), so `existingDraftId` re-entry can distinguish
      // the same three states the real adapter's re-entry branch does: unknown, already sent,
      // created-but-unsent.
      if (r.existingDraftId) {
        const record = draftLedger.get(r.existingDraftId)
        if (!record) throw new MailApiError('draft not found', 404)
        if (record.sent) {
          // Already went out by an earlier, interrupted attempt — return without a second send.
          return { id: r.existingDraftId, threadId: record.threadId, providerDraftId: r.existingDraftId }
        }
        const msg = storeMessage({
          id: r.existingDraftId,
          threadId: record.threadId,
          labelIds: ['SENT'],
          fromRaw: r.from ?? selfAddress,
          to: [r.to],
          subject: r.subject,
          bodyText: r.bodyText,
          inReplyTo: r.inReplyTo,
          references: r.references,
          markerDraftId,
        })
        draftLedger.set(r.existingDraftId, { threadId: record.threadId, sent: true })
        sentReplyLog.push({ to: r.to, bodyText: r.bodyText, threadId: msg.threadId, markerDraftId })
        pushHistory([{ id: msg.id, threadId: msg.threadId }])
        maybeThrowFailAfter('send')
        return { id: msg.id, threadId: msg.threadId, providerDraftId: r.existingDraftId }
      }

      // `replyToProviderMessageId` is Graph's reply target (createReply operates on a MESSAGE id,
      // not a thread id) — required for a fresh send, matching the real adapter's (Task 10)
      // validation.
      if (!r.replyToProviderMessageId) {
        throw new MailApiError('replyToProviderMessageId required', 400)
      }
      const providerDraftId = `mock-draft-${(subCounter += 1)}`
      draftLedger.set(providerDraftId, { threadId: r.threadId, sent: false })
      // Persist BEFORE the (simulated) PATCH/send below — mirrors the real Graph adapter's
      // `onDraftCreated` call, which fires right after `createReply` returns. A throw here aborts
      // the send before anything is stored.
      await r.onDraftCreated?.(providerDraftId)
      maybeThrowFailAfter('createReply')

      // The stored SENT message's id is SET TO the providerDraftId — Graph's `Prefer:
      // IdType="ImmutableId"` keeps the draft's id after send, exactly like the real adapter's
      // `{ id: draftId }` return (file header, point 2c).
      const msg = storeMessage({
        id: providerDraftId,
        threadId: r.threadId,
        labelIds: ['SENT'],
        fromRaw: r.from ?? selfAddress,
        to: [r.to],
        subject: r.subject,
        bodyText: r.bodyText,
        inReplyTo: r.inReplyTo,
        references: r.references,
        markerDraftId,
      })
      draftLedger.set(providerDraftId, { threadId: r.threadId, sent: true })
      sentReplyLog.push({ to: r.to, bodyText: r.bodyText, threadId: msg.threadId, markerDraftId })
      pushHistory([{ id: msg.id, threadId: msg.threadId }])
      maybeThrowFailAfter('send')
      return { id: msg.id, threadId: msg.threadId, providerDraftId }
    },

    async subscribe(input) {
      maybeThrowPending('subscribe')
      tick() // advances "now" even with zero message traffic, so a later renew observes real progress
      const subscriptionId = mode === 'gmail' ? input.topicOrUrl : `mock-sub-${(subCounter += 1)}`
      const expiresAt = new Date(mockNow().getTime() + subscriptionDurationMs)
      subscription = { subscriptionId, expiresAt, clientState: input.clientState }
      return { subscriptionId, expiresAt }
    },

    async renewSubscription(subscriptionId, expiresAt) {
      maybeThrowPending('renewSubscription')
      if (!subscription || subscription.subscriptionId !== subscriptionId) {
        throw new MailApiError('subscription not found', 404, 'notFound')
      }
      tick()
      const nextExpiresAt = expiresAt ?? new Date(mockNow().getTime() + subscriptionDurationMs)
      subscription = { ...subscription, expiresAt: nextExpiresAt }
      return { subscriptionId, expiresAt: nextExpiresAt }
    },

    async unsubscribe(subscriptionId) {
      maybeThrowPending('unsubscribe')
      if (subscription?.subscriptionId === subscriptionId) subscription = null
    },

    async findSentByMarker(threadId, draftId, scanLimit) {
      maybeThrowPending('findSentByMarker')
      const candidates: StoredMessage[] = []
      for (const msg of messages.values()) {
        if (msg.gone) continue
        if (msg.threadId !== threadId) continue
        candidates.push(msg)
      }
      // Newest-first, examining at most `scanLimit` candidates (doge-buddy's recovery scan,
      // ported, generalized here into the port itself): a marker among the newest `scanLimit`
      // messages resolves even on an otherwise-oversized thread — only a MISS that still has
      // unexamined older candidates is refused, since returning null there could send a duplicate.
      const newestFirst = [...candidates].reverse()
      const examined = newestFirst.slice(0, scanLimit)
      for (const msg of examined) {
        if (msg.markerDraftId === draftId) return msg.id
      }
      if (newestFirst.length > scanLimit) {
        throw new MailApiError('thread too busy', 429)
      }
      return null
    },

    receiveInbound(m) {
      const threadId = m.threadId ?? nextThreadId()
      const msg = storeMessage({
        threadId,
        labelIds: m.labelIds ?? ['INBOX'],
        fromRaw: m.from,
        to: m.to ?? [selfAddress],
        cc: m.cc,
        deliveredTo: m.deliveredTo,
        subject: m.subject,
        bodyText: m.bodyText,
        inReplyTo: m.inReplyTo ?? null,
        references: m.references ?? null,
        authenticationResults: m.authenticationResults ?? DEFAULT_AUTH_RESULTS,
        autoSubmitted: m.autoSubmitted ?? null,
        precedence: m.precedence ?? null,
        listId: m.listId ?? null,
        attachments: m.attachments,
      })
      pushHistory([{ id: msg.id, threadId: msg.threadId }])
      return { id: msg.id, threadId: msg.threadId }
    },

    receiveOutbound(m) {
      const threadId = m.threadId ?? nextThreadId()
      const msg = storeMessage({
        threadId,
        labelIds: ['SENT'],
        fromRaw: selfAddress,
        to: m.to,
        subject: m.subject,
        bodyText: m.bodyText,
      })
      pushHistory([{ id: msg.id, threadId: msg.threadId }])
      return { id: msg.id, threadId: msg.threadId }
    },

    expireCursor() {
      expireCursorPending = true
    },

    failNext(method, err) {
      pendingMethodFailures.set(method, err)
    },

    failAfter(phase, err) {
      pendingSendFailures.set(phase, err)
    },

    deleteMessage(id) {
      const msg = messages.get(id)
      if (!msg) throw new Error(`MockMailbox.deleteMessage: unknown message id "${id}"`)
      msg.gone = true
    },

    backdate(id, internalDate) {
      const msg = messages.get(id)
      if (!msg) throw new Error(`MockMailbox.backdate: unknown message id "${id}"`)
      msg.internalDate = internalDate
    },

    sentMessages() {
      return sentReplyLog.map((m) => ({ ...m }))
    },

    subscriptionState() {
      return subscription ? { ...subscription } : null
    },

    drafts() {
      return new Map([...draftLedger].map(([id, record]) => [id, { ...record }]))
    },
  }

  return mailbox
}
