import { KNOWLEDGE_CHUNK_MAX_CHARS } from '@aesa/contracts'
import { estimateTokens } from '@aesa/llm'
import type { Block } from './parsers/blocks.ts'

export interface Chunk {
  ordinal: number
  headingPath: string[]
  content: string
  tokenCount: number
}

const SENTENCE_SPLIT_RE = /(?<=[.!?])\s+/

function splitSentences(text: string): string[] {
  return text.split(SENTENCE_SPLIT_RE).filter((s) => s.length > 0)
}

/** Hard-cut a run of text longer than `max` into `max`-sized pieces — used only for a "sentence"
 * (a stretch of text with no `.!?` boundary) that is itself longer than `max`. */
function hardSplit(text: string, max: number): string[] {
  const pieces: string[] = []
  for (let i = 0; i < text.length; i += max) pieces.push(text.slice(i, i + max))
  return pieces
}

/** As many WHOLE trailing sentences of a finished piece as fit within `overlap` characters, at
 * least one — the sentence-aligned context carried into the next piece, so a chunk boundary never
 * drops the thread a retrieval match would otherwise need. Built backward from the end: the last
 * sentence is always included (the floor — even alone it may exceed `overlap`, in which case it's
 * truncated to `overlap` characters, keeping its start rather than dropping it entirely); each
 * earlier sentence joins only while the combined text still fits. */
function trailingSentencesOverlap(text: string, overlap: number): string {
  const sentences = splitSentences(text)
  if (sentences.length === 0) return ''
  let combined = sentences[sentences.length - 1]!
  for (let i = sentences.length - 2; i >= 0; i--) {
    const candidate = `${sentences[i]} ${combined}`
    if (candidate.length > overlap) break
    combined = candidate
  }
  return combined.length > overlap ? combined.slice(0, overlap) : combined
}

/** Pack one oversized block's text into pieces no larger than `max`, targeting `target`: sentences
 * accumulate until the next one would cross `target`, then the piece is finalized and the next one
 * opens with the single last sentence of the piece just closed (capped at `overlap` characters). */
function packBlockText(text: string, target: number, max: number, overlap: number): string[] {
  const pieces: string[] = []
  let current = ''

  const finalize = () => { if (current.length > 0) { pieces.push(current); current = '' } }

  for (const rawSentence of splitSentences(text)) {
    const sentenceParts = rawSentence.length > max ? hardSplit(rawSentence, max) : [rawSentence]
    for (const sentence of sentenceParts) {
      if (current.length === 0) { current = sentence; continue }
      const joined = `${current} ${sentence}`
      if (joined.length <= target) { current = joined; continue }

      const overlapText = trailingSentencesOverlap(current, overlap)
      finalize()
      current = overlapText.length > 0 ? `${overlapText} ${sentence}` : sentence
      // A hard-cut fragment carries no sentence boundary to overlap from; guard the hard bound
      // regardless, in case overlap text plus a hard-cut piece would cross it.
      if (current.length > max) current = sentence.slice(0, max)
    }
  }
  finalize()
  return pieces
}

function sameHeadingPath(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

/** Group blocks into retrieval-sized chunks: consecutive blocks under the same heading path merge
 * up to `target` characters; a heading block, a heading path change, or a block that would cross
 * `target` starts a new chunk; a single block longer than `max` is sentence-split with overlap.
 * Never exceeds `max` characters per chunk or `maxChunks` chunks per document. */
export function chunkBlocks(
  blocks: Block[],
  opts?: { target?: number; max?: number; overlap?: number; maxChunks?: number },
): Chunk[] {
  const max = opts?.max ?? KNOWLEDGE_CHUNK_MAX_CHARS
  // Clamped so a caller-supplied target above max can never make the merge/split thresholds
  // disagree with the hard per-chunk cap.
  const target = Math.min(opts?.target ?? 1600, max)
  const overlap = opts?.overlap ?? 200
  const maxChunks = opts?.maxChunks ?? 2000

  const chunks: Chunk[] = []
  const push = (headingPath: string[], content: string): boolean => {
    if (content.length === 0 || chunks.length >= maxChunks) return false
    chunks.push({ ordinal: chunks.length, headingPath, content, tokenCount: estimateTokens(content) })
    return true
  }

  // `headingOnly` marks a `current` that is still just the heading block that opened it — nothing
  // has merged into it yet.
  let current: { headingPath: string[]; content: string; headingOnly: boolean } | null = null
  const flushCurrent = () => { if (current) push(current.headingPath, current.content); current = null }

  outer: for (const block of blocks) {
    if (chunks.length >= maxChunks) break

    if (block.text.length > max) {
      // A heading immediately followed by an over-max block rides ON its first piece instead of
      // becoming a chunk of its own: a lone "Shipping" chunk retrieves on nothing and, worse, the
      // piece that carries the actual answer then starts with no statement of what it is about.
      // Only when the two genuinely do not fit within `max` does the heading flush alone.
      const prefix = current?.headingOnly === true ? current.content : null
      const pieces = packBlockText(block.text, target, max, overlap)
      const prefixFits = prefix !== null && pieces.length > 0 && prefix.length + 2 + pieces[0]!.length <= max
      if (prefixFits) current = null
      else flushCurrent()
      for (const [index, piece] of pieces.entries()) {
        if (!push(block.headingPath, index === 0 && prefixFits ? `${prefix}\n\n${piece}` : piece)) break outer
      }
      continue
    }

    // A heading block ALWAYS starts a new chunk — even two sibling headings with identical text
    // (and so an identical headingPath) never merge into one chunk.
    if (block.kind === 'heading' || current === null || !sameHeadingPath(current.headingPath, block.headingPath)) {
      flushCurrent()
      current = { headingPath: block.headingPath, content: block.text, headingOnly: block.kind === 'heading' }
      continue
    }

    const joined = `${current.content}\n\n${block.text}`
    if (joined.length <= target) {
      current.content = joined
      current.headingOnly = false
    } else {
      flushCurrent()
      // Never a heading: a heading block took the branch above.
      current = { headingPath: block.headingPath, content: block.text, headingOnly: false }
    }
  }
  if (chunks.length < maxChunks) flushCurrent()

  return chunks
}
