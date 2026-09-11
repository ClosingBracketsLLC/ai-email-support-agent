import { Parser } from 'htmlparser2'
import { type Block, collapse, pushHeading } from './blocks.ts'

/** Tags whose TEXT is dropped entirely (boilerplate chrome, non-content markup). Links inside
 * these are still collected — only `<a href>` inside `script`, `style` or `template` is dropped
 * (those never render, so their links are not real page navigation). */
const TEXT_SKIP_TAGS = new Set(['nav', 'footer', 'header', 'aside', 'noscript', 'svg', 'iframe'])
/** Tags whose content — text AND links — is dropped entirely: script/style/template bodies never
 * render as page content or navigation. */
const LINK_SKIP_TAGS = new Set(['script', 'style', 'template'])
const ALL_SKIP_TAGS = new Set([...TEXT_SKIP_TAGS, ...LINK_SKIP_TAGS])

const TEXT_TAGS = new Set(['p', 'li', 'td', 'th', 'dd', 'dt', 'blockquote', 'pre'])
const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'])
/** Block-level containers that flush the "loose" paragraph buffer on open AND close — text sitting
 * directly under one of these with no wrapping content tag (e.g. `<div>plain text</div>`) still
 * becomes a paragraph block instead of being silently dropped. `dl`/`dt`/`dd` join this set (fix
 * review carry-over) so a `<dl>` flushes any loose prose ahead of it in document order, same as
 * any other block-level container. */
const LOOSE_FLUSH_TAGS = new Set(['div', 'section', 'article', 'main', 'p', 'li', 'table', 'tr', 'ul', 'ol', 'blockquote', 'pre', 'dl', 'dt', 'dd', ...HEADING_TAGS])

function isHttpOrRootLink(href: string): boolean {
  return href.startsWith('http://') || href.startsWith('https://') || href.startsWith('/')
}

