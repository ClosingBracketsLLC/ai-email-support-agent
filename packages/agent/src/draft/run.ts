/**
 * One model call for one draft attempt. Everything around it — the claim, the caps, retrieval, the
 * guardrails, `decide()`, the run bookkeeping and the automatic redraft — belongs to the worker's
 * `ticket.draft` job; this package still has no database dependency.
 *
 * Unlike `runTriageCall`, an unparsable result is NOT an error here. The structured-output ladder
 * in `@aesa/llm` has already spent its rungs by the time we see a result, so `parsed === null`
 * means the model produced nothing usable — a decision the job records and turns into a failure
 * of its own, alongside a refusal, which it treats as an escalation instead. `LlmError`s (rate
 * limits, aborts, transport failures) propagate untouched: retry policy is the job's.
 */
import { INVARIANTS } from '@aesa/core'
import type { ChatMeta, ChatResult, LlmProvider } from '@aesa/llm'
import type { DraftDecision } from './decision.ts'
import { buildDraftRequest, type DraftPromptInput } from './prompt.ts'

export interface DraftCallResult {
  decision: DraftDecision | null
  result: ChatResult<DraftDecision>
}

export async function runDraftCall(
  provider: LlmProvider,
  input: DraftPromptInput,
  meta: ChatMeta,
  signal: AbortSignal,
): Promise<DraftCallResult> {
  const result = await provider.chat(buildDraftRequest(input, meta, signal))
  const decision = result.finish === 'refusal' ? null : result.parsed
  return { decision, result }
}

/**
 * The drafting watchdog. It belongs to the CALLER, not to this function: one timeout has to span
 * the whole run — the first call AND the automatic redraft after a guardrail failure — so the job
 * builds it once and passes the same signal to both calls. `timeoutMs` exists so a test can inject
 * a short budget; production always takes the default.
 */
export function withWatchdog(signal: AbortSignal, timeoutMs = INVARIANTS.DRAFT_WATCHDOG_SECONDS * 1000): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
}
