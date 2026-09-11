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

/** Cut the tail of a finished piece down to whole sentences: drop the (likely partial) fragment
 * at the start so the overlap carried into the next piece always begins at a sentence boundary. */
function sentenceAlignedOverlap(tail: string): string {
  const sentences = splitSentences(tail)
  if (sentences.length <= 1) return ''
  return sentences.slice(1).join(' ')
}

/** Pack one oversized block's text into pieces no larger than `max`, targeting `target`: sentences
 * accumulate until the next one would cross `target`, then the piece is finalized and the next one
 * opens with up to `overlap` characters of sentence-aligned context from the piece just closed. */
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

      const overlapText = sentenceAlignedOverlap(current.slice(-overlap))
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
 * up to `target` characters; a heading path change or a block that would cross `target` starts a
 * new chunk; a single block longer than `max` is sentence-split with overlap. Never exceeds `max`
 * characters per chunk or `maxChunks` chunks per document. */
export function chunkBlocks(
  blocks: Block[],
  opts?: { target?: number; max?: number; overlap?: number; maxChunks?: number },
): Chunk[] {
  const target = opts?.target ?? 1600
  const max = opts?.max ?? 3000
  const overlap = opts?.overlap ?? 200
  const maxChunks = opts?.maxChunks ?? 2000

  const chunks: Chunk[] = []
  const push = (headingPath: string[], content: string): boolean => {
    if (content.length === 0 || chunks.length >= maxChunks) return false
    chunks.push({ ordinal: chunks.length, headingPath, content, tokenCount: estimateTokens(content) })
    return true
  }

  let current: { headingPath: string[]; content: string } | null = null
  const flushCurrent = () => { if (current) push(current.headingPath, current.content); current = null }

  outer: for (const block of blocks) {
    if (chunks.length >= maxChunks) break

    if (block.text.length > max) {
      flushCurrent()
      for (const piece of packBlockText(block.text, target, max, overlap)) {
        if (!push(block.headingPath, piece)) break outer
      }
      continue
    }

    if (current === null || !sameHeadingPath(current.headingPath, block.headingPath)) {
      flushCurrent()
      current = { headingPath: block.headingPath, content: block.text }
      continue
    }

    const joined = `${current.content}\n\n${block.text}`
    if (joined.length <= target) {
      current.content = joined
    } else {
      flushCurrent()
      current = { headingPath: block.headingPath, content: block.text }
    }
  }
  if (chunks.length < maxChunks) flushCurrent()

  return chunks
}
