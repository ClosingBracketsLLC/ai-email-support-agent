/**
 * Per-key concurrency limiter (task brief §core/limiter.ts). The key is either the shared managed
 * pool (`managed:${provider}:${model}`, sized to our own tier) or, from Phase 6, a BYOK org's own
 * credential (`byok:${orgId}:${credentialId}`) — this module only knows about the key string, not
 * where it came from.
 */
import type { ChatRequest, ChatResult, LlmProvider } from './types.ts'

export interface LlmLimiter {
  acquire(key: string): Promise<() => void>
  inFlight(key: string): number
}

interface KeyState {
  active: number
  /** FIFO queue of waiters; each entry hands its holder a fresh release function when its turn comes. */
  queue: (() => void)[]
}

/** FIFO per key: `maxConcurrentPerKey` acquisitions proceed immediately, the rest queue and are
 * released in arrival order. Each `acquire` resolves with its own release function; calling it
 * more than once is a no-op past the first call. */
export function createLlmLimiter(opts: { maxConcurrentPerKey: number }): LlmLimiter {
  const { maxConcurrentPerKey } = opts
  const states = new Map<string, KeyState>()

  function stateFor(key: string): KeyState {
    let state = states.get(key)
    if (!state) {
      state = { active: 0, queue: [] }
      states.set(key, state)
    }
    return state
  }

  function makeRelease(key: string): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      const state = stateFor(key)
      const next = state.queue.shift()
      if (next) {
        // Hand the slot directly to the earliest waiter — the active count never dips to reflect
        // a momentarily-free slot that was never actually free.
        next()
      } else {
        state.active -= 1
      }
    }
  }

  return {
    async acquire(key: string): Promise<() => void> {
      const state = stateFor(key)
      if (state.active < maxConcurrentPerKey) {
        state.active += 1
        return makeRelease(key)
      }
      return new Promise<() => void>((resolve) => {
        state.queue.push(() => resolve(makeRelease(key)))
      })
    },
    inFlight(key: string): number {
      return states.get(key)?.active ?? 0
    },
  }
}

/** Wraps `inner` so every `chat()` call acquires a limiter slot first and always releases it —
 * in a `finally`, so an inner throw can never leak a slot. */
export function withLimiter(inner: LlmProvider, limiter: LlmLimiter, keyFor?: (req: ChatRequest<unknown>) => string): LlmProvider {
  return {
    kind: inner.kind,

    capabilities(model: string) {
      return inner.capabilities(model)
    },

    async chat<T>(req: ChatRequest<T>): Promise<ChatResult<T>> {
      const key = keyFor ? keyFor(req as ChatRequest<unknown>) : `managed:${inner.kind}:${req.model}`
      const release = await limiter.acquire(key)
      try {
        return await inner.chat(req)
      } finally {
        release()
      }
    },
  }
}
