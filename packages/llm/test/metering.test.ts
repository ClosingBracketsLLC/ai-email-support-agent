import { describe, expect, it, vi } from 'vitest'
import { LlmError } from '../src/core/errors.ts'
import type { ChatRequest, ChatResult, ChatUsage, LlmProvider } from '../src/core/types.ts'
import { withMetering } from '../src/metering/with-metering.ts'
import type { MeterRecord, MeterSink } from '../src/metering/types.ts'
import { computeCostMicros } from '../src/pricing/cost.ts'
import { findPricing, PRICING_SEED } from '../src/pricing/seed.ts'

function baseRequest(overrides: Partial<ChatRequest<unknown>> = {}): ChatRequest<unknown> {
  return {
    model: 'claude-sonnet-5',
    system: [],
    messages: [{ role: 'user', content: 'hi' }],
    maxOutputTokens: 200,
    meta: { orgId: 'org_1', agentId: 'agent_1', runId: 'run_1', role: 'draft', idempotencyKey: 'k' },
    ...overrides,
  }
}

function usage(overrides: Partial<ChatUsage> = {}): ChatUsage {
  return { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0, apiCalls: 1, ...overrides }
}

function successProvider(overrides: Partial<ChatResult<unknown>> = {}): LlmProvider {
  return {
    kind: 'fake',
    capabilities: () => ({ structuredOutput: 'native', tools: true, effort: true, cacheMinTokens: null }),
    async chat<T>(req: ChatRequest<T>): Promise<ChatResult<T>> {
      return {
        text: '',
        parsed: null,
        parseStrategy: 'none',
        usage: usage(),
        finish: 'stop',
        provider: 'anthropic',
        model: req.model,
        latencyMs: 12,
        ...overrides,
      } as ChatResult<T>
    },
  }
}

function throwingProvider(err: unknown): LlmProvider {
  return {
    kind: 'fake',
    capabilities: () => ({ structuredOutput: 'native', tools: true, effort: true, cacheMinTokens: null }),
    async chat() {
      throw err
    },
  }
}

function recordingSink(): MeterSink & { records: MeterRecord[] } {
  const records: MeterRecord[] = []
  return {
    records,
    async record(rec: MeterRecord) {
      records.push(rec)
    },
  }
}

