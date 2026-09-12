import { Secret } from '@aesa/crypto'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createOpenAiCompatibleProvider } from '../src/adapters/openai-compatible/index.ts'
import { LlmError } from '../src/core/errors.ts'
import type { ChatRequest } from '../src/core/types.ts'
import { capturingFetch, jsonResponse } from './helpers/fetch-stub.ts'

const Schema = z.object({ category: z.enum(['toys', 'other']), is_spam: z.boolean() })
type Verdict = z.infer<typeof Schema>

const base = (over: Partial<ChatRequest<Verdict>> = {}): ChatRequest<Verdict> => ({
  model: 'gpt-5-mini',
  system: [
    { id: 'a', text: 'Rules.', stability: 'static' },
    { id: 'b', text: 'Persona.', stability: 'agent' },
    { id: 'c', text: 'Now.', stability: 'volatile' },
  ],
  messages: [{ role: 'user', content: 'hello' }],
  output: { name: 'triage', schema: Schema },
  maxOutputTokens: 256,
  meta: { orgId: 'org_1', role: 'triage', idempotencyKey: 'k' },
  ...over,
})

const completion = (over: Record<string, unknown> = {}) => ({
  id: 'chatcmpl-1',
  object: 'chat.completion',
  model: 'gpt-5-mini',
  choices: [
    {
      index: 0,
      finish_reason: 'stop',
      message: { role: 'assistant', content: '{"decision":{"category":"toys","is_spam":false}}', refusal: null },
    },
  ],
  usage: { prompt_tokens: 12, completion_tokens: 6, prompt_tokens_details: { cached_tokens: 4 }, completion_tokens_details: { reasoning_tokens: 2 } },
  ...over,
})

const make = (fetchFn: typeof fetch, kind: 'openai' | 'deepseek' | 'custom' = 'openai') =>
  createOpenAiCompatibleProvider({ kind, apiKey: new Secret('sk-test-key-1234567890'), baseUrl: 'https://api.example.test/v1', fetchFn })

