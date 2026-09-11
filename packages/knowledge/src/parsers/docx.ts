import mammoth from 'mammoth'
import { ParseError, type ParseLimits } from '../bounds.ts'
import { type Block, collapse } from './blocks.ts'
import { parseHtml } from './html.ts'

/** In-process DOCX text extraction: mammoth converts to HTML (headings, paragraphs, lists — the
 * same shape the block extractor already understands), then `parseHtml` builds the blocks. Only
 * ever called inside the parser child. `limits` is accepted for signature parity with `parsePdf`;
 * DOCX has no page count to cap and the child already enforces `maxBytes` before either parser
 * runs. */
export async function parseDocx(bytes: Uint8Array, limits: ParseLimits): Promise<Block[]> {
  void limits
  let html: string
  try {
    const result = await mammoth.convertToHtml({ buffer: Buffer.from(bytes) })
    html = result.value
  } catch (err) {
    throw new ParseError('parse_failed', err instanceof Error ? err.message : String(err))
  }

  const { blocks } = parseHtml(html)
  if (blocks.length === 0 || blocks.every((b) => collapse(b.text).length === 0)) {
    throw new ParseError('no_text', 'the DOCX contains no extractable text')
  }
  return blocks
}
