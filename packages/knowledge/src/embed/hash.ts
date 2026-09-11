import { estimateTokens } from '@aesa/llm'
import type { Embedder } from './types.ts'

const DIMENSIONS = 1024
const FNV_OFFSET_BASIS = 0x811c9dc5
const FNV_PRIME = 0x01000193

function fnv1a32(str: string): number {
  let hash = FNV_OFFSET_BASIS
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i)
    hash = Math.imul(hash, FNV_PRIME)
  }
  return hash >>> 0
}

/** Naive plural-stripping ("returns" → "return") so the bag-of-hashes below scores a paraphrase
 * that only differs by inflection as lexical overlap — a deliberate, minimal deviation from a
 * pure whole-token hash (task brief's `hash.ts` description doesn't mention it): whole-word
 * `fnv1a32` alone cannot register "return"/"returns" as related (confirmed empirically — with no
 * stemming the pinned lexical-overlap test ties at cosine 0 for both the paraphrase and the
 * unrelated sentence, since neither shares an exact token with the query). This single-suffix
 * strip is the smallest fix that gives the intended signal without reaching for full stemming or
 * character-shingling. See task-5-report.md for the empirical trace. */
function stem(token: string): string {
  if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1)
  return token
}

function tokenize(text: string): string[] {
  const normalized = text.normalize('NFKC').toLowerCase()
  // `\p{M}` (combining marks) keeps a Devanagari/Thai/Arabic word whole — without it "नमस्ते"
  // splits into four fragments and hashes into four unrelated bins.
  const matches = normalized.match(/[\p{L}\p{M}\p{N}]+/gu) ?? []
  return matches.filter((token) => token.length > 2)
}

function embedOne(text: string): number[] {
  const vector = new Array<number>(DIMENSIONS).fill(0)
  const tokens = tokenize(text)

  if (tokens.length === 0) {
    vector[0] = 1
    return vector
  }

  for (const raw of tokens) {
    const h = fnv1a32(stem(raw))
    const primaryBin = h % DIMENSIONS
    const secondaryBin = (h >>> 10) % DIMENSIONS
    vector[primaryBin] = (vector[primaryBin] ?? 0) + 1
    vector[secondaryBin] = (vector[secondaryBin] ?? 0) + 0.5
  }

  let sumSquares = 0
  for (const v of vector) sumSquares += v * v
  const norm = Math.sqrt(sumSquares)
  if (norm === 0) {
    vector[0] = 1
    return vector
  }
  return vector.map((v) => v / norm)
}

/** Deterministic, dependency-free embedder used as the dev/test fallback wherever no
 * `VOYAGE_API_KEY` is configured — a normalized hashed bag-of-words vector so ingest and
 * retrieval run locally and in CI without a key (spec §Knowledge & learning). */
export function createHashEmbedder(): Embedder {
  return {
    model: 'hash-v1',
    version: 1,
    dimensions: DIMENSIONS,
    async embed(texts) {
      const vectors = texts.map(embedOne)
      const tokens = texts.reduce((sum, text) => sum + estimateTokens(text), 0)
      return { vectors, tokens }
    },
  }
}
