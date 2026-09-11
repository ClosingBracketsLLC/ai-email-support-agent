import { describe, expect, it } from 'vitest'
import { createLlmLimiter, withLimiter } from '../src/core/limiter.ts'
import type { ChatRequest, ChatResult, ChatUsage, LlmProvider } from '../src/core/types.ts'

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

const ZERO_USAGE: ChatUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, apiCalls: 1 }

function okResult<T>(model: string): ChatResult<T> {
  return { text: '', parsed: null, parseStrategy: 'none', usage: ZERO_USAGE, finish: 'stop', provider: 'fake', model, latencyMs: 0 }
}

function baseRequest(model = 'claude-haiku-4-5'): ChatRequest<unknown> {
  return {
    model,
    system: [],
    messages: [{ role: 'user', content: 'hi' }],
    maxOutputTokens: 100,
    meta: { orgId: 'org_1', role: 'triage', idempotencyKey: 'k' },
  }
}

describe('createLlmLimiter', () => {
  it('lets up to maxConcurrentPerKey acquisitions proceed immediately', async () => {
    const limiter = createLlmLimiter({ maxConcurrentPerKey: 2 })

    const release1 = await limiter.acquire('key')
    const release2 = await limiter.acquire('key')

    expect(limiter.inFlight('key')).toBe(2)
    release1()
    release2()
    expect(limiter.inFlight('key')).toBe(0)
  })

  it('queues acquisitions beyond the limit FIFO, releasing to the earliest waiter first', async () => {
    const limiter = createLlmLimiter({ maxConcurrentPerKey: 2 })
    const release1 = await limiter.acquire('key')
    const release2 = await limiter.acquire('key')
    expect(limiter.inFlight('key')).toBe(2)

    const order: string[] = []
    const p3 = limiter.acquire('key').then((release) => {
      order.push('third')
      return release
    })
    const p4 = limiter.acquire('key').then((release) => {
      order.push('fourth')
      return release
    })

    await flushMicrotasks()
    expect(order).toEqual([])
    expect(limiter.inFlight('key')).toBe(2)

    release1()
    const release3 = await p3
    expect(order).toEqual(['third'])
    expect(limiter.inFlight('key')).toBe(2)

    release3()
    const release4 = await p4
    expect(order).toEqual(['third', 'fourth'])
    release4()
    release2()
    expect(limiter.inFlight('key')).toBe(0)
  })

  it('does not block a different key', async () => {
    const limiter = createLlmLimiter({ maxConcurrentPerKey: 1 })
    const releaseA = await limiter.acquire('key-a')

    let acquiredB = false
    const releaseB = await limiter.acquire('key-b')
    acquiredB = true

    expect(acquiredB).toBe(true)
    expect(limiter.inFlight('key-a')).toBe(1)
    expect(limiter.inFlight('key-b')).toBe(1)
    releaseA()
    releaseB()
  })

  it('release is idempotent — calling it twice frees only one slot', async () => {
    const limiter = createLlmLimiter({ maxConcurrentPerKey: 1 })
    const release = await limiter.acquire('key')
    expect(limiter.inFlight('key')).toBe(1)

    release()
    release()

    expect(limiter.inFlight('key')).toBe(0)
  })

  it('inFlight reports 0 for a key nothing has acquired', () => {
    const limiter = createLlmLimiter({ maxConcurrentPerKey: 3 })
    expect(limiter.inFlight('unused')).toBe(0)
  })
})

