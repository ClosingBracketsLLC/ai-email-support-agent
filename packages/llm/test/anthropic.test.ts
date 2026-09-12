import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Secret } from '@aesa/crypto'
import { describe, expect, it, vi } from 'vitest'
import { createAnthropicProvider } from '../src/adapters/anthropic/index.ts'
import { LlmError } from '../src/core/errors.ts'
import type { ChatRequest } from '../src/core/types.ts'
import { capturingFetch, jsonResponse } from './helpers/fetch-stub.ts'
import { z } from 'zod'

const OUTPUT_SCHEMA = z.object({
  category: z.enum(['toys', 'other']),
  is_spam: z.boolean(),
})
type Verdict = z.infer<typeof OUTPUT_SCHEMA>

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'anthropic')

function loadFixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(FIXTURES_DIR, name), 'utf8')) as Record<string, unknown>
}

function baseRequest(overrides: Partial<ChatRequest<Verdict>> = {}): ChatRequest<Verdict> {
  return {
    model: 'claude-haiku-4-5',
    system: [{ id: 'sys', text: 'You classify support email.', stability: 'static' }],
    messages: [{ role: 'user', content: 'hello' }],
    // Today's forced-tool path, pinned explicitly to the json_mode rung so the pre-existing
    // tests below keep exercising it regardless of what the adapter picks by default for a
    // model whose capability is 'native' (see the (d)/(e) tests for that default).
    output: { name: 'triage', schema: OUTPUT_SCHEMA, mode: 'json_mode' },
    maxOutputTokens: 256,
    meta: { orgId: 'org_1', role: 'triage', idempotencyKey: 'key-1' },
    ...overrides,
  }
}

function anthropicMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'msg_123',
    type: 'message',
    role: 'assistant',
    model: 'claude-haiku-4-5',
    // The forced tool now asks for the envelope shape too (task brief) — the caller's schema
    // wrapped as `{ decision: <schema> }` — so the API never sees a top-level discriminated
    // union without `type: 'object'`.
    content: [{ type: 'tool_use', id: 'toolu_1', name: 'triage', input: { decision: { category: 'toys', is_spam: false } } }],
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    ...overrides,
  }
}

function errorResponse(type: string, message: string, init: { status: number; headers?: Record<string, string> }): Response {
  return jsonResponse({ type: 'error', error: { type, message } }, init)
}

