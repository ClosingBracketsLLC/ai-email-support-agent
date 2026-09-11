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

/** Turns one document's parsed blocks into chunks, screens each for prompt-injection content, and
 * hashes the source text. A flagged chunk is kept (never dropped) — it's stored but excluded from
 * retrieval until an owner clears the flag; screening it out here would silently hide it from that review. */
export function prepareDocument(input: { blocks: Block[]; uri: string; title: string | null }): PreparedDocument {
  const joined = input.blocks.map((b) => b.text).join('\n')
  if (joined.length === 0) throw new ParseError('no_text')

  const contentHash = createHash('sha256').update(joined).digest('hex')
  const chunks = chunkBlocks(input.blocks).map((chunk) => {
    const { flagged, reason } = screenChunk(chunk.content)
    return { ...chunk, injectionFlagged: flagged, injectionReason: reason }
  })

  return { uri: input.uri, title: input.title, contentHash, chunks }
}
