import { Secret } from '@aesa/crypto'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createLlmLimiter } from '../src/core/limiter.ts'
import { BYOK_MAX_CONCURRENT_PER_CREDENTIAL, createByokProvider, withMeta } from '../src/core/registry.ts'
import type { ChatRequest } from '../src/core/types.ts'
import type { MeterRecord, MeterSink } from '../src/metering/types.ts'
import { createFakeProvider } from '../src/testing/fake-provider.ts'
import { capturingFetch, jsonResponse } from './helpers/fetch-stub.ts'

const Schema = z.object({ category: z.enum(['toys', 'other']), is_spam: z.boolean() })

function recordingSink(): MeterSink & { records: MeterRecord[] } {
  const records: MeterRecord[] = []
  return { records, async record(rec: MeterRecord) { records.push(rec) } }
}

const req = (over: Partial<ChatRequest<z.infer<typeof Schema>>> = {}): ChatRequest<z.infer<typeof Schema>> => ({
  model: 'gpt-5-mini',
  system: [{ id: 'sys', text: 'classify', stability: 'static' }],
  messages: [{ role: 'user', content: 'hello' }],
  output: { name: 'triage', schema: Schema },
  maxOutputTokens: 200,
  meta: { orgId: 'org_1', role: 'triage', idempotencyKey: 'k' },
  ...over,
})

const completion = (content: string, over: Record<string, unknown> = {}) => ({
  id: 'chatcmpl-1',
  object: 'chat.completion',
  model: 'gpt-5-mini',
  choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content, refusal: null } }],
  usage: { prompt_tokens: 10, completion_tokens: 4 },
  ...over,
})

const byok = (fetchFn: typeof fetch, over: Partial<Parameters<typeof createByokProvider>[0]> = {}) =>
  createByokProvider({
    provider: 'openai',
    apiKey: new Secret('sk-byok-key-1234567890'),
    baseUrl: 'https://api.example.test/v1',
    orgId: 'org_1',
    credentialId: 'cred_1',
    sink: recordingSink(),
    limiter: createLlmLimiter({ maxConcurrentPerKey: BYOK_MAX_CONCURRENT_PER_CREDENTIAL }),
    fetchFn,
    ...over,
  })

describe('withMeta', () => {
  it('stamps mode and credentialId onto every request meta, and forwards kind/capabilities/listModels', async () => {
    const fake = Object.assign(createFakeProvider([{ text: 'hi' }], { kind: 'inner' }), { listModels: async () => ['a'] })
    const stamped = withMeta(fake, { mode: 'byok', credentialId: 'cred_1' })

    expect(stamped.kind).toBe('inner')
    expect(stamped.capabilities('m')).toEqual(fake.capabilities('m'))
    expect(await stamped.listModels!()).toEqual(['a'])

    await stamped.chat(req())
    expect(fake.calls[0]!.meta).toMatchObject({ mode: 'byok', credentialId: 'cred_1', idempotencyKey: 'k' })
  })

  it('has no listModels at all when the inner provider has none', () => {
    expect(withMeta(createFakeProvider([{ text: 'hi' }]), { mode: 'byok', credentialId: 'c' }).listModels).toBeUndefined()
  })
})

