import { Secret } from '@aesa/crypto'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createManagedProvider, MANAGED_MAX_CONCURRENT_PER_MODEL } from '../src/core/registry.ts'
import { createLlmLimiter } from '../src/core/limiter.ts'
import type { ChatRequest } from '../src/core/types.ts'
import type { MeterRecord, MeterSink } from '../src/metering/types.ts'

const OUTPUT_SCHEMA = z.object({ category: z.enum(['toys', 'other']), is_spam: z.boolean() })

function jsonResponse(body: unknown, init?: { status?: number; headers?: Record<string, string> }): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { 'content-type': 'application/json', ...init?.headers },
  })
}

function anthropicMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'msg_123',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-5',
    content: [{ type: 'text', text: 'not valid json' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    ...overrides,
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

function baseRequest(overrides: Partial<ChatRequest<z.infer<typeof OUTPUT_SCHEMA>>> = {}): ChatRequest<z.infer<typeof OUTPUT_SCHEMA>> {
  return {
    model: 'claude-sonnet-5',
    system: [{ id: 'sys', text: 'classify', stability: 'static' }],
    messages: [{ role: 'user', content: 'hello' }],
    output: { name: 'triage', schema: OUTPUT_SCHEMA },
    maxOutputTokens: 200,
    meta: { orgId: 'org_1', role: 'triage', idempotencyKey: 'k' },
    ...overrides,
  }
}

describe('createManagedProvider', () => {
  it('composes ladder -> limiter -> metering: one parsed result, two metering records (native then json_mode)', async () => {
    let callCount = 0
    const fetchFn = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      callCount += 1
      JSON.parse(String(init?.body)) // consume — the adapter body isn't asserted here
      if (callCount === 1) {
        return jsonResponse(anthropicMessage())
      }
      return jsonResponse(
        anthropicMessage({
          content: [{ type: 'tool_use', id: 'toolu_1', name: 'triage', input: { decision: { category: 'toys', is_spam: false } } }],
          stop_reason: 'tool_use',
        }),
      )
    }) as unknown as typeof fetch

    const sink = recordingSink()
    const provider = createManagedProvider({ apiKey: new Secret('sk-ant-test-key'), sink, fetchFn })

    const result = await provider.chat(baseRequest())

    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(result.parsed).toEqual({ category: 'toys', is_spam: false })
    expect(result.parseStrategy).toBe('json_mode')
    expect(result.usage.apiCalls).toBe(2)

    expect(sink.records).toHaveLength(2)
    expect(sink.records[0]?.idempotencyKey).toBe('k:native')
    expect(sink.records[1]?.idempotencyKey).toBe('k:json_mode')
    expect(sink.records[0]?.provider).toBe('anthropic')
    expect(sink.records[1]?.provider).toBe('anthropic')
  })

  it('forwards kind and per-model capabilities from the raw Anthropic adapter', () => {
    const provider = createManagedProvider({ apiKey: new Secret('sk-ant-test-key'), sink: recordingSink() })

    expect(provider.kind).toBe('anthropic')
    expect(provider.capabilities('claude-sonnet-5')).toEqual({ structuredOutput: 'native', tools: true, effort: true, cacheMinTokens: 1024 })
  })

  it('uses a caller-supplied limiter instead of the default when given one', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse(
        anthropicMessage({
          content: [{ type: 'tool_use', id: 'toolu_1', name: 'triage', input: { decision: { category: 'toys', is_spam: false } } }],
          stop_reason: 'tool_use',
        }),
      ),
    ) as unknown as typeof fetch

    const limiter = createLlmLimiter({ maxConcurrentPerKey: 1 })
    const acquireSpy = vi.spyOn(limiter, 'acquire')
    const provider = createManagedProvider({
      apiKey: new Secret('sk-ant-test-key'),
      sink: recordingSink(),
      fetchFn,
      limiter,
    })

    // An unrecognized model id resolves to UNKNOWN_ANTHROPIC_MODEL (structuredOutput: 'json_mode'),
    // so rung 1 (native) is skipped and exactly one call runs through the caller's limiter.
    await provider.chat(baseRequest({ model: 'claude-unknown-test-model' }))

    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(acquireSpy).toHaveBeenCalledTimes(1)
  })

  it('MANAGED_MAX_CONCURRENT_PER_MODEL is 4', () => {
    expect(MANAGED_MAX_CONCURRENT_PER_MODEL).toBe(4)
  })
})
