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
  it('drops nav/script/style/footer text, keeps headings as path and text — and (phase-4 controller ruling) the three trailing top-level anchors\' labels now survive as loose prose, back-to-back with no source whitespace between them', () => {
    expect(parsed.blocks.map((b) => [b.kind, b.headingPath.join(' › '), b.text])).toEqual([
      ['heading', 'Returns', 'Returns'],
      ['paragraph', 'Returns', 'Items can be returned within 30 days.'],
      ['heading', 'Returns › Exceptions', 'Exceptions'],
      ['list', 'Returns › Exceptions', '• Sale items\n• Gift cards'],
      // "Shipping", "Other" and "mail" — the three anchors sitting directly in <body>, with no
      // wrapping tag and no whitespace between them in the source — join into one loose-prose
      // block once anchor text is no longer dropped outside nav/header/footer (carry-over (a)).
      ['paragraph', 'Returns › Exceptions', 'ShippingOthermail'],
    ])
  })
  it('collects http(s) links only, unresolved (the crawler resolves against the page URL)', () => {
    expect(parsed.links).toEqual(['/', '/shipping', 'https://other.example/x'])
  })
  it('a second <title> REPLACES the first (phase-4 controller ruling, reversing fix review #10)', () => {
    const two = parseHtml('<html><head><title>First</title><title>Second</title></head><body></body></html>')
    expect(two.title).toBe('Second')
  })
})

describe('parseHtml: anchor text is TEXT everywhere (phase-4 controller ruling, dropping the anchorDepth exception)', () => {
  it('captures an anchor\'s label as part of loose prose exactly as inside a <p>, and still collects its href', () => {
    const loose = parseHtml('<div>Read the <a href="/x">returns policy</a> now for details.</div>')
    expect(loose.blocks).toEqual([{ kind: 'paragraph', headingPath: [], text: 'Read the returns policy now for details.' }])
    expect(loose.links).toEqual(['/x'])
  })
  it('still drops anchor text inside nav/header/footer — only loose top-level anchor text changed', () => {
    const navOnly = parseHtml('<nav><a href="/home">Home</a></nav>')
    expect(navOnly.blocks).toEqual([])
    expect(navOnly.links).toEqual(['/home'])
  })
})

describe('parseHtml: dl/dt/dd join the loose-flush tags (fix review carry-over)', () => {
  it('flushes loose prose before a <dl>, and each <dt>/<dd> becomes its own block, in document order', () => {
    const parsed = parseHtml('<body>Some intro prose.<dl><dt>Shipping</dt><dd>Three days</dd></dl></body>')
    expect(parsed.blocks.map((b) => [b.kind, b.text])).toEqual([
      ['paragraph', 'Some intro prose.'],
      ['paragraph', 'Shipping'],
      ['paragraph', 'Three days'],
    ])
  })
})

describe('parseHtml: a <p> nested inside a <li> is item text, not a stray block (fix review carry-over)', () => {
  it('keeps each <li><p>...</p></li> as one list item, not a lost top-level paragraph', () => {
    const parsed = parseHtml('<ul><li><p>Alpha</p></li><li><p>Beta</p></li></ul>')
    expect(parsed.blocks).toEqual([{ kind: 'list', headingPath: [], text: '• Alpha\n• Beta' }])
  })
})

describe('parseHtml: nested lists and loose (unwrapped) text', () => {
  it('keeps a parent <li>\'s own text when a nested list opens inside it (flat list, fix review #2)', () => {
    const nested = parseHtml('<ul><li>Domestic orders<ul><li>Within 30 days</li></ul></li><li>International orders</li></ul>')
    expect(nested.blocks).toEqual([
      { kind: 'list', headingPath: [], text: '• Domestic orders\n• Within 30 days\n• International orders' },
    ])
  })
  it('captures text with no wrapping content tag as its own paragraph (fix review #3)', () => {
    const loose = parseHtml('<div>Plain text with no block tag at all.</div>')
    expect(loose.blocks).toEqual([{ kind: 'paragraph', headingPath: [], text: 'Plain text with no block tag at all.' }])
  })
  it('splits loose text into separate paragraphs at block-level boundaries', () => {
    const two = parseHtml('<div>A</div><div>B</div>')
    expect(two.blocks.map((b) => [b.kind, b.text])).toEqual([['paragraph', 'A'], ['paragraph', 'B']])
  })
  it('still yields one paragraph for inline tags inside a <p> (existing behaviour unchanged)', () => {
    const inline = parseHtml('<p>See our <span>full</span> <b>policy</b> for details.</p>')
    expect(inline.blocks).toEqual([{ kind: 'paragraph', headingPath: [], text: 'See our full policy for details.' }])
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
