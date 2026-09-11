import { type Block, collapse, pushHeading } from './blocks.ts'

const HEADING_RE = /^(#{1,6})\s+(.+)$/
const LIST_ITEM_RE = /^(?:[-*]|\d+\.)\s+(.+)$/
const FENCE_RE = /^```/

/** Line-based Markdown block extraction: ATX headings build the path, fenced code becomes one
 * `code` block, consecutive bullet/numbered lines become one `list` block, and everything else
 * accumulates into `paragraph` blocks broken by blank lines. Inline markdown (bold, links, …) is
 * left as literal text — the model reads it fine. */
export function parseMarkdown(md: string): Block[] {
  const lines = md.split(/\r?\n/)
  const blocks: Block[] = []
  let headingPath: string[] = []

  let paragraphLines: string[] = []
  let listItems: string[] = []
  let inCode = false
  let codeLines: string[] = []

  const flushParagraph = () => {
    if (paragraphLines.length > 0) {
      const text = collapse(paragraphLines.join(' '))
      if (text.length > 0) blocks.push({ kind: 'paragraph', headingPath, text })
    }
    paragraphLines = []
  }
  const flushList = () => {
    if (listItems.length > 0) {
      const text = listItems.map((item) => `• ${collapse(item)}`).join('\n')
      if (text.length > 0) blocks.push({ kind: 'list', headingPath, text })
    }
    listItems = []
  }
  const flushCode = () => {
    const text = codeLines.join('\n').trim()
    if (text.length > 0) blocks.push({ kind: 'code', headingPath, text })
    codeLines = []
  }

  for (const line of lines) {
    if (inCode) {
      if (FENCE_RE.test(line.trim())) { inCode = false; flushCode() } else { codeLines.push(line) }
      continue
    }
    if (FENCE_RE.test(line.trim())) { flushParagraph(); flushList(); inCode = true; continue }

    const heading = HEADING_RE.exec(line)
    if (heading) {
      flushParagraph(); flushList()
      const level = heading[1]!.length
      const text = collapse(heading[2]!)
      headingPath = pushHeading(headingPath, level, text)
      blocks.push({ kind: 'heading', headingPath, text })
      continue
    }

    const listItem = LIST_ITEM_RE.exec(line)
    if (listItem) { flushParagraph(); listItems.push(listItem[1]!); continue }

    if (line.trim() === '') { flushParagraph(); flushList(); continue }

    flushList()
    paragraphLines.push(line)
  }
  flushParagraph()
  flushList()
  if (inCode) flushCode()

  return blocks
}
