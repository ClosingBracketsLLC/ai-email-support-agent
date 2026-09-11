import { estimateTokens } from '@aesa/llm'

export interface BatchLimits {
  /** Texts per call — Voyage's own hard limit. */
  maxTexts: number
  /** Estimated tokens per call, from `estimateTokens` (≈ 4 characters per token). */
  maxTokens: number
  /** Characters per call, the floor under the token estimate. `estimateTokens` assumes English-ish
   * prose; CJK runs closer to ONE token per character, so a batch of Chinese knowledge chunks that
   * estimates at 100,000 tokens can really be ~400,000 — four times the provider's ceiling, and a
   * whole batch rejected. 120,000 characters is a comfortable bound on both readings at once. */
  maxChars: number
}

const DEFAULT_LIMITS: BatchLimits = { maxTexts: 128, maxTokens: 100_000, maxChars: 120_000 }

/** Greedy, order-preserving packing under a count ceiling, an estimated-token ceiling and a
 * character ceiling — the caller's job before handing a list of texts to `Embedder.embed` (which
 * itself refuses more than 128 texts per call). A single text over the token or character ceiling
 * alone still needs to reach the provider, so it gets its own one-text batch rather than being
 * dropped or split. */
export function batchTexts(texts: string[], limits: BatchLimits = DEFAULT_LIMITS): string[][] {
  const { maxTexts, maxTokens, maxChars } = limits
  const batches: string[][] = []
  let current: string[] = []
  let currentTokens = 0
  let currentChars = 0

  const flush = () => {
    if (current.length > 0) {
      batches.push(current)
      current = []
      currentTokens = 0
      currentChars = 0
    }
  }

  for (const text of texts) {
    const tokens = estimateTokens(text)
    if (tokens > maxTokens || text.length > maxChars) {
      flush()
      batches.push([text])
      continue
    }
    if (current.length >= maxTexts || currentTokens + tokens > maxTokens || currentChars + text.length > maxChars) {
      flush()
    }
    current.push(text)
    currentTokens += tokens
    currentChars += text.length
  }
  flush()

  return batches
}
