import { Secret } from '@aesa/crypto'
import { describe, expect, it, vi } from 'vitest'
import { createAnthropicProvider } from '../src/adapters/anthropic/index.ts'
import { LlmError } from '../src/core/errors.ts'
import type { ChatRequest } from '../src/core/types.ts'
import { z } from 'zod'

const OUTPUT_SCHEMA = z.object({
  category: z.enum(['toys', 'other']),
  is_spam: z.boolean(),
})
type Verdict = z.infer<typeof OUTPUT_SCHEMA>

function baseRequest(overrides: Partial<ChatRequest<Verdict>> = {}): ChatRequest<Verdict> {
  return {
    model: 'claude-haiku-4-5',
    system: [{ id: 'sys', text: 'You classify support email.', stability: 'static' }],
    messages: [{ role: 'user', content: 'hello' }],
    output: { name: 'triage', schema: OUTPUT_SCHEMA },
    maxOutputTokens: 256,
    meta: { orgId: 'org_1', role: 'triage', idempotencyKey: 'key-1' },
    ...overrides,
  }
}

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
    model: 'claude-haiku-4-5',
    content: [{ type: 'tool_use', id: 'toolu_1', name: 'triage', input: { category: 'toys', is_spam: false } }],
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
  it('sends a forced-tool request carrying tool_choice and the zod-derived json schema, with $schema stripped', async () => {
    let capturedBody: Record<string, unknown> | undefined
    const fetchFn = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return jsonResponse(anthropicMessage())
    }) as unknown as typeof fetch

    const provider = createAnthropicProvider({ apiKey: new Secret('sk-ant-test-key'), fetchFn })
    await provider.chat(baseRequest())

    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(capturedBody?.tool_choice).toEqual({ type: 'tool', name: 'triage' })
    const tools = capturedBody?.tools as { name: string; description: string; input_schema: Record<string, unknown> }[]
    expect(tools).toHaveLength(1)
    expect(tools[0]?.name).toBe('triage')
    expect(tools[0]?.description).toBe('Record the structured result.')
    const inputSchema = tools[0]?.input_schema
    expect(inputSchema?.type).toBe('object')
    expect(inputSchema?.properties).toMatchObject({ category: expect.any(Object), is_spam: expect.any(Object) })
    expect(inputSchema?.$schema).toBeUndefined()
  })

  it('concatenates multiple SystemBlocks in order, joined with a blank line', async () => {
    let capturedBody: Record<string, unknown> | undefined
    const fetchFn = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return jsonResponse(anthropicMessage())
    }) as unknown as typeof fetch

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

    expect(capturedBody?.system).toBe('First block.\n\nSecond block.\n\nThird block.')
  })

  it('parses a valid tool_use response natively', async () => {
    const fetchFn = (async () => jsonResponse(anthropicMessage())) as unknown as typeof fetch
    const provider = createAnthropicProvider({ apiKey: new Secret('sk-ant-test-key'), fetchFn })

    const result = await provider.chat(baseRequest())

    expect(result.parseStrategy).toBe('native')
    expect(result.parsed).toEqual({ category: 'toys', is_spam: false })
    expect(result.finish).toBe('stop')
    expect(result.provider).toBe('anthropic')
    expect(result.model).toBe('claude-haiku-4-5')
    expect(result.providerRequestId).toBe('msg_123')
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, apiCalls: 1 })
  })

  it('returns parsed null with no throw when the tool_use input violates the schema', async () => {
    const fetchFn = (async () =>
      jsonResponse(
        anthropicMessage({
          content: [{ type: 'tool_use', id: 'toolu_1', name: 'triage', input: { category: 'not-a-real-category', is_spam: 'nope' } }],
        }),
      )) as unknown as typeof fetch
    const provider = createAnthropicProvider({ apiKey: new Secret('sk-ant-test-key'), fetchFn })

    const result = await provider.chat(baseRequest())

    expect(result.parsed).toBeNull()
    expect(result.parseStrategy).toBe('none')
  })

  it('makes a plain-text call with no forced tool when the request carries no output schema', async () => {
    let capturedBody: Record<string, unknown> | undefined
    const fetchFn = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return jsonResponse(
        anthropicMessage({ content: [{ type: 'text', text: 'hello back' }], stop_reason: 'end_turn' }),
      )
    }) as unknown as typeof fetch
    const provider = createAnthropicProvider({ apiKey: new Secret('sk-ant-test-key'), fetchFn })

    const result = await provider.chat(baseRequest({ output: undefined }))

    expect(capturedBody?.tools).toBeUndefined()
    expect(capturedBody?.tool_choice).toBeUndefined()
    expect(result.text).toBe('hello back')
    expect(result.parsed).toBeNull()
    expect(result.parseStrategy).toBe('none')
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
