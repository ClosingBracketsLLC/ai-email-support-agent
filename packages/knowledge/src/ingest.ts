import { createHash } from 'node:crypto'
import { ParseError } from './bounds.ts'
import { chunkBlocks, type Chunk } from './chunker.ts'
import { screenChunk } from './injection.ts'
import type { Block } from './parsers/blocks.ts'

export interface PreparedDocument {
  uri: string
  title: string | null
  /** sha256 of the parsed blocks' text, joined with `\n` — stable across re-parses of unchanged
   * content, the crawler's duplicate-page check (rule 7) and re-ingestion's "did this change" check. */
  contentHash: string
  chunks: (Chunk & { injectionFlagged: boolean; injectionReason: string | null })[]
}

/** sha256 (hex) of `blocks`' text, joined with `\n` — the ONE hashing rule for a set of parsed
 * blocks, shared by `prepareDocument` (below) and the crawler engine's duplicate-page check (rule
 * 7), so the two can never quietly drift apart into two different notions of "same content". */
export function contentHashOf(blocks: Block[]): string {
  return createHash('sha256').update(blocks.map((b) => b.text).join('\n')).digest('hex')
}

/** Turns one document's parsed blocks into chunks, screens each for prompt-injection content, and
 * hashes the source text. A flagged chunk is kept (never dropped) — it's stored but excluded from
 * retrieval until an owner clears the flag; screening it out here would silently hide it from that review. */
export function prepareDocument(input: { blocks: Block[]; uri: string; title: string | null }): PreparedDocument {
  const joined = input.blocks.map((b) => b.text).join('\n')
  // Whitespace-only is "no text" too — a block whose collapsed content is empty never survives a
  // real parser (collapse() only pushes non-empty text), but this function also accepts hand-built
  // `Block[]` directly, so it must not trust that invariant.
  if (joined.trim().length === 0) throw new ParseError('no_text')

  const contentHash = contentHashOf(input.blocks)
  const chunks = chunkBlocks(input.blocks).map((chunk) => {
    const { flagged, reason } = screenChunk(chunk.content)
    return { ...chunk, injectionFlagged: flagged, injectionReason: reason }
  })

  return { uri: input.uri, title: input.title, contentHash, chunks }
}
