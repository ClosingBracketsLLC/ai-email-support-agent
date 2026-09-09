/**
 * Microsoft Graph wire-shape -> `NormalizedMessage`. New code (no doge-buddy reference — Graph is
 * new for this product). Unlike Gmail, Graph hands back STRUCTURED recipients
 * (`from.emailAddress.address`, `toRecipients[].emailAddress.address`, ...) so there is no
 * addr-spec parsing for those fields — just lowercasing. `Delivered-To` has no structured Graph
 * property at all; it only exists (if present) inside `internetMessageHeaders`, so it is read the
 * same way Gmail reads it: via the raw header list + `parseAddrSpecs`.
 */
import { parseAddrSpecs } from '../../address.ts'
import { htmlToPlainText } from '../../body.ts'
import { scrubCardNumbers } from '../../scrub.ts'
import { tokenizeReferences } from '../../threading.ts'
import { MARKER_HEADER, type NormalizedMessage } from '../../types.ts'

/** The three folders the sync walk polls (spec §Mailbox providers -> Microsoft 365). Order is
 * significant: `listChanges`' per-call folder walk advances through this array in order, and
 * `newCursor` is only produced once the LAST folder (`junkemail`) has drained. */
export const FOLDER_KEYS = ['inbox', 'sentitems', 'junkemail'] as const
export type FolderKey = (typeof FOLDER_KEYS)[number]

/** Folder -> label mapping (brief, Task 10). `isDraft` overrides this entirely (mapped to
 * `['DRAFT']` by `normalizeGraphMessage`) so the sync walk's existing "skip drafts" rule fires
 * exactly as it does for Gmail's `DRAFT` label. */
export const FOLDER_LABELS: Record<FolderKey, string[]> = {
  inbox: ['INBOX'],
  sentitems: ['SENT'],
  junkemail: ['JUNK'],
}

/** `GET /me/mailFolders?$select=id,displayName` returns each top-level folder's real display
 * name — the well-known "special folder name" shortcuts (`inbox`/`sentitems`/`junkemail`, usable
 * in a path) are not what comes back on the LISTING call, so folder-id resolution goes through
 * this display-name table instead. */
export const DISPLAY_NAME_TO_FOLDER: Record<string, FolderKey> = {
  inbox: 'inbox',
  'sent items': 'sentitems',
  'junk email': 'junkemail',
}

/** Selected once per `getMessage` call (both formats select the same fields except `body`, which
 * `metadata` omits entirely per the brief — "$select WITHOUT body -> bodyText null"). */
export const GET_MESSAGE_SELECT_FIELDS = [
  'internetMessageHeaders',
  'from',
  'toRecipients',
  'ccRecipients',
  'subject',
  'conversationId',
  'receivedDateTime',
  'hasAttachments',
  'isDraft',
  'parentFolderId',
] as const

export interface GraphHeader {
  name: string
  value: string
}

export interface GraphRecipient {
  emailAddress?: { name?: string; address?: string }
}

export interface GraphAttachment {
  name?: string
  contentType?: string
  size?: number
}

/** Minimal shape of a Graph `message` resource — enough of `getMessage`'s `$select`+`$expand` to
 * normalize. `body` is present only on a `format:'full'` fetch (metadata's `$select` omits it). */
export interface RawGraphMessage {
  id: string
  conversationId: string
  subject?: string | null
  receivedDateTime?: string
  hasAttachments?: boolean
  isDraft?: boolean
  parentFolderId?: string | null
  from?: GraphRecipient | null
  toRecipients?: GraphRecipient[]
  ccRecipients?: GraphRecipient[]
  internetMessageHeaders?: GraphHeader[]
  body?: { contentType?: string; content?: string }
  attachments?: GraphAttachment[]
}

function headerValues(headers: GraphHeader[] | undefined, name: string): string[] {
  if (!headers) return []
  const lower = name.toLowerCase()
  return headers.filter((h) => h.name.toLowerCase() === lower).map((h) => h.value)
}

/** The topmost (first-occurrence) value — same convention as the Gmail adapter: a hop's own
 * Authentication-Results stamp is always prepended, so the FIRST occurrence is the one to trust. */
function firstHeader(headers: GraphHeader[] | undefined, name: string): string | null {
  const [value] = headerValues(headers, name)
  return value ?? null
}

/** `Delivered-To` can repeat; collect every occurrence (mirrors the Gmail adapter's `map.ts`). */
function addrListFromHeaders(headers: GraphHeader[] | undefined, name: string): string[] {
  const values = headerValues(headers, name)
  if (values.length === 0) return []
  return parseAddrSpecs(values.join(', '))
}

function recipientAddress(r: GraphRecipient | null | undefined): string | null {
  const address = r?.emailAddress?.address
  return address ? address.toLowerCase() : null
}

function recipientAddresses(rs: GraphRecipient[] | undefined): string[] {
  if (!rs) return []
  const addrs: string[] = []
  for (const r of rs) {
    const addr = recipientAddress(r)
    if (addr) addrs.push(addr)
  }
  return addrs
}

/** `body.contentType === 'html'` -> `htmlToPlainText`, else the content as-is; then
 * `scrubCardNumbers` either way (brief, Task 10). */
function bodyTextFrom(body: RawGraphMessage['body']): string | null {
  if (!body || typeof body.content !== 'string') return null
  const text = body.contentType === 'html' ? htmlToPlainText(body.content) : body.content
  return scrubCardNumbers(text)
}

/**
 * `folderLabel` is the label array the CALLER already resolved from `parentFolderId` via the
 * client's cached well-known-folder-id map (a client-level cache, not this module's concern — see
 * `client.ts`). `isDraft: true` overrides it to `['DRAFT']` regardless of which folder the draft
 * physically lives in, matching the brief's skip-rule requirement verbatim.
 */
export function normalizeGraphMessage(raw: RawGraphMessage, format: 'metadata' | 'full', folderLabel: string[]): NormalizedMessage {
  const headers = raw.internetMessageHeaders
  const rawBodyText = format === 'metadata' ? null : bodyTextFrom(raw.body)

  return {
    id: raw.id,
    threadId: raw.conversationId,
    fromAddr: recipientAddress(raw.from),
    toAddrs: recipientAddresses(raw.toRecipients),
    ccAddrs: recipientAddresses(raw.ccRecipients),
    deliveredTo: addrListFromHeaders(headers, 'Delivered-To'),
    subject: raw.subject ?? null,
    rfcMessageId: firstHeader(headers, 'Message-ID'),
    inReplyTo: firstHeader(headers, 'In-Reply-To'),
    references: tokenizeReferences(firstHeader(headers, 'References')),
    authenticationResults: firstHeader(headers, 'Authentication-Results'),
    autoSubmitted: firstHeader(headers, 'Auto-Submitted'),
    precedence: firstHeader(headers, 'Precedence'),
    listId: firstHeader(headers, 'List-Id'),
    internalDate: new Date(raw.receivedDateTime ?? 0),
    labelIds: raw.isDraft ? ['DRAFT'] : folderLabel,
    bodyText: rawBodyText,
    hasAttachments: raw.hasAttachments ?? false,
    attachments: (raw.attachments ?? []).map((a) => ({
      filename: a.name ?? null,
      mime: a.contentType ?? null,
      size: typeof a.size === 'number' ? a.size : null,
    })),
    markerDraftId: firstHeader(headers, MARKER_HEADER),
  }
}
