/**
 * Gmail wire-shape → `NormalizedMessage`. Ported from doge-buddy `packages/gmail/src/client.ts`'s
 * `normalizeMessage` + `METADATA_HEADERS`, extended for this port's automated-mail fields
 * (`Auto-Submitted`/`Precedence`/`List-Id`) and its `MARKER_HEADER` instead of doge-buddy's
 * `PROPOSAL_MARKER_HEADER`.
 */
import { parseAddrSpecs, parseFirstAddrSpec } from '../../address.ts'
import { extractBodyText } from '../../body.ts'
import { scrubCardNumbers } from '../../scrub.ts'
import { tokenizeReferences } from '../../threading.ts'
import { MARKER_HEADER, type NormalizedMessage } from '../../types.ts'

/**
 * Order is significant on the wire (repeated `metadataHeaders` query params) — a metadata fetch
 * returns ONLY the headers named here. `MARKER_HEADER` (`X-Aesa-Draft`) MUST be on this list or
 * the send-recovery scan (`findSentByMarker`) would always read `markerDraftId: null` on the exact
 * fetch that exists to read it; `Auto-Submitted`/`Precedence`/`List-Id` feed `detectAutomated`.
 */
export const METADATA_HEADERS = [
  'From',
  'To',
  'Cc',
  'Delivered-To',
  'Subject',
  'Message-ID',
  'In-Reply-To',
  'References',
  'Authentication-Results',
  'Auto-Submitted',
  'Precedence',
  'List-Id',
  MARKER_HEADER,
] as const

export interface GmailHeader {
  name: string
  value: string
}

/** Minimal shape of a Gmail API MIME part — enough to walk headers, body and attachments. */
export interface GmailMessagePayload {
  mimeType?: string
  filename?: string
  headers?: GmailHeader[]
  body?: { data?: string; attachmentId?: string; size?: number }
  parts?: GmailMessagePayload[]
}

export interface RawGmailMessage {
  id: string
  threadId: string
  labelIds?: string[]
  internalDate?: string
  payload?: GmailMessagePayload
}

function headerValues(headers: GmailHeader[] | undefined, name: string): string[] {
  if (!headers) return []
  const lower = name.toLowerCase()
  return headers.filter((h) => h.name.toLowerCase() === lower).map((h) => h.value)
}

/** The topmost (first-occurrence) value — Gmail's own stamp on repeated headers like
 * `Authentication-Results` always comes first; a later hop's re-stamp must not win. */
function firstHeader(headers: GmailHeader[] | undefined, name: string): string | null {
  const [value] = headerValues(headers, name)
  return value ?? null
}

/** Delivered-To (and, defensively, any other address header) can repeat — collect ALL occurrences. */
function addrListFromHeaders(headers: GmailHeader[] | undefined, name: string): string[] {
  const values = headerValues(headers, name)
  if (values.length === 0) return []
  return parseAddrSpecs(values.join(', '))
}

/** Depth-first walk collecting every leaf part that carries `body.attachmentId` — filename/mime/size
 * only, never the content. A part can carry both `attachmentId` and inline `data` (rare); it is
 * still an attachment for this purpose regardless of what `extractBodyText` does with it. */
function collectAttachments(
  node: GmailMessagePayload,
): { filename: string | null; mime: string | null; size: number | null }[] {
  const results: { filename: string | null; mime: string | null; size: number | null }[] = []

  function walk(part: GmailMessagePayload): void {
    if (part.body?.attachmentId) {
      results.push({
        filename: part.filename && part.filename.length > 0 ? part.filename : null,
        mime: part.mimeType ?? null,
        size: part.body.size ?? null,
      })
    }
    if (Array.isArray(part.parts)) {
      for (const child of part.parts) walk(child)
    }
  }

  walk(node)
  return results
}

export function normalizeGmailMessage(raw: RawGmailMessage, format: 'metadata' | 'full'): NormalizedMessage {
  const headers = raw.payload?.headers
  const fromRaw = firstHeader(headers, 'From')
  const rawBodyText = format === 'metadata' ? null : extractBodyText(raw.payload)
  const attachments = raw.payload ? collectAttachments(raw.payload) : []

  return {
    id: raw.id,
    threadId: raw.threadId,
    fromAddr: parseFirstAddrSpec(fromRaw),
    toAddrs: addrListFromHeaders(headers, 'To'),
    ccAddrs: addrListFromHeaders(headers, 'Cc'),
    deliveredTo: addrListFromHeaders(headers, 'Delivered-To'),
    subject: firstHeader(headers, 'Subject'),
    rfcMessageId: firstHeader(headers, 'Message-ID'),
    inReplyTo: firstHeader(headers, 'In-Reply-To'),
    references: tokenizeReferences(firstHeader(headers, 'References')),
    // The topmost Authentication-Results header is Gmail's own stamp (each hop that adds one
    // prepends it) — firstHeader already returns the first/topmost occurrence.
    authenticationResults: firstHeader(headers, 'Authentication-Results'),
    autoSubmitted: firstHeader(headers, 'Auto-Submitted'),
    precedence: firstHeader(headers, 'Precedence'),
    listId: firstHeader(headers, 'List-Id'),
    internalDate: new Date(Number(raw.internalDate ?? 0)),
    labelIds: raw.labelIds ?? [],
    // format:'metadata' never carries body content — rawBodyText is already null in that case.
    // Card scrubbing only ever has real text to scrub on format:'full'.
    bodyText: rawBodyText === null ? null : scrubCardNumbers(rawBodyText),
    hasAttachments: attachments.length > 0,
    attachments,
    // Send-recovery marker (MARKER_HEADER doc comment). Exposed on both formats since it is on
    // METADATA_HEADERS — the recovery scan reads it via a metadata-only fetch.
    markerDraftId: firstHeader(headers, MARKER_HEADER),
  }
}
