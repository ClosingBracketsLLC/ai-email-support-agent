/** The provider-agnostic embedding port: Voyage in production, a deterministic hash fallback in
 * dev/test/CI when no `VOYAGE_API_KEY` is configured. `embeddingModel`/`embeddingVersion` on
 * `knowledge_chunks` record which one wrote a row; retrieval only scores rows from the running
 * embedder's model (spec §Knowledge & learning). */
export interface Embedder {
  readonly model: string
  readonly version: number
  readonly dimensions: 1024
  embed(texts: string[], inputType: 'document' | 'query', signal?: AbortSignal): Promise<{ vectors: number[][]; tokens: number }>
}

export interface Reranker {
  rerank(query: string, documents: string[], topK: number, signal?: AbortSignal): Promise<{ index: number; score: number }[]>
}

export type EmbedErrorCode = 'auth' | 'rate_limit' | 'transient' | 'permanent'

/** `retryable` is derived from `code`, never set independently — `rate_limit` and `transient` are
 * the only two a caller should retry. */
export class EmbedError extends Error {
  code: EmbedErrorCode
  retryable: boolean
  retryAfterMs?: number

  constructor(code: EmbedErrorCode, message: string, retryAfterMs?: number) {
    super(message)
    this.name = 'EmbedError'
    this.code = code
    this.retryable = code === 'rate_limit' || code === 'transient'
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs
  }
}
