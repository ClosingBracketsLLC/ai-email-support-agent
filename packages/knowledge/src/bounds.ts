import type { KnowledgeFailureReason } from '@aesa/contracts'

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
}

export const DEFAULT_PARSE_LIMITS: ParseLimits = {
  maxBytes: 20 * 1024 * 1024,
  maxPages: 500,
  timeoutMs: 60_000,
  maxHeapMb: 512,
}

export class ParseError extends Error {
  code: KnowledgeFailureReason

  constructor(code: KnowledgeFailureReason, message?: string) {
    super(message ?? code)
    this.name = 'ParseError'
    this.code = code
  }
}
