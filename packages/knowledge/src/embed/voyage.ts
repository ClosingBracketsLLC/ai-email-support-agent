import type { Secret } from '@aesa/crypto'
import { EmbedError } from './types.ts'
import type { Embedder, Reranker } from './types.ts'

const DEFAULT_BASE_URL = 'https://api.voyageai.com/v1'
const REQUEST_TIMEOUT_MS = 30_000
const MAX_TEXTS_PER_CALL = 128
const ERROR_BODY_SLICE_LENGTH = 200
const EMBEDDING_DIMENSIONS = 1024

export interface CreateVoyageEmbedderOptions {
  apiKey: Secret
  model?: 'voyage-4' | 'voyage-4-lite'
  fetch?: typeof fetch
  baseUrl?: string
}

export interface CreateVoyageRerankerOptions {
  apiKey: Secret
  fetch?: typeof fetch
  baseUrl?: string
}

interface VoyageEmbeddingItem {
  object: 'embedding'
  embedding: number[]
  index: number
}

interface VoyageEmbeddingsResponse {
  object: 'list'
  data: VoyageEmbeddingItem[]
  model: string
  usage: { total_tokens: number }
}

interface VoyageRerankItem {
  index: number
  relevance_score: number
}

interface VoyageRerankResponse {
  object: string
  data: VoyageRerankItem[]
  model: string
  usage: unknown
}

function parseRetryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined
  const seconds = Number(header)
  if (!Number.isFinite(seconds) || seconds < 0) return undefined
  return seconds * 1000
}

/** Never builds a message from the request (which carries the Authorization header) — only from
 * the response status and a bounded slice of its body, so a `Secret` API key can never reach an
 * error message or a log line through this path. */
async function readErrorBodySlice(res: Response): Promise<string> {
  const text = await res.text().catch(() => '')
  return text.slice(0, ERROR_BODY_SLICE_LENGTH)
}

function mapStatusToError(status: number, bodySlice: string, retryAfterHeader: string | null): EmbedError {
  const message = `voyage: ${status} ${bodySlice}`
  if (status === 401 || status === 403) return new EmbedError('auth', message)
  if (status === 429) return new EmbedError('rate_limit', message, parseRetryAfterMs(retryAfterHeader))
  if (status >= 500) return new EmbedError('transient', message)
  return new EmbedError('permanent', message)
}

function combineSignals(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
}

function authHeaders(apiKey: Secret): Record<string, string> {
  return { authorization: `Bearer ${apiKey.expose()}`, 'content-type': 'application/json' }
}

export function createVoyageEmbedder(opts: CreateVoyageEmbedderOptions): Embedder {
  const fetchFn = opts.fetch ?? globalThis.fetch
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL
  const model = opts.model ?? 'voyage-4'

  return {
    model,
    version: 1,
    dimensions: EMBEDDING_DIMENSIONS,
    async embed(texts, inputType, signal) {
      if (texts.length > MAX_TEXTS_PER_CALL) throw new Error(`voyage: at most ${MAX_TEXTS_PER_CALL} texts per call`)

      const res = await fetchFn(`${baseUrl}/embeddings`, {
        method: 'POST',
        headers: authHeaders(opts.apiKey),
        body: JSON.stringify({ input: texts, model, input_type: inputType, truncation: true, output_dimension: EMBEDDING_DIMENSIONS }),
        signal: combineSignals(signal, REQUEST_TIMEOUT_MS),
      })
      if (!res.ok) {
        throw mapStatusToError(res.status, await readErrorBodySlice(res), res.headers.get('retry-after'))
      }

      const json = (await res.json()) as VoyageEmbeddingsResponse
      const vectors: number[][] = new Array(texts.length)
      for (const item of json.data) {
        if (item.embedding.length !== EMBEDDING_DIMENSIONS) {
          throw new EmbedError('permanent', `voyage: embedding at index ${item.index} has ${item.embedding.length} dimensions, expected ${EMBEDDING_DIMENSIONS}`)
        }
        vectors[item.index] = item.embedding
      }
      return { vectors, tokens: json.usage.total_tokens }
    },
  }
}

export function createVoyageReranker(opts: CreateVoyageRerankerOptions): Reranker {
  const fetchFn = opts.fetch ?? globalThis.fetch
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL

  return {
    async rerank(query, documents, topK, signal) {
      const res = await fetchFn(`${baseUrl}/rerank`, {
        method: 'POST',
        headers: authHeaders(opts.apiKey),
        body: JSON.stringify({ query, documents, model: 'rerank-2.5', top_k: topK, return_documents: false, truncation: true }),
        signal: combineSignals(signal, REQUEST_TIMEOUT_MS),
      })
      if (!res.ok) {
        throw mapStatusToError(res.status, await readErrorBodySlice(res), res.headers.get('retry-after'))
      }

      const json = (await res.json()) as VoyageRerankResponse
      return json.data
        .map((item) => ({ index: item.index, score: item.relevance_score }))
        .sort((a, b) => b.score - a.score)
    },
  }
}
