/** USD per MTok (million tokens), one row per model family this package prices. */
export interface ModelPricing {
  id: string
  /** Matches the model id this row prices — including any future dated-snapshot suffix. */
  pattern: RegExp
  inputPerMtok: number
  outputPerMtok: number
  cacheReadPerMtok: number
  cacheWrite5mPerMtok: number
  cacheWrite1hPerMtok: number
}
