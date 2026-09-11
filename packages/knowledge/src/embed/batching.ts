import { estimateTokens } from '@aesa/llm'

export interface BatchLimits {
  maxTexts: 128
  maxTokens: 100_000
}

const DEFAULT_LIMITS: BatchLimits = { maxTexts: 128, maxTokens: 100_000 }

/** Greedy, order-preserving packing under both a count ceiling and an estimated-token ceiling —
 * the caller's job before handing a list of texts to `Embedder.embed` (which itself refuses more
 * than 128 texts per call). A single text over the token ceiling alone still needs to reach the
 * provider, so it gets its own one-text batch rather than being dropped or split. */
export function batchTexts(texts: string[], limits: BatchLimits = DEFAULT_LIMITS): string[][] {
  const { maxTexts, maxTokens } = limits
  const batches: string[][] = []
  let current: string[] = []
  let currentTokens = 0

  const flush = () => {
    if (current.length > 0) {
      batches.push(current)
      current = []
      currentTokens = 0
    }
  }

  for (const text of texts) {
    const tokens = estimateTokens(text)
    if (tokens > maxTokens) {
      flush()
      batches.push([text])
      continue
    }
    if (current.length >= maxTexts || currentTokens + tokens > maxTokens) {
      flush()
    }
    current.push(text)
    currentTokens += tokens
  }
  flush()

  return batches
}
