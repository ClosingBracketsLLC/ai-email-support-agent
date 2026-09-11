import { describe, expect, it } from 'vitest'
import { parseDocx, parseHtml, parseMarkdown, parsePdf, parseText, DEFAULT_PARSE_LIMITS, type ParseError } from '../src/index.ts'
import { minimalDocx, minimalPdf } from './fixtures.ts'

describe('parseHtml', () => {
  const html = `<html><head><title>Acme · Returns</title><link rel="canonical" href="https://acme.example/returns"><meta name="robots" content="noindex"></head>
    <body><nav><a href="/">Home</a></nav><script>alert(1)</script><style>.x{}</style>
    <h1>Returns</h1><p>Items can be returned within <b>30 days</b>.</p>
    <h2>Exceptions</h2><ul><li>Sale items</li><li>Gift cards</li></ul>
    <a href="/shipping">Shipping</a><a href="https://other.example/x">Other</a><a href="mailto:x@y">mail</a>
    <footer>© Acme</footer></body></html>`
  const parsed = parseHtml(html)
  it('extracts the title, canonical and noindex', () => {
    expect(parsed.title).toBe('Acme · Returns'); expect(parsed.canonical).toBe('https://acme.example/returns'); expect(parsed.noindex).toBe(true)
  })
  it('drops nav/script/style/footer, keeps headings as path and text', () => {
    expect(parsed.blocks.map((b) => [b.kind, b.headingPath.join(' › '), b.text])).toEqual([
      ['heading', 'Returns', 'Returns'],
      ['paragraph', 'Returns', 'Items can be returned within 30 days.'],
      ['heading', 'Returns › Exceptions', 'Exceptions'],
      ['list', 'Returns › Exceptions', '• Sale items\n• Gift cards'],
    ])
  })
  it('collects http(s) links only, unresolved (the crawler resolves against the page URL)', () => {
    expect(parsed.links).toEqual(['/', '/shipping', 'https://other.example/x'])
  })
})

describe('parseMarkdown / parseText', () => {
  it('splits ATX headings into the path and paragraphs by blank lines', () => {
    expect(parseMarkdown('# Returns\n\nWithin 30 days.\n\n## Exceptions\n\n- Sale items\n- Gift cards\n\n```\ncode here\n```').map((b) => [b.kind, b.headingPath.join(' › '), b.text])).toEqual([
      ['heading', 'Returns', 'Returns'], ['paragraph', 'Returns', 'Within 30 days.'], ['heading', 'Returns › Exceptions', 'Exceptions'],
      ['list', 'Returns › Exceptions', '• Sale items\n• Gift cards'], ['code', 'Returns › Exceptions', 'code here'],
    ])
  })
  it('parseText makes one paragraph per blank-line-separated run, whitespace collapsed', () => {
    expect(parseText('a  b\nc\n\n\nd').map((b) => b.text)).toEqual(['a b c', 'd'])
  })
})

describe('parsePdf / parseDocx (in-process, the child calls these)', () => {
  it('reads the page text of a minimal PDF', async () => {
    const blocks = await parsePdf(minimalPdf(['Returns within 30 days.', 'Sale items excluded.']), DEFAULT_PARSE_LIMITS)
    expect(blocks.map((b) => b.text).join('\n')).toContain('Returns within 30 days.')
  })
  it('refuses a PDF over the page cap and reports no_text for an empty one', async () => {
    await expect(parsePdf(minimalPdf(['x']), { ...DEFAULT_PARSE_LIMITS, maxPages: 0 })).rejects.toMatchObject({ code: 'too_large' } satisfies Partial<ParseError>)
    await expect(parsePdf(minimalPdf([]), DEFAULT_PARSE_LIMITS)).rejects.toMatchObject({ code: 'no_text' })
  })
  it('reads a DOCX heading and body through mammoth', async () => {
    const blocks = await parseDocx(await minimalDocx('Returns', 'Within 30 days.'), DEFAULT_PARSE_LIMITS)
    expect(blocks.map((b) => [b.kind, b.text])).toEqual([['heading', 'Returns'], ['paragraph', 'Within 30 days.']])
  })
})