describe('withLimiter', () => {
  it('the third of three concurrent chats on one model starts only after a release', async () => {
    const limiter = createLlmLimiter({ maxConcurrentPerKey: 2 })
    const gates = [deferred<void>(), deferred<void>(), deferred<void>()]
    const started: number[] = []

    const inner: LlmProvider = {
      kind: 'fake',
      capabilities: () => ({ structuredOutput: 'native', tools: true, effort: true, cacheMinTokens: null }),
      async chat<T>(req: ChatRequest<T>): Promise<ChatResult<T>> {
        const n = started.length
        started.push(n)
        await gates[n]!.promise
        return okResult<T>(req.model)
      },
    }

    const limited = withLimiter(inner, limiter)

    const p1 = limited.chat(baseRequest())
    const p2 = limited.chat(baseRequest())
    const p3 = limited.chat(baseRequest())

    await flushMicrotasks()
    expect(started).toEqual([0, 1])

    gates[0]!.resolve()
    await p1
    await flushMicrotasks()
    expect(started).toEqual([0, 1, 2])

    gates[1]!.resolve()
    gates[2]!.resolve()
    await p2
    await p3
  })

  it('different models do not block each other under the default key', async () => {
    const limiter = createLlmLimiter({ maxConcurrentPerKey: 1 })
    const gateA = deferred<void>()

    const inner: LlmProvider = {
      kind: 'fake',
      capabilities: () => ({ structuredOutput: 'native', tools: true, effort: true, cacheMinTokens: null }),
      async chat<T>(req: ChatRequest<T>): Promise<ChatResult<T>> {
        if (req.model === 'model-a') await gateA.promise
        return okResult<T>(req.model)
      },
    }
    const limited = withLimiter(inner, limiter)

    const pA = limited.chat(baseRequest('model-a'))
    let bDone = false
    const pB = limited.chat(baseRequest('model-b')).then((r) => {
      bDone = true
      return r
    })

    await pB
    expect(bDone).toBe(true)
    gateA.resolve()
    await pA
  })

  it('releases the slot even when the inner call throws (finally, not just on success)', async () => {
    const limiter = createLlmLimiter({ maxConcurrentPerKey: 1 })
    const inner: LlmProvider = {
      kind: 'fake',
      capabilities: () => ({ structuredOutput: 'native', tools: true, effort: true, cacheMinTokens: null }),
      async chat() {
        throw new Error('boom')
      },
    }
    const limited = withLimiter(inner, limiter)

    await expect(limited.chat(baseRequest())).rejects.toThrow('boom')
    expect(limiter.inFlight('managed:fake:claude-haiku-4-5')).toBe(0)

    // The freed slot is usable by a subsequent call.
    const inner2: LlmProvider = {
      kind: 'fake',
      capabilities: () => ({ structuredOutput: 'native', tools: true, effort: true, cacheMinTokens: null }),
      async chat<T>(req: ChatRequest<T>): Promise<ChatResult<T>> {
        return okResult<T>(req.model)
      },
    }
    const limited2 = withLimiter(inner2, limiter)
    const result = await limited2.chat(baseRequest())
    expect(result.finish).toBe('stop')
  })

  it('accepts a custom keyFor function instead of the default managed:${kind}:${model} key', async () => {
    const limiter = createLlmLimiter({ maxConcurrentPerKey: 1 })
    const seenKeys: string[] = []
    const inner: LlmProvider = {
      kind: 'fake',
      capabilities: () => ({ structuredOutput: 'native', tools: true, effort: true, cacheMinTokens: null }),
      async chat<T>(req: ChatRequest<T>): Promise<ChatResult<T>> {
        return okResult<T>(req.model)
      },
    }
    const keyFor = (req: ChatRequest<unknown>) => {
      const key = `byok:${req.meta.orgId}`
      seenKeys.push(key)
      return key
    }
    const limited = withLimiter(inner, limiter, keyFor)

    await limited.chat(baseRequest())

    expect(seenKeys).toEqual(['byok:org_1'])
  })

  it('forwards kind and capabilities to the inner provider', () => {
    const limiter = createLlmLimiter({ maxConcurrentPerKey: 1 })
    const inner: LlmProvider = {
      kind: 'fake-inner',
      capabilities: () => ({ structuredOutput: 'native', tools: true, effort: true, cacheMinTokens: null }),
      async chat<T>(req: ChatRequest<T>): Promise<ChatResult<T>> {
        return okResult<T>(req.model)
      },
    }
    const limited = withLimiter(inner, limiter)

    expect(limited.kind).toBe('fake-inner')
    expect(limited.capabilities('any-model')).toEqual(inner.capabilities('any-model'))
  })
})
