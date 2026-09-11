import { LlmError } from '../core/errors.ts'
import type { Capabilities, ChatRequest, ChatResult, ChatUsage, LlmProvider, LlmRole, ParseStrategy } from '../core/types.ts'

/** Fixed for every model unless a caller overrides it via `FakeProviderOptions.capabilities`. */
const FAKE_CAPABILITIES: Capabilities = { structuredOutput: 'native', tools: true, effort: true, cacheMinTokens: 512 }

export interface FakeScript<T = unknown> {
  parsed?: T
  text?: string
  error?: LlmError
  usage?: Partial<ChatUsage>
  delayMs?: number
  /** Default `'stop'`. */
  finish?: ChatResult<unknown>['finish']
  /** Default: `'native'` when `parsed` is set, else `'none'`. */
  parseStrategy?: ParseStrategy
}

export interface FakeProviderOptions {
  kind?: string
  capabilities?: Partial<Capabilities>
  /** Separate script queues per role — the E2E shares one provider between triage and draft jobs. */
  byRole?: Partial<Record<LlmRole, FakeScript[]>>
}

const DEFAULT_USAGE: ChatUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, apiCalls: 1 }

/**
 * Deterministic `LlmProvider` for tests that never touches a network. Scripts are consumed one
 * per `chat()` call, in order; once exhausted, the last script repeats for every further call
 * (so a caller testing "N attempts then success" only has to write the tail once). Every request
 * is recorded on `.calls` (and on `.callsFor(req.meta.role)`) before the script is applied, so a
 * caller can assert on `meta`, `signal`, or any other request field even when the call ultimately
 * throws.
 *
 * A request whose `meta.role` has a non-empty queue in `opts.byRole` pops from THAT queue instead
 * of `scripts` — each role's queue advances (and repeats its own last script) independently of
 * every other role's. `scripts` may be empty as long as every role a caller will actually use has
 * its own `byRole` queue; at least one script must exist somewhere, or `chat()` would have
 * nothing to return.
 */
export function createFakeProvider(
  scripts: FakeScript[],
  opts: FakeProviderOptions = {},
): LlmProvider & { calls: ChatRequest<unknown>[]; callsFor(role: LlmRole): ChatRequest<unknown>[] } {
  const byRole = opts.byRole ?? {}
  const hasByRoleScript = Object.values(byRole).some((queue) => (queue?.length ?? 0) > 0)
  if (scripts.length === 0 && !hasByRoleScript) {
    throw new Error('createFakeProvider: at least one script is required, in `scripts` or in some `byRole` queue')
  }

  const capabilities: Capabilities = { ...FAKE_CAPABILITIES, ...opts.capabilities }

  const calls: ChatRequest<unknown>[] = []
  const callsByRole = new Map<LlmRole, ChatRequest<unknown>[]>()
  let index = 0
  const roleIndex = new Map<LlmRole, number>()

  function nextScript<T>(role: LlmRole): FakeScript<T> {
    const queue = byRole[role]
    if (queue && queue.length > 0) {
      const i = roleIndex.get(role) ?? 0
      roleIndex.set(role, i + 1)
      return queue[Math.min(i, queue.length - 1)] as FakeScript<T>
    }
    if (scripts.length === 0) {
      throw new Error(`createFakeProvider: no script available for role "${role}" (no byRole queue and \`scripts\` is empty)`)
    }
    const script = scripts[Math.min(index, scripts.length - 1)] as FakeScript<T>
    index += 1
    return script
  }

  return {
    kind: opts.kind ?? 'fake',
    calls,
    callsFor(role: LlmRole): ChatRequest<unknown>[] {
      return callsByRole.get(role) ?? []
    },
    capabilities(): Capabilities {
      return capabilities
    },
    async chat<T>(req: ChatRequest<T>): Promise<ChatResult<T>> {
      calls.push(req as ChatRequest<unknown>)
      const role = req.meta.role
      const roleCalls = callsByRole.get(role) ?? []
      roleCalls.push(req as ChatRequest<unknown>)
      callsByRole.set(role, roleCalls)

      const script = nextScript<T>(role)

      if (script.delayMs) {
        await delayOrAbort(script.delayMs, req.signal)
      }
      // Covers a signal that was already aborted before this call, or aborted exactly at the
      // delay boundary — belt-and-suspenders alongside the mid-delay rejection above.
      if (req.signal?.aborted) throw new LlmError('aborted', 'transient', true)

      if (script.error) throw script.error

      const usage: ChatUsage = { ...DEFAULT_USAGE, ...script.usage }
      const parsed = script.parsed ?? null
      const parseStrategy: ParseStrategy = script.parseStrategy ?? (parsed !== null ? 'native' : 'none')
      const finish: ChatResult<unknown>['finish'] = script.finish ?? 'stop'

      return {
        text: script.text ?? '',
        parsed,
        parseStrategy,
        usage,
        finish,
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
