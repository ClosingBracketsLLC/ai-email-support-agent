import { LlmError } from '../core/errors.ts'
import type { ChatRequest, ChatResult, ChatUsage, LlmProvider, ParseStrategy } from '../core/types.ts'

export interface FakeScript<T = unknown> {
  parsed?: T
  text?: string
  error?: LlmError
  usage?: Partial<ChatUsage>
  delayMs?: number
}

const DEFAULT_USAGE: ChatUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, apiCalls: 1 }

/**
 * Deterministic `LlmProvider` for tests that never touches a network. Scripts are consumed one
 * per `chat()` call, in order; once exhausted, the last script repeats for every further call
 * (so a caller testing "N attempts then success" only has to write the tail once). Every request
 * is recorded on `.calls` before the script is applied, so a caller can assert on `meta`,
 * `signal`, or any other request field even when the call ultimately throws.
 */
export function createFakeProvider(scripts: FakeScript[]): LlmProvider & { calls: ChatRequest<unknown>[] } {
  if (scripts.length === 0) throw new Error('createFakeProvider: at least one script is required')

  const calls: ChatRequest<unknown>[] = []
  let index = 0

  return {
    kind: 'fake',
    calls,
    async chat<T>(req: ChatRequest<T>): Promise<ChatResult<T>> {
      calls.push(req as ChatRequest<unknown>)
      const script = scripts[Math.min(index, scripts.length - 1)] as FakeScript<T>
      index += 1

      if (script.delayMs) {
        await delayOrAbort(script.delayMs, req.signal)
      }
      // Covers a signal that was already aborted before this call, or aborted exactly at the
      // delay boundary — belt-and-suspenders alongside the mid-delay rejection above.
      if (req.signal?.aborted) throw new LlmError('aborted', 'transient', true)

      if (script.error) throw script.error

      const usage: ChatUsage = { ...DEFAULT_USAGE, ...script.usage }
      const parsed = script.parsed ?? null
      const parseStrategy: ParseStrategy = parsed !== null ? 'native' : 'none'

      return {
        text: script.text ?? '',
        parsed,
        parseStrategy,
        usage,
        finish: 'stop',
        provider: 'fake',
        model: req.model,
        latencyMs: 0,
        providerRequestId: undefined,
      }
    },
  }
}

/** Resolves after `ms`, or rejects with a transient aborted `LlmError` the moment `signal` fires. */
function delayOrAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new LlmError('aborted', 'transient', true))
      return
    }
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(new LlmError('aborted', 'transient', true))
      },
      { once: true },
    )
  })
}
