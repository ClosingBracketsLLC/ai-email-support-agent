/**
 * Microsoft Graph `MailboxClient`. New code — there is no doge-buddy reference for Graph — but it
 * mirrors `../gmail/client.ts`'s structure deliberately: a single `request()` entry point owning
 * the error taxonomy and jittered-retry discipline, and the same `Endpoint` type whose sole job is
 * excluding `'send'` from the 5xx/timeout retry (a transport failure on the `/send` POST is not
 * proof Graph never queued it — see the Gmail client's `Endpoint` comment, ported verbatim below).
 * Task 9's controller ruling ("a refused request queues nothing") means the 429 retry path is
 * NOT given that same exclusion — a 429 means Graph never even accepted the request.
 *
 * Three things Graph needs that Gmail didn't:
 *   - Every request carries `Prefer: IdType="ImmutableId"` (spec — ids survive folder moves).
 *   - Delta sync is PER-FOLDER (inbox/sentitems/junkemail), and each folder's continuation token is
 *     an opaque server-issued URL (`@odata.nextLink`/`@odata.deltaLink`), not a small integer like
 *     Gmail's `historyId`. `request()` therefore accepts either a path (built against `GRAPH_ROOT`)
 *     or an already-absolute URL, so `listChanges` can re-fetch a `nextLink`/`deltaLink` verbatim
 *     without reconstructing it.
 *   - `parentFolderId` -> label requires a well-known-folder-id lookup, fetched once per client and
 *     cached (a plain memoized promise in this closure, not exported).
 */
import { CursorExpiredError, MailApiError, MessageGoneError, ProviderAuthError, ProviderRateLimitError } from '../../errors.ts'
import { MARKER_HEADER, type ChangeRecord, type ListChangesResult, type MailboxClient, type NormalizedMessage } from '../../types.ts'
import { FOLDER_KEYS, FOLDER_LABELS, GET_MESSAGE_SELECT_FIELDS, normalizeGraphMessage, type FolderKey, type RawGraphMessage } from './map.ts'

const GRAPH_ROOT = 'https://graph.microsoft.com/v1.0'

/** Ids survive folder moves under this preference (spec) — every request carries it. */
const PREFER_IMMUTABLE_ID = 'IdType="ImmutableId"'

/**
 * `send` is its own endpoint kind purely so the retry logic can EXCLUDE it from the 5xx/timeout
 * retry (ported rationale from the Gmail client): a transport-level failure on the two-phase
 * send's final `/send` POST does not mean Graph failed to queue the message — it means we stopped
 * waiting for the answer. An HTTP-layer retry there can put two copies in the customer's inbox,
 * and `X-Aesa-Draft` cannot detect or undo that (the crash-recovery scan, `findSentByMarker`, IS
 * the send's retry layer — it re-reads the thread first, so it can tell "already sent" from
 * "never sent"; this layer cannot, so it never guesses). The 429 path has NO such exclusion
 * (Task 9's ruling: a refused request queues nothing, so retrying it cannot double-send).
 */
type Endpoint = 'listChanges' | 'getMessage' | 'send' | 'other'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 200ms base + up to 400ms of jitter — same budget as the Gmail client. */
function jitterDelayMs(): number {
  return 200 + Math.random() * 400
}

/** Every request gets its own hard timeout, well under any caller's own job-level deadline. */
const REQUEST_TIMEOUT_MS = 20_000

/** `AbortSignal.timeout()` rejects with a DOMException named 'TimeoutError' (NOT 'AbortError') —
 * the only abort reason this client itself can produce, since it never accepts a caller signal on
 * ordinary requests. Any other error name is unknown and propagates untouched. */
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

interface GraphErrorBody {
  error?: { code?: string; message?: string }
}

/** `Retry-After` on a 429 is seconds for Graph too — absent or non-numeric maps to `null` rather
 * than guessing a value. */
function parseRetryAfterMs(header: string | null): number | null {
  if (header === null) return null
  const seconds = Number(header)
  if (!Number.isFinite(seconds) || seconds < 0) return null
  return seconds * 1000
}

/** Graph's push-subscription max lifetime for the `/me/messages` resource (spec + brief): 4230
 * minutes, expressed here in ms so callers just add it to `Date.now()`. */
const SUBSCRIPTION_DURATION_MS = 4230 * 60 * 1000

/** Opaque `listChanges` continuation state, JSON-encoded into `nextPageToken` — the sync walk
 * (Task 11) treats it as an opaque string, same contract as Gmail's `pageToken`. */
