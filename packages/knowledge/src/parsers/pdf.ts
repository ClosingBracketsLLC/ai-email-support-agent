import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { ParseError, type ParseLimits } from '../bounds.ts'
import type { Block } from './blocks.ts'
import { parseText } from './text.ts'

/** Join a page's text items into lines: a change in the item's baseline y (`transform[5]`) starts
 * a new line. */
async function extractPageText(doc: PDFDocumentProxy, pageNumber: number): Promise<string> {
  const page = await doc.getPage(pageNumber)
  const content = await page.getTextContent()
  const lines: string[] = []
  let currentLine = ''
  let currentY: number | null = null
  for (const item of content.items) {
    if (!('str' in item)) continue
    const y = Number(item.transform[5])
    if (currentY !== null && y !== currentY) { lines.push(currentLine); currentLine = '' }
    currentLine += item.str
    currentY = y
  }
  if (currentLine.length > 0) lines.push(currentLine)
  return lines.join('\n')
}

/** In-process PDF text extraction via pdfjs-dist's legacy Node build — no canvas, no OCR. Only
 * ever called inside the parser child. */
export async function parsePdf(bytes: Uint8Array, limits: ParseLimits): Promise<Block[]> {
  // `isEvalSupported` was removed from pdfjs-dist's DocumentInitParameters as of this major
  // version; text extraction never triggers eval regardless. `verbosity: 0` keeps the fixture's
  // Type1 Helvetica font-substitution warning out of test output.
  const loadingTask = getDocument({ data: bytes, useSystemFonts: false, disableFontFace: true, verbosity: 0 })
  try {
    const doc = await loadingTask.promise
    if (doc.numPages > limits.maxPages) {
      throw new ParseError('too_large', `PDF has ${doc.numPages} pages, over the ${limits.maxPages}-page limit`)
    }
    const pageTexts: string[] = []
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) pageTexts.push(await extractPageText(doc, pageNumber))
    const blocks = parseText(pageTexts.join('\n\n'))
    if (blocks.length === 0) throw new ParseError('no_text', 'the PDF contains no extractable text')
    return blocks
  } catch (err) {
    if (err instanceof ParseError) throw err
    throw new ParseError('parse_failed', err instanceof Error ? err.message : String(err))
  } finally {
    await loadingTask.destroy()
  }
}
