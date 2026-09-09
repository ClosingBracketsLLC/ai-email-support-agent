import { convert } from 'html-to-text'
import { decode as iconvDecode, encodingExists as iconvEncodingExists } from 'iconv-lite'

/** Minimal shape of a Gmail API MIME part header — enough to read Content-Type. */
interface MimeHeader {
  name?: string
  value?: string
}

/** Minimal shape of a Gmail API MIME part — enough to walk the tree. */
interface MimePart {
  mimeType?: string
  headers?: MimeHeader[]
  body?: { data?: string; attachmentId?: string; size?: number }
  parts?: MimePart[]
}

function isMimePart(value: unknown): value is MimePart {
  return typeof value === 'object' && value !== null
}

/**
 * Depth-first search for the first leaf part whose mimeType matches and whose
 * body carries inline `data`. A part carrying only an `attachmentId` (no
 * `data`) is never a match — attachments are skipped entirely, not just
 * de-prioritized.
 */
function findFirstLeaf(node: MimePart, mimeType: string): MimePart | null {
  if (Array.isArray(node.parts) && node.parts.length > 0) {
    for (const child of node.parts) {
      if (!isMimePart(child)) continue
      const found = findFirstLeaf(child, mimeType)
      if (found) return found
    }
    return null
  }

  // Leaf node (no sub-parts).
  if (node.body?.attachmentId && !node.body.data) return null // attachment-only — skip
  if (node.mimeType === mimeType && typeof node.body?.data === 'string' && node.body.data.length > 0) {
    return node
  }
  return null
}

/** Reads the part's own Content-Type header value (not its `mimeType` field), for charset parsing. */
function contentTypeHeaderOf(node: MimePart): string | null {
  const header = node.headers?.find((h) => h.name?.toLowerCase() === 'content-type')
  return header?.value ?? null
}

const CHARSET_RE = /charset="?([\w.-]+)"?/i

/**
 * Decodes a Gmail-style base64url part body, honouring the charset declared on the part's
 * Content-Type header. Falls back to utf-8 when no charset is present or iconv-lite doesn't
 * recognize it — the reference implementation this was ported from had no charset handling at
 * all, which mojibake'd every non-UTF-8 inbound message.
 */
export function decodePartBytes(dataBase64Url: string, contentTypeHeader: string | null): string {
  const buffer = Buffer.from(dataBase64Url, 'base64url')
  const charset = contentTypeHeader?.match(CHARSET_RE)?.[1]
  if (charset && iconvEncodingExists(charset)) {
    return iconvDecode(buffer, charset)
  }
  return buffer.toString('utf8')
}

/** Converts an HTML body to plain text: images and scripts/styles dropped, links kept inline. */
export function htmlToPlainText(html: string): string {
  return convert(html, {
    wordwrap: false,
    selectors: [
      { selector: 'img', format: 'skip' },
      { selector: 'a', options: { ignoreHref: false } },
    ],
  })
}

/**
 * Extract the best available plain-text body from a Gmail API message
 * `payload`, per the priority order:
 *   1. first `text/plain` leaf with `body.data` (depth-first)
 *   2. else first `text/html` leaf with `body.data`, converted to plain text
 *   3. else the top-level `payload.body.data` (single-part messages)
 *   4. else null
 * Parts carrying only an `attachmentId` are ignored at every level. Every leaf's bytes are
 * decoded through `decodePartBytes`, honouring that part's own Content-Type charset.
 */
export function extractBodyText(payload: unknown): string | null {
  if (!isMimePart(payload)) return null

  const plainLeaf = findFirstLeaf(payload, 'text/plain')
  if (plainLeaf?.body?.data) return decodePartBytes(plainLeaf.body.data, contentTypeHeaderOf(plainLeaf))

  const htmlLeaf = findFirstLeaf(payload, 'text/html')
  if (htmlLeaf?.body?.data) {
    return htmlToPlainText(decodePartBytes(htmlLeaf.body.data, contentTypeHeaderOf(htmlLeaf)))
  }

  if (typeof payload.body?.data === 'string' && payload.body.data.length > 0) {
    return decodePartBytes(payload.body.data, contentTypeHeaderOf(payload))
  }

  return null
}