describe('createOpenAiCompatibleProvider', () => {
  it('concatenates the system blocks IN ORDER into one system message and sends the native json_schema envelope non-strict', async () => {
    const { fetchFn, bodies } = capturingFetch(() => jsonResponse(completion()))
    const res = await make(fetchFn).chat(base())
    const body = bodies[0]!
    expect((body.messages as { role: string; content: string }[])[0]).toEqual({ role: 'system', content: 'Rules.\n\nPersona.\n\nNow.' })
    expect(body.response_format).toMatchObject({ type: 'json_schema', json_schema: { name: 'triage', strict: false } })
    expect(body.max_completion_tokens).toBe(256) // OpenAI's parameter; DeepSeek/custom send max_tokens
    expect(res.parsed).toEqual({ category: 'toys', is_spam: false })
    expect(res.parseStrategy).toBe('native')
    expect(res.usage).toMatchObject({ inputTokens: 8, cacheReadTokens: 4, outputTokens: 6, cacheWriteTokens: 0, apiCalls: 1 }) // prompt 12 − cached 4
    expect(res.provider).toBe('openai')
    expect(res.providerRequestId).toBe('chatcmpl-1')
  })

  it('json_mode sends response_format json_object AND mentions JSON in the system text (DeepSeek requires the word)', async () => {
    const { fetchFn, bodies } = capturingFetch(() => jsonResponse(completion()))
    const res = await make(fetchFn, 'deepseek').chat(base({ model: 'deepseek-chat', output: { name: 'triage', schema: Schema, mode: 'json_mode' } }))
    expect(bodies[0]!.response_format).toEqual({ type: 'json_object' })
    expect((bodies[0]!.messages as { content: string }[])[0]!.content).toMatch(/JSON/)
    expect(bodies[0]!.max_tokens).toBe(256)
    expect(res.parseStrategy).toBe('json_mode')
  })

  it('a plain call (no output) sends no response_format and returns parsed null', async () => {
    const { fetchFn, bodies } = capturingFetch(() =>
      jsonResponse(completion({ choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'OK', refusal: null } }] })),
    )
    const res = await make(fetchFn).chat(base({ output: undefined }))
    expect(bodies[0]!.response_format).toBeUndefined()
    expect(res.text).toBe('OK')
    expect(res.parsed).toBeNull()
  })

  it('effort maps to reasoning_effort only for a model whose capabilities say so', async () => {
    const { fetchFn, bodies } = capturingFetch(() => jsonResponse(completion()))
    await make(fetchFn).chat(base({ model: 'gpt-5', effort: 'high' }))
    expect(bodies[0]!.reasoning_effort).toBe('high')
    await make(fetchFn, 'custom').chat(base({ model: 'qwen3:8b', effort: 'high' }))
    expect(bodies[1]!.reasoning_effort).toBeUndefined()
  })

  it('finish and refusal mapping', async () => {
    const { fetchFn } = capturingFetch(() =>
      jsonResponse(completion({ choices: [{ index: 0, finish_reason: 'content_filter', message: { role: 'assistant', content: null, refusal: 'no' } }] })),
    )
    const res = await make(fetchFn).chat(base())
    expect(res.finish).toBe('refusal')
    expect(res.parsed).toBeNull()
    const { fetchFn: f2 } = capturingFetch(() =>
      jsonResponse(completion({ choices: [{ index: 0, finish_reason: 'length', message: { role: 'assistant', content: '{', refusal: null } }] })),
    )
    expect((await make(f2).chat(base())).finish).toBe('length')
  })

  it.each([
    [401, 'auth', false],
    [403, 'auth', false],
    [429, 'rate_limit', true],
    [500, 'transient', true],
    [400, 'permanent', false],
  ])('HTTP %s → LlmError %s (retryable %s), with the key scrubbed from the message', async (status, code, retryable) => {
    const { fetchFn } = capturingFetch(() =>
      jsonResponse({ error: { message: `bad sk-test-key-1234567890 Bearer sk-test-key-1234567890`, type: 'x' } }, {
        status: status as number,
        headers: status === 429 ? { 'retry-after': '3' } : {},
      }),
    )
    const err = await make(fetchFn).chat(base()).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LlmError)
    expect((err as LlmError).code).toBe(code)
    expect((err as LlmError).retryable).toBe(retryable)
    expect((err as LlmError).message).not.toContain('sk-test-key')
    if (status === 429) expect((err as LlmError).retryAfterMs).toBe(3000)
  })

  it('a 400 whose message names the context length is context_too_long', async () => {
    const { fetchFn } = capturingFetch(() =>
      jsonResponse({ error: { message: "This model's maximum context length is 128000 tokens", type: 'invalid_request_error' } }, { status: 400 }),
    )
    expect(((await make(fetchFn).chat(base()).catch((e: unknown) => e)) as LlmError).code).toBe('context_too_long')
  })

  it('listModels returns the ids', async () => {
    const { fetchFn } = capturingFetch(() => jsonResponse({ object: 'list', data: [{ id: 'gpt-5', object: 'model' }, { id: 'gpt-5-mini', object: 'model' }] }))
    expect(await make(fetchFn).listModels!()).toEqual(['gpt-5', 'gpt-5-mini'])
  })

  it('capabilities: a listed model, an unlisted model (json_mode, no effort), and the override hook', () => {
    const p = make(capturingFetch(() => jsonResponse(completion())).fetchFn)
    expect(p.capabilities('gpt-5')).toEqual({ structuredOutput: 'native', tools: true, effort: true, cacheMinTokens: null })
    expect(p.capabilities('mystery')).toEqual({ structuredOutput: 'json_mode', tools: false, effort: false, cacheMinTokens: null })
    const o = createOpenAiCompatibleProvider({
      kind: 'custom',
      apiKey: new Secret('sk-x'),
      baseUrl: 'https://x.test/v1',
      capabilitiesOverride: (_m, c) => ({ ...c, structuredOutput: 'none' }),
    })
    expect(o.capabilities('anything').structuredOutput).toBe('none')
  })
})