describe('createAnthropicProvider', () => {
  it('sends a forced-tool request carrying tool_choice and the envelope-wrapped, zod-derived json schema, with $schema stripped', async () => {
    const { fetchFn, bodies } = capturingFetch(() => jsonResponse(anthropicMessage()))

    const provider = createAnthropicProvider({ apiKey: new Secret('sk-ant-test-key'), fetchFn })
    await provider.chat(baseRequest())

    expect(fetchFn).toHaveBeenCalledTimes(1)
    const capturedBody = bodies[0]
    expect(capturedBody?.tool_choice).toEqual({ type: 'tool', name: 'triage' })
    const tools = capturedBody?.tools as { name: string; description: string; input_schema: Record<string, unknown> }[]
    expect(tools).toHaveLength(1)
    expect(tools[0]?.name).toBe('triage')
    expect(tools[0]?.description).toBe('Record the structured result.')
    const inputSchema = tools[0]?.input_schema
    expect(inputSchema?.type).toBe('object')
    expect(inputSchema?.required).toEqual(['decision'])
    expect(inputSchema?.$schema).toBeUndefined()
    const decisionSchema = (inputSchema?.properties as Record<string, Record<string, unknown>> | undefined)?.decision
    expect(decisionSchema?.type).toBe('object')
    expect(decisionSchema?.properties).toMatchObject({ category: expect.any(Object), is_spam: expect.any(Object) })
  })

  it('renders each SystemBlock as an ordered Anthropic text block', async () => {
    const { fetchFn, bodies } = capturingFetch(() => jsonResponse(anthropicMessage()))

    const provider = createAnthropicProvider({ apiKey: new Secret('sk-ant-test-key'), fetchFn })
    await provider.chat(
      baseRequest({
        system: [
          { id: 'first', text: 'First block.', stability: 'static' },
          { id: 'second', text: 'Second block.', stability: 'agent' },
          { id: 'third', text: 'Third block.', stability: 'volatile' },
        ],
      }),
    )

    // Every block is far under claude-haiku-4-5's 4096-token cache minimum, and no
    // agentBreakpoint was requested, so none of the three blocks carries cache_control.
    expect(bodies[0]?.system).toEqual([
      { type: 'text', text: 'First block.' },
      { type: 'text', text: 'Second block.' },
      { type: 'text', text: 'Third block.' },
    ])
  })

  it('parses a valid envelope-wrapped tool_use response on the json_mode rung', async () => {
    const fetchFn = (async () => jsonResponse(anthropicMessage())) as unknown as typeof fetch
    const provider = createAnthropicProvider({ apiKey: new Secret('sk-ant-test-key'), fetchFn })

    const result = await provider.chat(baseRequest())

    expect(result.parseStrategy).toBe('json_mode')
    expect(result.parsed).toEqual({ category: 'toys', is_spam: false })
    expect(result.finish).toBe('stop')
    expect(result.provider).toBe('anthropic')
    expect(result.model).toBe('claude-haiku-4-5')
    expect(result.providerRequestId).toBe('msg_123')
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, apiCalls: 1 })
    // Regression: `llm_calls.latency_ms` is an integer column downstream; performance.now() - start
    // is a float, so the adapter must round before handing latencyMs to the caller.
    expect(Number.isInteger(result.latencyMs)).toBe(true)
  })

  it('returns parsed null with no throw when the enveloped tool_use input violates the schema', async () => {
    const fetchFn = (async () =>
      jsonResponse(
        anthropicMessage({
          content: [{ type: 'tool_use', id: 'toolu_1', name: 'triage', input: { decision: { category: 'not-a-real-category', is_spam: 'nope' } } }],
        }),
      )) as unknown as typeof fetch
    const provider = createAnthropicProvider({ apiKey: new Secret('sk-ant-test-key'), fetchFn })

    const result = await provider.chat(baseRequest())

    expect(result.parsed).toBeNull()
    expect(result.parseStrategy).toBe('none')
  })

  it('makes a plain-text call with no forced tool and no output_config when the request carries no output schema', async () => {
    const { fetchFn, bodies } = capturingFetch(() =>
      jsonResponse(anthropicMessage({ content: [{ type: 'text', text: 'hello back' }], stop_reason: 'end_turn' })),
    )
    const provider = createAnthropicProvider({ apiKey: new Secret('sk-ant-test-key'), fetchFn })

    const result = await provider.chat(baseRequest({ output: undefined }))

    expect(bodies[0]?.tools).toBeUndefined()
    expect(bodies[0]?.tool_choice).toBeUndefined()
    expect(bodies[0]?.output_config).toBeUndefined()
    expect(result.text).toBe('hello back')
    expect(result.parsed).toBeNull()
    expect(result.parseStrategy).toBe('none')
  })

  // --- Task 6 additions: cache breakpoints, effort, native structured output, ordering guard ---

  it('(a) places a 1h breakpoint on the last static block, an opt-in 5m breakpoint on the last agent block, and never on volatile', async () => {
    const longStatic = 'x'.repeat(2048) // estimateTokens = 512, clears claude-opus-5's 512 min
    const { fetchFn, bodies } = capturingFetch(() => jsonResponse(anthropicMessage()))
    const provider = createAnthropicProvider({ apiKey: new Secret('sk-ant-test-key'), fetchFn })

    await provider.chat(
      baseRequest({
        model: 'claude-opus-5',
        system: [
          { id: 'first', text: longStatic, stability: 'static' },
          { id: 'second', text: 'Agent instructions.', stability: 'agent' },
          { id: 'third', text: 'Customer message.', stability: 'volatile' },
        ],
        cache: { agentBreakpoint: true },
      }),
    )

    expect(bodies[0]?.system).toEqual([
      { type: 'text', text: longStatic, cache_control: { type: 'ephemeral', ttl: '1h' } },
      { type: 'text', text: 'Agent instructions.', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'Customer message.' },
    ])
  })

  it('(a2) the per-agent breakpoint is opt-in — omitted without cache.agentBreakpoint even past the model minimum', async () => {
    const longStatic = 'x'.repeat(2048)
    const { fetchFn, bodies } = capturingFetch(() => jsonResponse(anthropicMessage()))
    const provider = createAnthropicProvider({ apiKey: new Secret('sk-ant-test-key'), fetchFn })

    await provider.chat(
      baseRequest({
        model: 'claude-opus-5',
        system: [
          { id: 'first', text: longStatic, stability: 'static' },
          { id: 'second', text: 'Agent instructions.', stability: 'agent' },
        ],
      }),
    )

    expect(bodies[0]?.system).toEqual([
      { type: 'text', text: longStatic, cache_control: { type: 'ephemeral', ttl: '1h' } },
      { type: 'text', text: 'Agent instructions.' },
    ])
  })

  it('(b) skips the static breakpoint when the static prefix is under the model minimum', async () => {
    const shortStatic = 'x'.repeat(200) // estimateTokens = 50, under claude-opus-5's 512 min
    const { fetchFn, bodies } = capturingFetch(() => jsonResponse(anthropicMessage()))
    const provider = createAnthropicProvider({ apiKey: new Secret('sk-ant-test-key'), fetchFn })

    await provider.chat(baseRequest({ model: 'claude-opus-5', system: [{ id: 'only', text: shortStatic, stability: 'static' }] }))

    expect(bodies[0]?.system).toEqual([{ type: 'text', text: shortStatic }])
  })

  it('(c) forwards effort to output_config.effort only when the model capability allows it', async () => {
    const capable = capturingFetch(() => jsonResponse(anthropicMessage({ model: 'claude-opus-5' })))
    const providerOpus = createAnthropicProvider({ apiKey: new Secret('sk-ant-test-key'), fetchFn: capable.fetchFn })
    await providerOpus.chat(baseRequest({ model: 'claude-opus-5', effort: 'high' }))
    expect(capable.bodies[0]?.output_config).toMatchObject({ effort: 'high' })

    const incapable = capturingFetch(() => jsonResponse(anthropicMessage()))
    const providerHaiku = createAnthropicProvider({ apiKey: new Secret('sk-ant-test-key'), fetchFn: incapable.fetchFn })
    await providerHaiku.chat(baseRequest({ model: 'claude-haiku-4-5', effort: 'high' }))
    const haikuOutputConfig = incapable.bodies[0]?.output_config as Record<string, unknown> | undefined
    expect(haikuOutputConfig?.effort).toBeUndefined()
    // Ledger 70: not merely an absent `effort` — with nothing else to put in it, `output_config`
    // itself must be left off the request body rather than sent as an empty object.
    expect(incapable.bodies[0]).not.toHaveProperty('output_config')
  })

  it('(c2) places each breakpoint on the LAST block of its stability, never the first (ledger 71)', async () => {
    const longStatic = 'x'.repeat(2048) // estimateTokens = 512, clears claude-opus-5's 512 min on its own
    const { fetchFn, bodies } = capturingFetch(() => jsonResponse(anthropicMessage({ model: 'claude-opus-5' })))
    const provider = createAnthropicProvider({ apiKey: new Secret('sk-ant-test-key'), fetchFn })

    await provider.chat(
      baseRequest({
        model: 'claude-opus-5',
        system: [
          { id: 's1', text: longStatic, stability: 'static' },
          { id: 's2', text: 'Second static block.', stability: 'static' },
          { id: 'a1', text: 'First agent block.', stability: 'agent' },
          { id: 'a2', text: 'Second agent block.', stability: 'agent' },
          { id: 'v1', text: 'Customer message.', stability: 'volatile' },
        ],
        cache: { agentBreakpoint: true },
      }),
    )

    // A `findIndex` regression would mark s1/a1 instead, splitting the prefix and losing the cache.
    expect(bodies[0]?.system).toEqual([
      { type: 'text', text: longStatic },
      { type: 'text', text: 'Second static block.', cache_control: { type: 'ephemeral', ttl: '1h' } },
      { type: 'text', text: 'First agent block.' },
      { type: 'text', text: 'Second agent block.', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'Customer message.' },
    ])
  })

  it('(d) native structured output: output_config.format carries the envelope schema, no tools, and parsed unwraps decision', async () => {
    const { fetchFn, bodies } = capturingFetch(() => jsonResponse(loadFixture('draft-native.json')))
    const provider = createAnthropicProvider({ apiKey: new Secret('sk-ant-test-key'), fetchFn })

    const result = await provider.chat(baseRequest({ model: 'claude-sonnet-5', output: { name: 'triage', schema: OUTPUT_SCHEMA, mode: 'native' } }))

    expect(bodies[0]?.tools).toBeUndefined()
    expect(bodies[0]?.tool_choice).toBeUndefined()
    const outputConfig = bodies[0]?.output_config as { format?: { type: string; schema: Record<string, unknown> } } | undefined
    expect(outputConfig?.format?.type).toBe('json_schema')
    expect(outputConfig?.format?.schema?.['required']).toEqual(['decision'])
    const decisionSchema = (outputConfig?.format?.schema?.['properties'] as Record<string, Record<string, unknown>> | undefined)?.decision
    expect(decisionSchema?.properties).toMatchObject({ category: expect.any(Object), is_spam: expect.any(Object) })

    expect(result.parsed).toEqual({ category: 'toys', is_spam: false })
    expect(result.parseStrategy).toBe('native')
  })

  it('(d2) native structured output returns parsed null with no throw when the JSON text violates the schema', async () => {
    const fetchFn = (async () =>
      jsonResponse({
        ...loadFixture('draft-native.json'),
        content: [{ type: 'text', text: JSON.stringify({ decision: { category: 'not-a-real-category', is_spam: 'nope' } }) }],
      })) as unknown as typeof fetch
    const provider = createAnthropicProvider({ apiKey: new Secret('sk-ant-test-key'), fetchFn })

    const result = await provider.chat(baseRequest({ model: 'claude-sonnet-5', output: { name: 'triage', schema: OUTPUT_SCHEMA, mode: 'native' } }))

    expect(result.parsed).toBeNull()
    expect(result.parseStrategy).toBe('none')
  })

  it('(d3) native structured output returns parsed null with no throw when the text block is not valid JSON', async () => {
    const fetchFn = (async () =>
      jsonResponse({ ...loadFixture('draft-native.json'), content: [{ type: 'text', text: 'not json at all' }] })) as unknown as typeof fetch
    const provider = createAnthropicProvider({ apiKey: new Secret('sk-ant-test-key'), fetchFn })

    const result = await provider.chat(baseRequest({ model: 'claude-sonnet-5', output: { name: 'triage', schema: OUTPUT_SCHEMA, mode: 'native' } }))

    expect(result.parsed).toBeNull()
    expect(result.parseStrategy).toBe('none')
  })

  it('(e) json_mode explicitly requested: the forced-tool path as before, parseStrategy json_mode', async () => {
    const { fetchFn, bodies } = capturingFetch(() => jsonResponse(anthropicMessage()))
    const provider = createAnthropicProvider({ apiKey: new Secret('sk-ant-test-key'), fetchFn })

    const result = await provider.chat(baseRequest({ output: { name: 'triage', schema: OUTPUT_SCHEMA, mode: 'json_mode' } }))

    expect(bodies[0]?.tool_choice).toEqual({ type: 'tool', name: 'triage' })
    expect(result.parseStrategy).toBe('json_mode')
    expect(result.parsed).toEqual({ category: 'toys', is_spam: false })
  })

  it('(f) throws a permanent LlmError, without ever calling fetch, when a static block follows a volatile one', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(anthropicMessage())) as unknown as typeof fetch
    const provider = createAnthropicProvider({ apiKey: new Secret('sk-ant-test-key'), fetchFn })

    await expect(
      provider.chat(
        baseRequest({
          system: [
            { id: 'v', text: 'Customer message.', stability: 'volatile' },
            { id: 's', text: 'Should not be allowed here.', stability: 'static' },
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: 'permanent' })
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('(g) reports cache_read tokens per response: 0 on the first call, 1200 on the cache-hit fixture', async () => {
    let callCount = 0
    const fetchFn = vi.fn(async () => {
      callCount += 1
      return jsonResponse(callCount === 1 ? loadFixture('draft-native.json') : loadFixture('draft-cache-hit.json'))
    }) as unknown as typeof fetch
    const provider = createAnthropicProvider({ apiKey: new Secret('sk-ant-test-key'), fetchFn })
    const req = baseRequest({ model: 'claude-sonnet-5', output: { name: 'triage', schema: OUTPUT_SCHEMA, mode: 'native' } })

    const first = await provider.chat(req)
    const second = await provider.chat(req)

    expect(first.usage.cacheReadTokens).toBe(0)
    expect(second.usage.cacheReadTokens).toBe(1200)
  })

  it('(g2) splits cache-write tokens by TTL from usage.cache_creation, keeping cacheWriteTokens as the total', async () => {
    // The cache-hit fixture is the SECOND call of a cached pair: the 1h static prefix is read back
    // (1200) while the opt-in 5m agent breakpoint writes a fresh entry (400). Pricing the 400 at the
    // 1-hour rate is the ~60% over-charge I1 (final-B) found.
    const fetchFn = vi.fn(async () => jsonResponse(loadFixture('draft-cache-hit.json'))) as unknown as typeof fetch
    const provider = createAnthropicProvider({ apiKey: new Secret('sk-ant-test-key'), fetchFn })

    const result = await provider.chat(
      baseRequest({ model: 'claude-sonnet-5', output: { name: 'triage', schema: OUTPUT_SCHEMA, mode: 'native' } }),
    )

    expect(result.usage.cacheWriteTokens).toBe(400)
    expect(result.usage.cacheWrite5mTokens).toBe(400)
    expect(result.usage.cacheWrite1hTokens).toBe(0)
  })

  it('(g3) leaves the TTL split absent when the response reports no cache_creation breakdown', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse(
        anthropicMessage({ usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 300, cache_read_input_tokens: 0 } }),
      ),
    ) as unknown as typeof fetch
    const provider = createAnthropicProvider({ apiKey: new Secret('sk-ant-test-key'), fetchFn })

    const result = await provider.chat(baseRequest())

    expect(result.usage.cacheWriteTokens).toBe(300)
    expect(result.usage.cacheWrite5mTokens).toBeUndefined()
    expect(result.usage.cacheWrite1hTokens).toBeUndefined()
  })

  it('(h) exposes capabilities per known model id, and a json_mode/no-cache fallback for an unknown one', () => {
    const provider = createAnthropicProvider({ apiKey: new Secret('sk-ant-test-key') })

    expect(provider.capabilities('claude-opus-5')).toEqual({ structuredOutput: 'native', tools: true, effort: true, cacheMinTokens: 512 })
    expect(provider.capabilities('claude-sonnet-5')).toEqual({ structuredOutput: 'native', tools: true, effort: true, cacheMinTokens: 1024 })
    expect(provider.capabilities('claude-haiku-4-5')).toEqual({ structuredOutput: 'native', tools: true, effort: false, cacheMinTokens: 4096 })
    expect(provider.capabilities('claude-nonexistent-9')).toEqual({ structuredOutput: 'json_mode', tools: true, effort: false, cacheMinTokens: null })
  })

  it('maps a 429 with a retry-after header to a retryable rate_limit LlmError in milliseconds, without the SDK retrying it itself', async () => {
    const fetchFn = vi.fn(async () =>
      errorResponse('rate_limit_error', 'rate limited', { status: 429, headers: { 'retry-after': '7' } }),
    ) as unknown as typeof fetch
    const provider = createAnthropicProvider({ apiKey: new Secret('sk-ant-test-key'), fetchFn })

    await expect(provider.chat(baseRequest())).rejects.toMatchObject({
      code: 'rate_limit',
      retryable: true,
      retryAfterMs: 7000,
    })
    // maxRetries: 0 (client.ts): a 429 is exactly the status the SDK's own default retry policy
    // would otherwise retry on. One fetch call proves that policy is actually off, not just that
    // this adapter maps the eventual error correctly.
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('maps a 401 to a non-retryable auth LlmError', async () => {
    const fetchFn = (async () => errorResponse('authentication_error', 'invalid x-api-key', { status: 401 })) as unknown as typeof fetch
    const provider = createAnthropicProvider({ apiKey: new Secret('sk-ant-test-key'), fetchFn })

    await expect(provider.chat(baseRequest())).rejects.toMatchObject({ code: 'auth', retryable: false })
  })

  it('maps a 400 that mentions context length to a non-retryable context_too_long LlmError', async () => {
    const fetchFn = (async () =>
      errorResponse('invalid_request_error', 'prompt exceeds the maximum context length for this model', {
        status: 400,
      })) as unknown as typeof fetch
    const provider = createAnthropicProvider({ apiKey: new Secret('sk-ant-test-key'), fetchFn })

    await expect(provider.chat(baseRequest())).rejects.toMatchObject({ code: 'context_too_long', retryable: false })
  })

  it('maps an unrelated 400 to a non-retryable permanent LlmError', async () => {
    const fetchFn = (async () => errorResponse('invalid_request_error', 'model field is required', { status: 400 })) as unknown as typeof fetch
    const provider = createAnthropicProvider({ apiKey: new Secret('sk-ant-test-key'), fetchFn })

    await expect(provider.chat(baseRequest())).rejects.toMatchObject({ code: 'permanent', retryable: false })
  })

  it('maps a 529 (overloaded) to a retryable transient LlmError, without the SDK retrying it itself', async () => {
    const fetchFn = vi.fn(async () => errorResponse('overloaded_error', 'overloaded', { status: 529 })) as unknown as typeof fetch
    const provider = createAnthropicProvider({ apiKey: new Secret('sk-ant-test-key'), fetchFn })

    await expect(provider.chat(baseRequest())).rejects.toMatchObject({ code: 'transient', retryable: true })
    // Same regression guard as the 429 case above: 529/5xx is the other bucket the SDK's default
    // retry policy would otherwise retry — one fetch call proves maxRetries: 0 is actually wired.
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('maps a network failure (fetch rejects) to a retryable transient LlmError', async () => {
    const fetchFn = (async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch
    const provider = createAnthropicProvider({ apiKey: new Secret('sk-ant-test-key'), fetchFn })

    await expect(provider.chat(baseRequest())).rejects.toMatchObject({ code: 'transient', retryable: true })
  })

  it('scrubs a raw api key embedded in an error message', async () => {
    const fetchFn = (async () =>
      errorResponse('invalid_request_error', 'bad request for key sk-ant-abc12345XYZ, try again', {
        status: 400,
      })) as unknown as typeof fetch
    const provider = createAnthropicProvider({ apiKey: new Secret('sk-ant-test-key'), fetchFn })

    try {
      await provider.chat(baseRequest())
      expect.unreachable('expected the call to reject')
    } catch (err) {
      expect(err).toBeInstanceOf(LlmError)
      const message = (err as LlmError).message
      expect(message).not.toContain('sk-ant-abc12345XYZ')
      expect(message).toContain('[redacted]')
    }
  })

  it('scrubs a Bearer-header tail embedded in an error message', async () => {
    const fetchFn = (async () =>
      errorResponse('invalid_request_error', 'rejected header Authorization: Bearer sk-ant-super-secret-token', {
        status: 400,
      })) as unknown as typeof fetch
    const provider = createAnthropicProvider({ apiKey: new Secret('sk-ant-test-key'), fetchFn })

    try {
      await provider.chat(baseRequest())
      expect.unreachable('expected the call to reject')
    } catch (err) {
      const message = (err as LlmError).message
      expect(message).not.toContain('sk-ant-super-secret-token')
    }
  })

  it('scrubs a Bearer tail that is not sk-shaped (exercises BEARER_PATTERN, not just the key pattern)', async () => {
    const fetchFn = (async () =>
      errorResponse('invalid_request_error', 'rejected header Authorization: Bearer zqx-TOKEN-9981', {
        status: 400,
      })) as unknown as typeof fetch
    const provider = createAnthropicProvider({ apiKey: new Secret('sk-ant-test-key'), fetchFn })

    try {
      await provider.chat(baseRequest())
      expect.unreachable('expected the call to reject')
    } catch (err) {
      const message = (err as LlmError).message
      // Not sk-shaped, so API_KEY_PATTERN alone would let this straight through — only
      // BEARER_PATTERN catches it. Deleting BEARER_PATTERN would make this test fail.
      expect(message).not.toContain('zqx-TOKEN-9981')
      expect(message).toContain('Bearer [redacted]')
    }
  })

  it('scrubs both an sk- token and a Bearer tail out of a network-level throw (fetch rejects, never reaches the SDK HTTP-error mapper)', async () => {
    const fetchFn = (async () => {
      throw new TypeError('fetch failed: Authorization: Bearer sk-ant-supersecret at https://api.anthropic.com/v1/messages')
    }) as unknown as typeof fetch
    const provider = createAnthropicProvider({ apiKey: new Secret('sk-ant-test-key'), fetchFn })

    try {
      await provider.chat(baseRequest())
      expect.unreachable('expected the call to reject')
    } catch (err) {
      expect(err).toBeInstanceOf(LlmError)
      expect(err).toMatchObject({ code: 'transient', retryable: true })
      const message = (err as LlmError).message
      // The SDK collapses a raw fetch throw into APIConnectionError with the fixed message
      // "Connection error." — the original TypeError (and whatever secret it carried) survives
      // only on `.cause`. This asserts the adapter actually folds that cause text in (so there is
      // real content to scrub here, not a vacuously secret-free message) AND scrubs it.
      expect(message).toContain('fetch failed')
      expect(message).not.toContain('sk-ant-supersecret')
      expect(message).not.toContain('Bearer sk-ant-supersecret')
      expect(message).toContain('[redacted]')
    }
  })

  it('propagates an aborted signal as a rejected LlmError', async () => {
    const controller = new AbortController()
    const fetchFn = (async (_url: string | URL, init?: RequestInit) => {
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('aborted')
          err.name = 'AbortError'
          reject(err)
        })
      })
    }) as unknown as typeof fetch
    const provider = createAnthropicProvider({ apiKey: new Secret('sk-ant-test-key'), fetchFn })

    const promise = provider.chat(baseRequest({ signal: controller.signal }))
    controller.abort()

    await expect(promise).rejects.toMatchObject({ code: 'transient', retryable: true })
  })

  it('maps a refusal stop_reason to finish "refusal"', async () => {
    const fetchFn = (async () =>
      jsonResponse(anthropicMessage({ content: [{ type: 'text', text: '' }], stop_reason: 'refusal' }))) as unknown as typeof fetch
    const provider = createAnthropicProvider({ apiKey: new Secret('sk-ant-test-key'), fetchFn })

    const result = await provider.chat(baseRequest({ output: undefined }))

    expect(result.finish).toBe('refusal')
  })

  it('maps a max_tokens stop_reason to finish "length"', async () => {
    const fetchFn = (async () =>
      jsonResponse(anthropicMessage({ content: [{ type: 'text', text: 'cut off' }], stop_reason: 'max_tokens' }))) as unknown as typeof fetch
    const provider = createAnthropicProvider({ apiKey: new Secret('sk-ant-test-key'), fetchFn })

    const result = await provider.chat(baseRequest({ output: undefined }))

    expect(result.finish).toBe('length')
  })
})
