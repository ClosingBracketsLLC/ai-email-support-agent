/**
 * Gmail `MailboxClient`. Ports doge-buddy `packages/gmail/src/client.ts`'s single `request()` entry
 * point, its error taxonomy and its jittered-retry discipline, and above all its `Endpoint` type —
 * see the comment on it below, ported near-verbatim, for why `'send'` is excluded from every retry
 * path that could plausibly double-send.
 *
 * Two differences from the reference, both from this port's contract (Task 8's `credentials.ts`
 * owns refresh/lease/retry, not this client):
 *   - No `GmailAuth` (`getAccessToken`/`invalidate`) callback. The caller passes a single, already
 *     fresh `accessToken` per client instance; a 401 throws `ProviderAuthError` immediately with NO
 *     internal retry — the worker's refresh loop above this client owns re-authentication.
 *   - Errors map onto this package's shared taxonomy (`MailApiError`/`ProviderRateLimitError`/
 *     `ProviderAuthError`/`CursorExpiredError`/`MessageGoneError`) rather than Gmail-specific classes.
 */
import { CursorExpiredError, MailApiError, MessageGoneError, ProviderAuthError, ProviderRateLimitError } from '../../errors.ts'
import { buildReplyRaw } from '../../rfc2822.ts'
import type { ChangeRecord, ListChangesResult, MailboxClient, NormalizedMessage } from '../../types.ts'
import { METADATA_HEADERS, normalizeGmailMessage, type RawGmailMessage } from './map.ts'

const BASE_URL = 'https://gmail.googleapis.com/gmail/v1/users/me'

/** 403 reasons that mean "quota blip, try again" rather than "permission denied". */
const RATE_LIMIT_REASONS = new Set(['userRateLimitExceeded', 'rateLimitExceeded', 'dailyLimitExceeded'])

/**
 * `send` is its own endpoint kind purely so the retry logic can EXCLUDE it: `messages.send` is the
 * one non-idempotent call in this client, and a transport-level failure (timeout, 5xx) does not
 * mean Gmail failed to queue the message — it means we stopped waiting for the answer. An
 * HTTP-layer retry there can put two copies in the customer's inbox from inside a single
 * `sendReply` call, and the caller's `X-Aesa-Draft` marker cannot detect or undo that (both copies
 * would carry it). The worker's own crash-recovery re-entry (`findSentByMarker`) IS the send's
 * retry layer — it re-reads the thread first, so it can tell "already sent" from "never sent";
 * this layer cannot, so it never guesses.
 */
type Endpoint = 'listChanges' | 'getMessage' | 'send' | 'other'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 200ms base + up to 400ms of jitter. */
function jitterDelayMs(): number {
  return 200 + Math.random() * 400
}

/** Every request gets its own hard timeout, well under any caller's own job-level deadline — a
 * hung Gmail call must never be able to hold a poll (and whatever lock protects it) open forever. */
const REQUEST_TIMEOUT_MS = 20_000

/** AbortSignal.timeout() rejects with a DOMException named 'TimeoutError' (NOT 'AbortError') —
 * this is the only abort reason this client itself can produce, since it never accepts a caller
 * signal on ordinary requests. Any other error name is unknown and propagates untouched. */
function isTimeoutError(err: unknown): boolean {
  return err instanceof Error && err.name === 'TimeoutError'
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    const text = await res.text()
    return text.length > 0 ? JSON.parse(text) : null
  } catch {
    return null
  }
}

interface GmailErrorBody {
  error?: {
    code?: number
    message?: string
    status?: string
    errors?: { reason?: string; message?: string; domain?: string }[]
  }
}

/** `Retry-After` on a 429/403-rate response is always seconds for Gmail (never an HTTP-date) —
 * absent or non-numeric maps to `null` rather than guessing a value. */
function parseRetryAfterMs(header: string | null): number | null {
  if (header === null) return null
  const seconds = Number(header)
  if (!Number.isFinite(seconds) || seconds < 0) return null
  return seconds * 1000
}

interface RawHistoryRecord {
  id: string
  messagesAdded?: { message: { id: string; threadId: string } }[]
}

export interface CreateGmailClientOptions {
  accessToken: string
  /** Stamped as From on sendReply unless the input overrides it. */
  selfAddress: string
  fetchFn?: typeof fetch
}