describe('createByokProvider', () => {
  it('composes ladder -> limiter -> meta -> metering over the OpenAI-compatible adapter, metering every call as byok', async () => {
    const sink = recordingSink()
    const { fetchFn } = capturingFetch(() => jsonResponse(completion('{"decision":{"category":"toys","is_spam":false}}')))
    const provider = byok(fetchFn, { sink })

    const res = await provider.chat(req())

    expect(res.parsed).toEqual({ category: 'toys', is_spam: false })
    expect(sink.records).toHaveLength(1)
    expect(sink.records[0]).toMatchObject({ mode: 'byok', credentialId: 'cred_1', provider: 'openai', idempotencyKey: 'k:native' })
  })

  it('keys the limiter per org AND credential, so one tenant cannot starve another', async () => {
    const limiter = createLlmLimiter({ maxConcurrentPerKey: BYOK_MAX_CONCURRENT_PER_CREDENTIAL })
    const acquire = vi.spyOn(limiter, 'acquire')
    const { fetchFn } = capturingFetch(() => jsonResponse(completion('{"decision":{"category":"toys","is_spam":false}}')))

    await byok(fetchFn, { limiter }).chat(req())

    expect(acquire).toHaveBeenCalledWith('byok:org_1:cred_1')
  })

  it('BYOK_MAX_CONCURRENT_PER_CREDENTIAL is 2', () => {
    expect(BYOK_MAX_CONCURRENT_PER_CREDENTIAL).toBe(2)
  })

  it('raw: true returns the metered, stamped adapter with no limiter and no ladder — the probe drives the rungs itself', async () => {
    const sink = recordingSink()
    const limiter = createLlmLimiter({ maxConcurrentPerKey: BYOK_MAX_CONCURRENT_PER_CREDENTIAL })
    const acquire = vi.spyOn(limiter, 'acquire')
    const { fetchFn, bodies } = capturingFetch(() => jsonResponse(completion('not json at all')))

    const res = await byok(fetchFn, { raw: true, sink, limiter }).chat(req())

    expect(bodies).toHaveLength(1) // the ladder would have climbed to json_mode and repair
    expect(res.parsed).toBeNull()
    expect(acquire).not.toHaveBeenCalled()
    expect(sink.records[0]).toMatchObject({ mode: 'byok', credentialId: 'cred_1' })
  })

  it('structuredOverride none forces the ladder onto the plain rung; json_mode skips the native one', async () => {
    const noneFetch = capturingFetch(() => jsonResponse(completion('{"category":"toys","is_spam":false}')))
    const none = byok(noneFetch.fetchFn, { structuredOverride: 'none' })
    expect(none.capabilities('gpt-5').structuredOutput).toBe('none')
    const res = await none.chat(req())
    expect(res.parseStrategy).toBe('plain')
    expect(noneFetch.bodies[0]!.response_format).toBeUndefined() // a PLAIN call: no adapter rung asked for

    const jsonFetch = capturingFetch(() => jsonResponse(completion('{"decision":{"category":"toys","is_spam":false}}')))
    const jsonMode = byok(jsonFetch.fetchFn, { structuredOverride: 'json_mode' })
    expect(jsonMode.capabilities('gpt-5').structuredOutput).toBe('json_mode')
    expect((await jsonMode.chat(req())).parseStrategy).toBe('json_mode')
    expect(jsonFetch.bodies[0]!.response_format).toEqual({ type: 'json_object' })
  })

  it('an anthropic BYOK key uses the Anthropic adapter and keeps its own capability table, override or not', () => {
    const provider = createByokProvider({
      provider: 'anthropic',
      apiKey: new Secret('sk-ant-byok-key-123456'),
      baseUrl: 'https://api.anthropic.com',
      orgId: 'org_1',
      credentialId: 'cred_1',
      sink: recordingSink(),
      limiter: createLlmLimiter({ maxConcurrentPerKey: BYOK_MAX_CONCURRENT_PER_CREDENTIAL }),
      structuredOverride: 'json_mode',
    })
    expect(provider.kind).toBe('anthropic')
    expect(provider.capabilities('claude-opus-5')).toEqual({ structuredOutput: 'native', tools: true, effort: true, cacheMinTokens: 512 })
  })

  it('forwards listModels through every layer', async () => {
    const { fetchFn } = capturingFetch(() => jsonResponse({ object: 'list', data: [{ id: 'gpt-5', object: 'model' }] }))
    expect(await byok(fetchFn).listModels!()).toEqual(['gpt-5'])
  })

  /** Defense in depth: a BYOK base URL is customer-supplied, so the SSRF pin is the DEFAULT transport,
   *  not something each caller has to remember to pass. `apps/worker`'s resolver still passes its own
   *  `createPinnedFetch` (that is its test seam) — this proves a caller that passes none is pinned too. */
  it('with no fetchFn, an IP-literal base URL is refused by the default pinned fetch', async () => {
    const provider = createByokProvider({
      provider: 'openai',
      apiKey: new Secret('sk-byok-key-1234567890'),
      baseUrl: 'https://10.0.0.1/v1',
      orgId: 'org_1',
      credentialId: 'cred_1',
      sink: recordingSink(),
      limiter: createLlmLimiter({ maxConcurrentPerKey: BYOK_MAX_CONCURRENT_PER_CREDENTIAL }),
    })

    await expect(provider.chat(req({ output: undefined }))).rejects.toMatchObject({
      name: 'LlmError',
      message: expect.stringMatching(/hostname, not an IP literal/),
    })
  })
})
