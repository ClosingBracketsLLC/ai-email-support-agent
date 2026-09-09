import { describe, expect, it } from 'vitest'
import { decodePartBytes, extractBodyText, htmlToPlainText } from '../src/body.ts'
import nested from './fixtures/message-full-nested.json' with { type: 'json' }
import singlepart from './fixtures/message-full-singlepart.json' with { type: 'json' }
import attachmentOnly from './fixtures/message-full-attachment-only.json' with { type: 'json' }

function b64url(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64url')
}

function contentTypeOf(headers: { name: string; value: string }[] | undefined): string | null {
  return headers?.find((h) => h.name === 'Content-Type')?.value ?? null
}

describe('extractBodyText', () => {
  it('shape 1: nested multipart — prefers the first text/plain leaf and ignores the attachment part', () => {
    const payload = nested.response.body.payload as Record<string, unknown>
    const parts = payload.parts as { mimeType: string; headers: { name: string; value: string }[]; body: { data: string } }[]
    expect(parts.map((p) => p.mimeType)).toEqual(['text/plain', 'text/html'])
    // The fixture's own Content-Type header is honoured by decodePartBytes now (charset-aware
    // decode replaces the reference's naive `Buffer(...).toString('utf8')`), so the expected
    // value is computed the same way extractBodyText computes it — this test is about walk
    // order and attachment-skip, not encoding correctness (covered separately below).
    const expectedPlain = decodePartBytes(parts[0]!.body.data, contentTypeOf(parts[0]!.headers))

    // Recorded Outlook message (multipart/alternative): the text/plain leaf wins over its HTML
    // sibling, returned verbatim — CRLF line endings and the quoted earlier message included.
    expect(extractBodyText(payload)).toBe(expectedPlain)
    expect(extractBodyText(payload)).toContain('seams split open')
    expect(extractBodyText(payload)).not.toContain('</')
  })

  it('shape 2: html-only payload — falls back to text/html, converted to plain text', () => {
    const html =
      '<html><body><style>p { color: red; }</style>' +
      '<p>Order &amp; Shipping</p><p>Status: &quot;pending&quot; &nbsp;still.</p>' +
      '<p>It&#39;s &lt;delayed&gt;.</p></body></html>'
    const payload = {
      mimeType: 'multipart/alternative',
      body: { size: 0 },
      parts: [
        {
          mimeType: 'text/html',
          body: { size: html.length, data: b64url(html) },
        },
        {
          // attachment-only part must never be considered a text leaf
          mimeType: 'application/octet-stream',
          filename: 'blob.bin',
          body: { attachmentId: 'att-1', size: 999 },
        },
      ],
    }

    const text = extractBodyText(payload)
    // style block content must be gone, tags stripped, entities decoded
    expect(text).not.toContain('color: red')
    expect(text).not.toContain('<p>')
    // html-to-text (not the reference's regex stripHtml) separates paragraphs with blank lines
    // rather than collapsing them to a single space, and preserves &nbsp; as U+00A0 rather than
    // decoding it to a plain space; same semantic content.
    expect(text).toBe('Order & Shipping\n\nStatus: "pending"  still.\n\nIt\'s <delayed>.')
  })

  it('shape 3: single-part message — falls back to top-level payload.body.data', () => {
    // Recorded SENT copy of one of our own replies — plain text/plain, no parts[] at all.
    const payload = singlepart.response.body.payload
    const expected = Buffer.from(payload.body.data, 'base64url').toString('utf8')

    expect(payload).not.toHaveProperty('parts')
    expect(extractBodyText(payload)).toBe(expected)
    expect(extractBodyText(payload)).toMatch(/^Hi Rob,\n\nHappy to help/)
  })

  it('shape 4: attachment-only message (recorded DMARC zip report) — no text leaf anywhere, returns null without decoding the attachment', () => {
    const payload = attachmentOnly.response.body.payload

    expect(payload.mimeType).toBe('application/zip')
    expect(payload.body).toHaveProperty('attachmentId')
    expect(extractBodyText(payload)).toBeNull()
  })

  it('skips a part that carries only an attachmentId (no body.data) even if it claims text/plain', () => {
    const payload = {
      mimeType: 'multipart/mixed',
      body: { size: 0 },
      parts: [
        {
          mimeType: 'text/plain',
          filename: 'note.txt',
          body: { attachmentId: 'att-only-1', size: 40 }, // no data — must be skipped
        },
        {
          mimeType: 'text/plain',
          body: { size: 5, data: b64url('hello') },
        },
      ],
    }
    expect(extractBodyText(payload)).toBe('hello')
  })

  it('returns null when there is no usable leaf and no top-level body.data', () => {
    expect(extractBodyText({ mimeType: 'multipart/mixed', body: { size: 0 }, parts: [] })).toBeNull()
    expect(extractBodyText(null)).toBeNull()
    expect(extractBodyText(undefined)).toBeNull()
  })

  it('decodes ISO-8859-1 bytes using the part charset', () => {
    const latin1 = Buffer.from('caf\xe9 ol\xe9', 'latin1').toString('base64url')
    expect(decodePartBytes(latin1, 'text/plain; charset="ISO-8859-1"')).toBe('café olé')
  })

  it('falls back to utf-8 on an unknown charset', () => {
    const utf8 = Buffer.from('plain', 'utf8').toString('base64url')
    expect(decodePartBytes(utf8, 'text/plain; charset="x-mystery"')).toBe('plain')
  })

  it('strips html without eating entities or scripts', () => {
    expect(htmlToPlainText('<style>p{}</style><script>x()</script><p>a &amp; b</p>')).toBe('a & b')
  })
})