export function createGmailClient(opts: CreateGmailClientOptions): MailboxClient {
  const { accessToken, selfAddress, fetchFn = globalThis.fetch } = opts

  /**
   * Single HTTP entry point implementing the full error taxonomy:
   *   - 401             -> ProviderAuthError, no retry (the worker's refresh loop owns it)
   *   - 429 / 403-quota  -> one jittered retry, then ProviderRateLimitError honouring Retry-After
   *   - 403 other        -> MailApiError (no retry — distinct from quota)
   *   - 404              -> CursorExpiredError / MessageGoneError (endpoint-specific) / MailApiError
   *   - 5xx / timeout     -> one jittered retry (except 'send'), then MailApiError
   */
  async function request(method: string, path: string, params: [string, string][], endpoint: Endpoint, body?: unknown): Promise<unknown> {
    const url = new URL(BASE_URL + path)
    for (const [key, value] of params) url.searchParams.append(key, value)

    let attemptedRateRetry = false
    let attemptedServerRetry = false

    for (;;) {
      const init: RequestInit = {
        method,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }

      let res: Response
      try {
        res = await fetchFn(url, init)
      } catch (err) {
        // A timed-out fetch throws rather than resolving with a Response — treat it like a 5xx:
        // one jittered retry, then surface as MailApiError. `endpoint !== 'send'`: see the
        // `Endpoint` type's comment above — a timed-out send may already be queued by Gmail.
        if (isTimeoutError(err) && !attemptedServerRetry && endpoint !== 'send') {
          attemptedServerRetry = true
          await sleep(jitterDelayMs())
          continue
        }
        if (isTimeoutError(err)) {
          throw new MailApiError('Gmail API request timed out', 0, 'timeout')
        }
        // Unknown error (not our own timeout) — this client accepts no caller signal on ordinary
        // requests, so there's nothing else this could legitimately be. Don't retry, don't wrap.
        throw err
      }

      if (res.ok) {
        if (res.status === 204) return undefined
        const text = await res.text()
        return text.length > 0 ? JSON.parse(text) : undefined
      }

      const errBody = (await safeJson(res)) as GmailErrorBody | null
      const reason = errBody?.error?.errors?.[0]?.reason ?? null
      const status = res.status

      if (status === 401) {
        throw new ProviderAuthError(errBody?.error?.message ?? 'Gmail access token was rejected')
      }

      const rateLimited = status === 429 || (status === 403 && reason !== null && RATE_LIMIT_REASONS.has(reason))
      if (rateLimited) {
        if (!attemptedRateRetry) {
          attemptedRateRetry = true
          await sleep(jitterDelayMs())
          continue
        }
        const retryAfterMs = parseRetryAfterMs(res.headers.get('Retry-After'))
        throw new ProviderRateLimitError(errBody?.error?.message ?? 'Gmail API rate limit exceeded', retryAfterMs)
      }

      if (status >= 500 && status < 600) {
        // Same exclusion as the timeout path above: a 5xx on `messages.send` is not proof the
        // message was not queued, so this layer never retries it.
        if (!attemptedServerRetry && endpoint !== 'send') {
          attemptedServerRetry = true
          await sleep(jitterDelayMs())
          continue
        }
        throw new MailApiError(errBody?.error?.message ?? `Gmail API server error (${status})`, status, reason ?? undefined)
      }

      if (status === 404 && endpoint === 'listChanges') throw new CursorExpiredError()
      if (status === 404 && endpoint === 'getMessage') throw new MessageGoneError()

      throw new MailApiError(errBody?.error?.message ?? `Gmail API error (${status})`, status, reason ?? undefined)
    }
  }

  async function getMessage(id: string, fmt: { format: 'metadata' | 'full' }): Promise<NormalizedMessage> {
    const params: [string, string][] = [['format', fmt.format]]
    if (fmt.format === 'metadata') {
      for (const header of METADATA_HEADERS) params.push(['metadataHeaders', header])
    }
    const raw = (await request('GET', `/messages/${encodeURIComponent(id)}`, params, 'getMessage')) as RawGmailMessage
    return normalizeGmailMessage(raw, fmt.format)
  }

  async function getThreadMessageIds(threadId: string): Promise<{ id: string }[]> {
    const raw = (await request('GET', `/threads/${encodeURIComponent(threadId)}`, [['format', 'minimal']], 'other')) as {
      messages?: { id: string }[]
    }
    return (raw.messages ?? []).map((m) => ({ id: m.id }))
  }

  return {
    async profile() {
      const raw = (await request('GET', '/profile', [], 'other')) as { emailAddress: string; historyId: string }
      return { emailAddress: raw.emailAddress.toLowerCase(), cursor: { historyId: raw.historyId } }
    },

    async listChanges(cursor, pageToken) {
      const c = cursor as { historyId?: string } | null | undefined
      const params: [string, string][] = [['startHistoryId', c?.historyId ?? '0']]
      if (pageToken) params.push(['pageToken', pageToken])

      const raw = (await request('GET', '/history', params, 'listChanges')) as {
        history?: RawHistoryRecord[]
        nextPageToken?: string
      }

      // The `newCursor` (max BigInt record id) is computed by the sync walk, not this client — it
      // needs to see every drained page first, which this single call cannot know it is.
      const records: ChangeRecord[] = (raw.history ?? []).map((r) => ({
        id: r.id,
        messageIds: (r.messagesAdded ?? []).map((m) => ({ id: m.message.id, threadId: m.message.threadId })),
      }))
      const result: ListChangesResult = { records, nextPageToken: raw.nextPageToken }
      return result
    },

    async listMessagesForResync(addresses, sinceDays, pageToken) {
      const addressTerms = addresses.flatMap((a) => [`to:${a}`, `cc:${a}`, `deliveredto:${a}`])
      const q = `(${addressTerms.join(' OR ')}) newer_than:${sinceDays}d`
      const params: [string, string][] = [
        ['q', q],
        ['includeSpamTrash', 'true'],
      ]
      if (pageToken) params.push(['pageToken', pageToken])

      const raw = (await request('GET', '/messages', params, 'other')) as {
        messages?: { id: string; threadId: string }[]
        nextPageToken?: string
      }
      return { ids: (raw.messages ?? []).map((m) => ({ id: m.id, threadId: m.threadId })), nextPageToken: raw.nextPageToken }
    },

    getThreadMessageIds,
    getMessage,

    async sendReply(r) {
      const raw = buildReplyRaw({
        from: r.from ?? selfAddress,
        to: r.to,
        subject: r.subject,
        inReplyTo: r.inReplyTo,
        references: r.references,
        bodyText: r.bodyText,
        extraHeaders: r.extraHeaders,
      })
      const result = (await request('POST', '/messages/send', [], 'send', { raw, threadId: r.threadId })) as {
        id: string
        threadId: string
      }
      return { id: result.id, threadId: result.threadId }
    },

    async subscribe(input) {
      // Whole-mailbox watch, deliberately WITHOUT a labelIds filter — SENT-folder events are how
      // the sync walk detects the owner's own hand-sent replies, so restricting the watch to INBOX
      // (the naive choice) would silently blind it to that signal.
      const result = (await request('POST', '/watch', [], 'other', { topicName: input.topicOrUrl })) as {
        historyId: string
        expiration: string
      }
      return { subscriptionId: input.topicOrUrl, expiresAt: new Date(Number(result.expiration)) }
    },

    async renewSubscription(subscriptionId) {
      // Gmail has no distinct "renew" call — re-issuing `watch` extends the expiration in place.
      const result = (await request('POST', '/watch', [], 'other', { topicName: subscriptionId })) as {
        historyId: string
        expiration: string
      }
      return { subscriptionId, expiresAt: new Date(Number(result.expiration)) }
    },

    async unsubscribe() {
      await request('POST', '/stop', [], 'other')
    },

    async findSentByMarker(threadId, draftId, scanLimit) {
      const ids = await getThreadMessageIds(threadId)
      // Gmail hands back thread messages oldest-first; newest-first is what a recovery scan wants
      // to bound its work against the most likely candidates first.
      const newestFirst = [...ids].reverse()
      const examined = newestFirst.slice(0, scanLimit)

      for (const { id } of examined) {
        let msg: NormalizedMessage
        try {
          msg = await getMessage(id, { format: 'metadata' })
        } catch (err) {
          if (err instanceof MessageGoneError) continue
          throw err
        }
        if (msg.markerDraftId === draftId) return msg.id
      }

      // A miss that still has unexamined older candidates could be hiding the real sent copy —
      // returning null there risks a duplicate send. Only an exhaustive scan may return null.
      if (newestFirst.length > scanLimit) {
        throw new MailApiError('thread too busy', 429)
      }
      return null
    },
  }
}
