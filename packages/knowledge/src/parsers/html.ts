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
  let headingLevel = 1

  // Text accumulation for the current block.
  let buffer = ''
  let bufferKind: Block['kind'] | null = null
  // Whether we're inside a list (ul/ol), accumulating <li> items into one block.
  let listDepth = 0
  let listItems: string[] = []
  let inListItem = false

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

  const parser = new Parser(
    {
      onopentag(name, attribs) {
        if (ALL_SKIP_TAGS.has(name)) {
          if (TEXT_SKIP_TAGS.has(name)) textSkipDepth++
          if (LINK_SKIP_TAGS.has(name)) { textSkipDepth++; linkSkipDepth++ }
        }
        if (name === 'title') inTitle = true
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
          listDepth++
        } else if (name === 'li' && listDepth > 0) {
          inListItem = true
          buffer = ''
        } else if (TEXT_TAGS.has(name)) {
          if (bufferKind !== (name === 'pre' ? 'code' : 'paragraph')) flush()
          bufferKind = name === 'pre' ? 'code' : 'paragraph'
        } else if (name === 'br') {
          buffer += ' '
        }
      },
      ontext(data) {
        if (textSkipDepth > 0) return
        if (inTitle) { title = (title ?? '') + data; return }
        if (inListItem) { buffer += data; return }
        if (bufferKind !== null) buffer += data
      },
      onclosetag(name) {
        if (ALL_SKIP_TAGS.has(name)) {
          if (TEXT_SKIP_TAGS.has(name)) textSkipDepth--
          if (LINK_SKIP_TAGS.has(name)) { textSkipDepth--; linkSkipDepth-- }
        }
        if (name === 'title') inTitle = false

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
          flush()
        }
      },
    },
    { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true },
  )

  parser.end(html)
  flush()
  flushList()

  if (title !== null) title = collapse(title)

  return { title, canonical, noindex, links, blocks }
}
