import { KNOWLEDGE_CHUNK_MAX_CHARS, KNOWLEDGE_MAX_UPLOAD_BYTES, type KnowledgeFailureReason } from '@aesa/contracts'

/** Bounds applied to a single parse — either in-process (small text/markdown) or inside the parser child (PDF/DOCX). */
export interface ParseLimits {
  /** Refuse a source file larger than this. */
  maxBytes: number
  /** Refuse a PDF with more pages than this. */
  maxPages: number
  /** Wall-clock budget for the whole parse; the child is killed past it. */
  timeoutMs: number
  /** `--max-old-space-size` for the parser child. */
  maxHeapMb: number
  /** Ceiling on the TOTAL block text one parse may hand back; blocks past it are dropped and the
   * result is marked `truncated`. See `MAX_PARSED_TEXT_CHARS`. */
  maxTextChars: number
}

/** The chunker's own ceiling — `maxChunks` (2,000) × `KNOWLEDGE_CHUNK_MAX_CHARS` — and so the most
 * parsed text that could ever become chunks. Past it, the parser child's IPC reply was bounded
 * only by its heap: a 20 MiB PDF can inflate to ~100 MB of text that the parent must buffer and
 * `JSON.parse` in one string (final review A3). */
export const MAX_PARSED_TEXT_CHARS = 2000 * KNOWLEDGE_CHUNK_MAX_CHARS

export const DEFAULT_PARSE_LIMITS: ParseLimits = {
  maxBytes: KNOWLEDGE_MAX_UPLOAD_BYTES,
  maxPages: 500,
  timeoutMs: 60_000,
  maxHeapMb: 512,
  maxTextChars: MAX_PARSED_TEXT_CHARS,
}

export class ParseError extends Error {
  code: KnowledgeFailureReason

  constructor(code: KnowledgeFailureReason, message?: string) {
    super(message ?? code)
    this.name = 'ParseError'
    this.code = code
  }
}