describe('withMetering', () => {
  it('records a success with costMicros from the Task 6 pricing seed at a 1h cache ttl, and meta fields', async () => {
    const sink = recordingSink()
    const provider = withMetering(successProvider(), sink, { cacheTtl: '1h' })

    const result = await provider.chat(baseRequest())

    expect(sink.records).toHaveLength(1)
    const rec = sink.records[0]!
    const pricing = findPricing('claude-sonnet-5', PRICING_SEED)!
    expect(rec.costMicros).toBe(computeCostMicros(usage(), pricing, '1h'))
    expect(rec.costUnknown).toBe(false)
    expect(rec.orgId).toBe('org_1')
    expect(rec.agentId).toBe('agent_1')
    expect(rec.runId).toBe('run_1')
    expect(rec.role).toBe('draft')
    expect(rec.idempotencyKey).toBe('k')
    expect(rec.provider).toBe('anthropic')
    expect(rec.model).toBe('claude-sonnet-5')
    expect(rec.usage).toEqual(usage())
    expect(rec.finish).toBe('stop')
    expect(rec.parseStrategy).toBe('none')
    expect(rec.errorCode).toBeNull()
    expect(result.text).toBe('')
  })

  it('defaults agentId/runId to null when absent from meta', async () => {
    const sink = recordingSink()
    const provider = withMetering(successProvider(), sink, { cacheTtl: '1h' })

    await provider.chat(baseRequest({ meta: { orgId: 'org_1', role: 'triage', idempotencyKey: 'k' } }))

    expect(sink.records[0]?.agentId).toBeNull()
    expect(sink.records[0]?.runId).toBeNull()
  })

  it('records zero usage, finish "error", and the errorCode on an LlmError, then rethrows', async () => {
    const sink = recordingSink()
    const err = new LlmError('boom', 'rate_limit', true)
    const provider = withMetering(throwingProvider(err), sink, { cacheTtl: '1h' })

    await expect(provider.chat(baseRequest())).rejects.toBe(err)

    expect(sink.records).toHaveLength(1)
    const rec = sink.records[0]!
    expect(rec.usage).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, apiCalls: 0 })
    expect(rec.costMicros).toBe(0)
    expect(rec.finish).toBe('error')
    expect(rec.errorCode).toBe('rate_limit')
    expect(rec.parseStrategy).toBe('none')
  })

  it('maps a non-LlmError throw to errorCode "permanent"', async () => {
    const sink = recordingSink()
    const provider = withMetering(throwingProvider(new Error('unexpected')), sink, { cacheTtl: '1h' })

    await expect(provider.chat(baseRequest())).rejects.toThrow('unexpected')

    expect(sink.records[0]?.errorCode).toBe('permanent')
    expect(sink.records[0]?.finish).toBe('error')
  })

  it('swallows a throwing sink on success and still returns the result', async () => {
    const sink: MeterSink = {
      async record() {
        throw new Error('sink is down')
      },
    }
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const provider = withMetering(successProvider({ text: 'hello' }), sink, { cacheTtl: '1h' })

    const result = await provider.chat(baseRequest())

    expect(result.text).toBe('hello')
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })

  it('swallows a throwing sink on the error path too, and still rethrows the original error', async () => {
    const sink: MeterSink = {
      async record() {
        throw new Error('sink is down')
      },
    }
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const err = new LlmError('boom', 'permanent', false)
    const provider = withMetering(throwingProvider(err), sink, { cacheTtl: '1h' })

    await expect(provider.chat(baseRequest())).rejects.toBe(err)
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })

  it('marks costUnknown true and costMicros 0 for a model with no pricing row', async () => {
    const sink = recordingSink()
    const provider = withMetering(successProvider(), sink, { cacheTtl: '1h' })

    await provider.chat(baseRequest({ model: 'claude-nonexistent-9' }))

    expect(sink.records[0]?.costUnknown).toBe(true)
    expect(sink.records[0]?.costMicros).toBe(0)
  })

  it('reports an integer latencyMs on the success path even when the inner provider timed itself with performance.now()', async () => {
    const sink = recordingSink()
    // Mimics a real adapter (e.g. the Anthropic one): times itself with performance.now() across a
    // genuine delay, so the raw elapsed value is almost certainly a non-integer float.
    const timedProvider: LlmProvider = {
      kind: 'fake',
      capabilities: () => ({ structuredOutput: 'native', tools: true, effort: true, cacheMinTokens: null }),
      async chat<T>(req: ChatRequest<T>): Promise<ChatResult<T>> {
        const start = performance.now()
        await new Promise((resolve) => setTimeout(resolve, 5))
        const latencyMs = Math.round(performance.now() - start)
        return {
          text: '', parsed: null, parseStrategy: 'none', usage: usage(), finish: 'stop',
          provider: 'anthropic', model: req.model, latencyMs,
        } as ChatResult<T>
      },
    }
    const provider = withMetering(timedProvider, sink, { cacheTtl: '1h' })

    await provider.chat(baseRequest())

    expect(sink.records).toHaveLength(1)
    expect(Number.isInteger(sink.records[0]!.latencyMs)).toBe(true)
  })

  it('reports an integer latencyMs on the error path — performance.now() - start is a float, and withMetering must round it', async () => {
    const sink = recordingSink()
    const err = new LlmError('boom', 'rate_limit', true)
    const slowThrowingProvider: LlmProvider = {
      kind: 'fake',
      capabilities: () => ({ structuredOutput: 'native', tools: true, effort: true, cacheMinTokens: null }),
      async chat(): Promise<never> {
        await new Promise((resolve) => setTimeout(resolve, 5))
        throw err
      },
    }
    const provider = withMetering(slowThrowingProvider, sink, { cacheTtl: '1h' })

    await expect(provider.chat(baseRequest())).rejects.toBe(err)

    expect(sink.records).toHaveLength(1)
    expect(Number.isInteger(sink.records[0]!.latencyMs)).toBe(true)
  })

  it('forwards kind and capabilities to the inner provider', () => {
    const inner = successProvider()
    const provider = withMetering(inner, recordingSink())

    expect(provider.kind).toBe(inner.kind)
    expect(provider.capabilities('claude-sonnet-5')).toEqual(inner.capabilities('claude-sonnet-5'))
  })
})