export function parseHtml(html: string): { title: string | null; canonical: string | null; noindex: boolean; links: string[]; blocks: Block[] } {
  let title: string | null = null
  let canonical: string | null = null
  let noindex = false
  const links: string[] = []
  const blocks: Block[] = []

  let headingPath: string[] = []
  let textSkipDepth = 0
  let linkSkipDepth = 0
  let inTitle = false
  // Accumulates ONE <title> element's text (possibly split across several text nodes by an
  // entity); a SECOND <title> replaces `title` outright on close rather than appending to it.
  let titleBuffer = ''
  let headingLevel = 1

  // Text accumulation for the current block.
  let buffer = ''
  let bufferKind: Block['kind'] | null = null
  // Whether we're inside a list (ul/ol), accumulating <li> items into one block.
  let listDepth = 0
  let listItems: string[] = []
  let inListItem = false
  // Top-level text with no wrapping content tag (a "loose" run of prose directly under e.g. a
  // <div>), and the count of consecutive <br> opens seen while accumulating it.
  let looseBuffer = ''
  let consecutiveBr = 0

  const flush = () => {
    if (bufferKind === null) return
    const text = collapse(buffer)
    if (text.length > 0) blocks.push({ kind: bufferKind, headingPath, text })
    buffer = ''
    bufferKind = null
  }

  const flushList = () => {
    if (listItems.length > 0) {
      const text = listItems.map((i) => `• ${i}`).join('\n')
      if (text.length > 0) blocks.push({ kind: 'list', headingPath, text })
    }
    listItems = []
  }

  const flushLoose = () => {
    const text = collapse(looseBuffer)
    if (text.length > 0) blocks.push({ kind: 'paragraph', headingPath, text })
    looseBuffer = ''
  }

  const parser = new Parser(
    {
      onopentag(name, attribs) {
        if (name !== 'br') consecutiveBr = 0
        if (LOOSE_FLUSH_TAGS.has(name)) flushLoose()

        if (ALL_SKIP_TAGS.has(name)) {
          if (TEXT_SKIP_TAGS.has(name)) textSkipDepth++
          if (LINK_SKIP_TAGS.has(name)) { textSkipDepth++; linkSkipDepth++ }
        }
        if (name === 'title') { inTitle = true; titleBuffer = '' }
        if (name === 'link' && (attribs.rel ?? '').toLowerCase() === 'canonical' && attribs.href) canonical = attribs.href
        if (name === 'meta' && (attribs.name ?? '').toLowerCase() === 'robots' && /noindex/i.test(attribs.content ?? '')) noindex = true
        if (name === 'a' && attribs.href && linkSkipDepth === 0 && isHttpOrRootLink(attribs.href)) links.push(attribs.href)

        if (HEADING_TAGS.has(name)) {
          flush()
          flushList()
          headingLevel = Number(name[1])
          bufferKind = 'heading'
          buffer = ''
        } else if (name === 'ul' || name === 'ol') {
          flush()
          if (inListItem) {
            // A nested list opened before its parent <li> closed: bank the parent item's text as
            // its own list entry now, so the buffer reset below (for the nested <li>s) doesn't
            // erase it. The nested items land in the same flat list.
            const text = collapse(buffer)
            if (text.length > 0) listItems.push(text)
            buffer = ''
            inListItem = false
          }
          listDepth++
        } else if (name === 'li' && listDepth > 0) {
          inListItem = true
          buffer = ''
        } else if (TEXT_TAGS.has(name)) {
          // A text tag (e.g. <p>) nested inside a list item is inert: the <li> itself owns
          // `buffer` (ontext routes straight into it below whenever `inListItem` is true,
          // regardless of `bufferKind`), so entering/leaving a nested <p> must not flush that
          // buffer out as its own top-level block or otherwise disturb it.
          if (!inListItem) {
            if (bufferKind !== (name === 'pre' ? 'code' : 'paragraph')) flush()
            bufferKind = name === 'pre' ? 'code' : 'paragraph'
          }
        } else if (name === 'br') {
          if (bufferKind !== null || inListItem) {
            buffer += ' '
          } else {
            consecutiveBr++
            if (consecutiveBr >= 2) { flushLoose(); consecutiveBr = 0 } else { looseBuffer += ' ' }
          }
        }
      },
      ontext(data) {
        consecutiveBr = 0
        if (textSkipDepth > 0) return
        if (inTitle) { titleBuffer += data; return }
        if (inListItem) { buffer += data; return }
        if (bufferKind !== null) { buffer += data; return }
        // An anchor's label is text everywhere — inside loose prose exactly as inside a <p> (fix
        // review carry-over: the old `anchorDepth` exception that dropped a standalone anchor's
        // text is gone). Text inside nav/header/footer/etc. is still dropped by the
        // `textSkipDepth` check above, so link soup from navigation chrome stays out either way.
        looseBuffer += data
      },
      onclosetag(name) {
        if (name !== 'br') consecutiveBr = 0
        if (LOOSE_FLUSH_TAGS.has(name)) flushLoose()

        if (ALL_SKIP_TAGS.has(name)) {
          if (TEXT_SKIP_TAGS.has(name)) textSkipDepth--
          if (LINK_SKIP_TAGS.has(name)) { textSkipDepth--; linkSkipDepth-- }
        }
        if (name === 'title') {
          inTitle = false
          // REPLACES any earlier <title> — the last one wins (fix review carry-over, reversing
          // fix review #10's "concatenate" rule).
          title = titleBuffer
        }

        if (HEADING_TAGS.has(name)) {
          const text = collapse(buffer)
          if (text.length > 0) {
            headingPath = pushHeading(headingPath, headingLevel, text)
            blocks.push({ kind: 'heading', headingPath, text })
          }
          buffer = ''
          bufferKind = null
        } else if (name === 'li' && inListItem) {
          const text = collapse(buffer)
          if (text.length > 0) listItems.push(text)
          buffer = ''
          inListItem = false
        } else if (name === 'ul' || name === 'ol') {
          listDepth = Math.max(listDepth - 1, 0)
          if (listDepth === 0) flushList()
        } else if (TEXT_TAGS.has(name)) {
          if (!inListItem) flush()
        }
      },
    },
    { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true },
  )

  parser.end(html)
  flush()
  flushList()
  flushLoose()

  if (title !== null) title = collapse(title)

  return { title, canonical, noindex, links, blocks }
}
