/**
 * One drafting run can make more than one model call (the structured-output ladder inside
 * `@aesa/llm`, plus the job's one automatic redraft after a guardrail hard failure). The
 * `agent_runs` row records ONE usage total and ONE cost for the whole run, so the job accumulates
 * as it goes and writes `totals()` at `finishRun`.
 */
import type { ChatUsage } from '@aesa/llm'

export interface UsageTotals extends ChatUsage {
  costMicros: number
}

const ZERO: UsageTotals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, apiCalls: 0, costMicros: 0 }

export function createUsageAccumulator(): { add(usage: ChatUsage, costMicros: number): void; totals(): UsageTotals } {
  const running: UsageTotals = { ...ZERO }

  return {
    add(usage: ChatUsage, costMicros: number): void {
      running.inputTokens += usage.inputTokens
      running.outputTokens += usage.outputTokens
      running.cacheReadTokens += usage.cacheReadTokens
      running.cacheWriteTokens += usage.cacheWriteTokens
      running.apiCalls += usage.apiCalls
      running.costMicros += costMicros
    },
    /** A copy — the caller stores it on a run row and keeps accumulating past that point. */
    totals(): UsageTotals {
      return { ...running }
    },
  }
}