interface GraphListChangesState {
  folderIndex: number
  /** Set once this folder's first page has already been fetched (its own `@odata.nextLink`);
   * absent means "start this folder from its primed/updated delta token in the cursor". */
  nextUrl?: string
  /** Deltalinks already captured for folders drained earlier in this same walk — carried forward
   * so the FINAL folder's drain can assemble the complete `newCursor.deltaTokens` map. */
  doneTokens: Partial<Record<FolderKey, string>>
}

function encodeState(s: GraphListChangesState): string {
  return JSON.stringify(s)
}

function decodeState(token: string): GraphListChangesState {
  return JSON.parse(token) as GraphListChangesState
}

export interface CreateGraphClientOptions {
  accessToken: string
  /** Stamped as `from` on `sendReply`'s PATCH unless the input overrides it. */
  selfAddress: string
  fetchFn?: typeof fetch
}

export function createGraphClient(opts: CreateGraphClientOptions): MailboxClient {
  const { accessToken, selfAddress, fetchFn = globalThis.fetch } = opts

  /** Memoized folder-id -> label lookup, fetched once per client instance by resolving each of
   * the three well-known folders individually by ALIAS (`/me/mailFolders/{inbox|sentitems|
   * junkemail}`) — see `getFolderIdMap` below for why this replaced an earlier displayName-based
   * listing. */
  let folderIdMapPromise: Promise<Map<string, FolderKey>> | null = null

  /**
   * Single HTTP entry point implementing the full error taxonomy:
   *   - 401              -> ProviderAuthError, no retry (the worker's refresh loop owns it)
   *   - 429               -> one jittered retry, then ProviderRateLimitError honouring Retry-After
   *   - 5xx / timeout     -> one jittered retry (except 'send'), then MailApiError
   *   - 404 / 410 on 'listChanges' -> CursorExpiredError (syncStateNotFound / resync required)
   *   - 404 on 'getMessage'        -> MessageGoneError
   * `pathOrUrl` is either a path appended to `GRAPH_ROOT`, or an already-absolute URL (a Graph
   * `@odata.nextLink`/`@odata.deltaLink`, or a subscription's self-link) — used verbatim either
   * way, matching Graph's own guidance to never reconstruct a continuation URL by hand.
   */
  async function request(method: string, pathOrUrl: string, params: [string, string][], endpoint: Endpoint, body?: unknown): Promise<unknown> {
    const url = pathOrUrl.startsWith('http') ? new URL(pathOrUrl) : new URL(GRAPH_ROOT + pathOrUrl)
    for (const [key, value] of params) url.searchParams.append(key, value)

    let attemptedRateRetry = false
    let attemptedServerRetry = false

    for (;;) {
      const init: RequestInit = {
        method,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Prefer: PREFER_IMMUTABLE_ID,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }

      let res: Response
      try {
        res = await fetchFn(url, init)
      } catch (err) {
        if (isTimeoutError(err) && !attemptedServerRetry && endpoint !== 'send') {
          attemptedServerRetry = true
          await sleep(jitterDelayMs())
          continue
        }
        if (isTimeoutError(err)) {
          throw new MailApiError('Graph API request timed out', 0, 'timeout')
        }
        throw err
      }

      if (res.ok) {
        if (res.status === 204) return undefined
        const text = await res.text()
        return text.length > 0 ? JSON.parse(text) : undefined
      }

      const errBody = (await safeJson(res)) as GraphErrorBody | null
      const code = errBody?.error?.code ?? null
      const status = res.status

      if (status === 401) {
        throw new ProviderAuthError(errBody?.error?.message ?? 'Graph access token was rejected')
      }

      if (status === 429) {
        if (!attemptedRateRetry) {
          attemptedRateRetry = true
          await sleep(jitterDelayMs())
          continue
        }
        const retryAfterMs = parseRetryAfterMs(res.headers.get('Retry-After'))
        throw new ProviderRateLimitError(errBody?.error?.message ?? 'Graph API rate limit exceeded', retryAfterMs)
      }

      if (status >= 500 && status < 600) {
        if (!attemptedServerRetry && endpoint !== 'send') {
          attemptedServerRetry = true
          await sleep(jitterDelayMs())
          continue
        }
        throw new MailApiError(errBody?.error?.message ?? `Graph API server error (${status})`, status, code ?? undefined)
      }

      // Graph signals an expired/invalid delta cursor as 404 (code `SyncStateNotFound`) or 410
      // (resync required) — either status maps to CursorExpiredError on the delta endpoint.
      if (endpoint === 'listChanges' && (status === 404 || status === 410)) throw new CursorExpiredError()
      if (status === 404 && endpoint === 'getMessage') throw new MessageGoneError()

      throw new MailApiError(errBody?.error?.message ?? `Graph API error (${status})`, status, code ?? undefined)
    }
  }

  /**
   * Resolves each of the three well-known folders by its Graph ALIAS
   * (`/me/mailFolders/{inbox|sentitems|junkemail}` — a fixed, locale-independent path segment
   * Graph itself resolves, not a display name) rather than listing `/me/mailFolders` and matching
   * on `displayName`. Two problems with the displayName approach this replaces: (1) `displayName`
   * is LOCALIZED — a German or Japanese mailbox's Inbox is not named "Inbox", so every message in
   * a non-English-locale mailbox silently resolved to `labelIds: []` (breaking SENT/JUNK
   * detection — direction and spam flagging); (2) `/me/mailFolders` is Graph's TOP-LEVEL folder
   * listing, itself paginated (`@odata.nextLink`) with no pagination handled here, so a mailbox
   * with enough top-level folders to spill past the first page could drop a tracked folder even in
   * an English-locale mailbox. Three individual by-alias GETs sidesteps both: no displayName
   * comparison, no listing to paginate.
   */
  async function getFolderIdMap(): Promise<Map<string, FolderKey>> {
    if (!folderIdMapPromise) {
      folderIdMapPromise = (async () => {
        const map = new Map<string, FolderKey>()
        for (const folder of FOLDER_KEYS) {
          const raw = (await request('GET', `/me/mailFolders/${folder}`, [['$select', 'id']], 'other')) as { id: string }
          map.set(raw.id, folder)
        }
        return map
      })()
    }
    return folderIdMapPromise
  }

  async function getMessage(id: string, opts: { format: 'metadata' | 'full' }): Promise<NormalizedMessage> {
    const fields: string[] = [...GET_MESSAGE_SELECT_FIELDS]
    const params: [string, string][] = []
    if (opts.format === 'full') {
      fields.push('body')
      params.push(['$expand', 'attachments($select=name,contentType,size)'])
    }
    params.unshift(['$select', fields.join(',')])

    const raw = (await request('GET', `/me/messages/${encodeURIComponent(id)}`, params, 'getMessage')) as RawGraphMessage

    const folderMap = await getFolderIdMap()
    const folderKey = raw.parentFolderId ? folderMap.get(raw.parentFolderId) : undefined
    const folderLabel = folderKey ? FOLDER_LABELS[folderKey] : []

    return normalizeGraphMessage(raw, opts.format, folderLabel)
  }

  return {
    async profile() {
      const me = (await request('GET', '/me', [['$select', 'mail,userPrincipalName']], 'other')) as {
        mail?: string | null
        userPrincipalName?: string
      }
      const emailAddress = (me.mail ?? me.userPrincipalName ?? '').toLowerCase()

      // Prime each folder's delta cursor to "now" — `$deltatoken=latest` returns a deltaLink with
      // NO items, matching Gmail's seed-on-null semantics (first sync must not backfill).
      const deltaTokens: Record<string, string> = {}
      for (const folder of FOLDER_KEYS) {
        const raw = (await request(
          'GET',
          `/me/mailFolders/${folder}/messages/delta`,
          [
            ['$deltatoken', 'latest'],
            ['$select', 'id,conversationId'],
          ],
          'other',
        )) as { '@odata.deltaLink'?: string }
        const deltaLink = raw['@odata.deltaLink']
        if (!deltaLink) {
          throw new MailApiError(`Graph delta priming for folder "${folder}" returned no deltaLink`, 0, 'missingDeltaLink')
        }
        deltaTokens[folder] = deltaLink
      }

      return { emailAddress, cursor: { deltaTokens } }
    },

    async listChanges(cursor, pageToken) {
      const c = cursor as { deltaTokens?: Record<string, string> } | null | undefined
      const state: GraphListChangesState = pageToken ? decodeState(pageToken) : { folderIndex: 0, doneTokens: {} }
      const folder = FOLDER_KEYS[state.folderIndex]
      if (!folder) {
        throw new MailApiError('Graph listChanges: pageToken folderIndex out of range', 0, 'invalidPageToken')
      }

      const requestUrl = state.nextUrl ?? c?.deltaTokens?.[folder]
      if (!requestUrl) {
        throw new MailApiError(`Graph listChanges: no delta token for folder "${folder}" — call profile() first`, 0, 'missingDeltaToken')
      }

      const raw = (await request('GET', requestUrl, [], 'listChanges')) as {
        value?: { id: string; conversationId?: string }[]
        '@odata.nextLink'?: string
        '@odata.deltaLink'?: string
      }

      const records: ChangeRecord[] = (raw.value ?? []).map((item) => ({
        id: item.id,
        // A Graph delta item without a conversationId is a `@removed` (deletion) marker — this
        // product only cares about messages that still exist, so it maps to an empty messageIds
        // list rather than a fabricated threadId (mirrors Gmail's label-change records, which
        // carry the same shape for "nothing a sync walk needs to ingest").
        messageIds: item.conversationId ? [{ id: item.id, threadId: item.conversationId }] : [],
      }))

      const nextLink = raw['@odata.nextLink']
      if (nextLink) {
        const result: ListChangesResult = {
          records,
          nextPageToken: encodeState({ folderIndex: state.folderIndex, nextUrl: nextLink, doneTokens: state.doneTokens }),
        }
        return result
      }

      const deltaLink = raw['@odata.deltaLink']
      if (!deltaLink) {
        throw new MailApiError(`Graph listChanges: folder "${folder}" drained with neither nextLink nor deltaLink`, 0, 'missingDeltaLink')
      }
      const doneTokens: Partial<Record<FolderKey, string>> = { ...state.doneTokens, [folder]: deltaLink }

      const nextFolderIndex = state.folderIndex + 1
      const nextFolder = FOLDER_KEYS[nextFolderIndex]
      if (!nextFolder) {
        // Last folder drained — every folder's deltaLink is now in `doneTokens`.
        const result: ListChangesResult = { records, newCursor: { deltaTokens: doneTokens } }
        return result
      }
      const result: ListChangesResult = { records, nextPageToken: encodeState({ folderIndex: nextFolderIndex, doneTokens }) }
      return result
    },

    async listMessagesForResync(_addresses, sinceDays, pageToken) {
      if (pageToken) {
        const raw = (await request('GET', pageToken, [], 'other')) as { value?: { id: string; conversationId?: string }[]; '@odata.nextLink'?: string }
        return {
          ids: (raw.value ?? []).map((m) => ({ id: m.id, threadId: m.conversationId ?? '' })),
          nextPageToken: raw['@odata.nextLink'],
        }
      }
      // Address filtering happens later in the sync walk (brief, Task 10) — this query is
      // date-only, matching the brief's literal request shape.
      const sinceIso = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString()
      const raw = (await request(
        'GET',
        '/me/messages',
        [
          ['$filter', `receivedDateTime ge ${sinceIso}`],
          ['$select', 'id,conversationId'],
          ['$top', '50'],
        ],
        'other',
      )) as { value?: { id: string; conversationId?: string }[]; '@odata.nextLink'?: string }
      return {
        ids: (raw.value ?? []).map((m) => ({ id: m.id, threadId: m.conversationId ?? '' })),
        nextPageToken: raw['@odata.nextLink'],
      }
    },

    async getThreadMessageIds(threadId) {
      const ids: { id: string }[] = []
      let url: string | null = null
      let params: [string, string][] = [
        ['$filter', `conversationId eq '${threadId}'`],
        ['$select', 'id'],
      ]
      for (;;) {
        const raw = (await request('GET', url ?? '/me/messages', url ? [] : params, 'other')) as {
          value?: { id: string }[]
          '@odata.nextLink'?: string
        }
        for (const m of raw.value ?? []) ids.push({ id: m.id })
        if (!raw['@odata.nextLink']) break
        url = raw['@odata.nextLink']
        params = []
      }
      return ids
    },

    getMessage,

    async sendReply(r) {
      let draftId: string
      let threadId: string

      if (r.existingDraftId) {
        // Crash re-entry: the draft was already created (possibly already sent) by an earlier,
        // interrupted attempt. Read it back FIRST — `isDraft === false` means it already went
        // out, so this call must return without sending a second copy.
        const existing = (await request(
          'GET',
          `/me/messages/${encodeURIComponent(r.existingDraftId)}`,
          [['$select', 'isDraft,conversationId']],
          'other',
        )) as { isDraft?: boolean; conversationId: string }
        if (existing.isDraft === false) {
          return { id: r.existingDraftId, threadId: existing.conversationId, providerDraftId: r.existingDraftId }
        }
        draftId = r.existingDraftId
        threadId = existing.conversationId
      } else {
        if (!r.replyToProviderMessageId) {
          throw new MailApiError('replyToProviderMessageId required', 400)
        }
        // `createReply` is the only Graph call that sets the threading headers (In-Reply-To,
        // References, subject's Re: prefix) — this is why the send is two-phase at all.
        const created = (await request(
          'POST',
          `/me/messages/${encodeURIComponent(r.replyToProviderMessageId)}/createReply`,
          [],
          'other',
        )) as { id: string; conversationId: string }
        draftId = created.id
        threadId = created.conversationId
        // Persist BEFORE the PATCH/send below — a crash after this point is recoverable through
        // `existingDraftId` (the re-entry branch above). A throw here aborts the send outright;
        // it is never called on the re-entry path itself, since there is nothing new to persist.
        await r.onDraftCreated?.(created.id)
      }

      const markerValue = r.extraHeaders?.[MARKER_HEADER]
      const patchBody: Record<string, unknown> = {
        body: { contentType: 'text', content: r.bodyText },
        // `r.from` overrides; otherwise this stamps the mailbox's own address, exactly like the
        // Gmail client's `from: r.from ?? selfAddress` (`buildReplyRaw`'s `from` argument).
        from: { emailAddress: { address: r.from ?? selfAddress } },
        // Stamps the crash-recovery marker as a genuine custom internet header via Graph's
        // singleValueLegacyExtendedProperty mechanism (PS_INTERNET_HEADERS namespace,
        // `{00020386-0000-0000-C000-000000000046}` — see this task's report for why the GUID here
        // differs from the brief's own example). `findSentByMarker` below reads it back off
        // `internetMessageHeaders` exactly like any other transport header.
        ...(markerValue !== undefined
          ? { singleValueExtendedProperties: [{ id: `String {00020386-0000-0000-C000-000000000046} Name ${MARKER_HEADER}`, value: markerValue }] }
          : {}),
      }
      await request('PATCH', `/me/messages/${encodeURIComponent(draftId)}`, [], 'other', patchBody)

      // The final `/send` POST is the one call excluded from the 5xx/timeout retry (`Endpoint`
      // comment above) — a transport failure here cannot be told apart from "Graph already sent
      // it", so `findSentByMarker` (crash recovery) is this call's only retry path.
      await request('POST', `/me/messages/${encodeURIComponent(draftId)}/send`, [], 'send')

      // No read-back here — deliberate divergence from the brief's older prose ("read back the
      // sent copy for internetMessageId"); see the report for the controller-ruling precedent
      // (Task 9) this follows. `MailboxClient.sendReply` returns `{id, threadId,
      // providerDraftId?}`, not a `NormalizedMessage`, so there is nowhere to put a read-back's
      // extra fields even if one were performed.
      return { id: draftId, threadId, providerDraftId: draftId }
    },

    async subscribe(input) {
      const expirationDateTime = new Date(Date.now() + SUBSCRIPTION_DURATION_MS).toISOString()
      const result = (await request('POST', '/subscriptions', [], 'other', {
        changeType: 'created',
        notificationUrl: input.topicOrUrl,
        resource: '/me/messages',
        expirationDateTime,
        ...(input.clientState ? { clientState: input.clientState } : {}),
      })) as { id: string; expirationDateTime: string }
      return { subscriptionId: result.id, expiresAt: new Date(result.expirationDateTime) }
    },

    async renewSubscription(subscriptionId, expiresAt) {
      const expirationDateTime = (expiresAt ?? new Date(Date.now() + SUBSCRIPTION_DURATION_MS)).toISOString()
      const result = (await request('PATCH', `/subscriptions/${encodeURIComponent(subscriptionId)}`, [], 'other', {
        expirationDateTime,
      })) as { id: string; expirationDateTime: string }
      return { subscriptionId: result.id, expiresAt: new Date(result.expirationDateTime) }
    },

    async unsubscribe(subscriptionId) {
      await request('DELETE', `/subscriptions/${encodeURIComponent(subscriptionId)}`, [], 'other')
    },

    async findSentByMarker(threadId, draftId, scanLimit) {
      let examined = 0
      let url: string | null = null
      let params: [string, string][] = [
        ['$filter', `conversationId eq '${threadId}'`],
        ['$select', 'id,internetMessageHeaders'],
        ['$orderby', 'receivedDateTime desc'],
      ]

      for (;;) {
        const raw = (await request('GET', url ?? '/me/messages', url ? [] : params, 'other')) as {
          value?: { id: string; internetMessageHeaders?: { name: string; value: string }[] }[]
          '@odata.nextLink'?: string
        }

        for (const item of raw.value ?? []) {
          if (examined >= scanLimit) {
            // A miss that still has unexamined older candidates could be hiding the real sent
            // copy — returning null there risks a duplicate send. Only an exhaustive scan may.
            throw new MailApiError('thread too busy', 429)
          }
          examined += 1
          const marker = item.internetMessageHeaders?.find((h) => h.name.toLowerCase() === MARKER_HEADER.toLowerCase())?.value
          if (marker === draftId) return item.id
        }

        if (!raw['@odata.nextLink']) return null
        url = raw['@odata.nextLink']
        params = []
      }
    },
  }
}
