/**
 * chars/4 — coarse on purpose; only used to decide whether a prefix can clear a cache minimum and
 * to assert the platform block is long enough. Never used for billing (the adapter reads actual
 * token counts off `response.usage` for that — see `pricing/cost.ts`).
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}
