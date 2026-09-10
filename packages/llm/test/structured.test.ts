import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { LlmError } from '../src/core/errors.ts'
import type { ChatRequest } from '../src/core/types.ts'
import { extractBalancedJson, REPAIR_MAX_OUTPUT_TOKENS, withStructuredLadder } from '../src/core/structured.ts'
import { createFakeProvider, type FakeScript } from '../src/testing/fake-provider.ts'

const SCHEMA = z.object({ outcome: z.enum(['reply', 'escalate']), confidence: z.number() })
type Decision = z.infer<typeof SCHEMA>

function baseRequest(overrides: Partial<ChatRequest<Decision>> = {}): ChatRequest<Decision> {
  return {
    model: 'claude-sonnet-5',
    system: [{ id: 'sys', text: 'Decide.', stability: 'static' }],
    messages: [{ role: 'user', content: 'hello' }],
    output: { name: 'decision', schema: SCHEMA },
    maxOutputTokens: 512,
    meta: { orgId: 'org_1', role: 'draft', idempotencyKey: 'k' },
    ...overrides,
  }
}

describe('extractBalancedJson', () => {
  it('extracts every balanced top-level {...} span, longest first', () => {
    const spans = extractBalancedJson('Sure! {"a":1} and also {"outcome":"reply","confidence":0.9}')
    expect(spans).toEqual(['{"outcome":"reply","confidence":0.9}', '{"a":1}'])
  })

  it('ignores braces inside string literals, respecting escaped quotes', () => {
    const spans = extractBalancedJson('{"text":"a } b \\" c"}')
    expect(spans).toEqual(['{"text":"a } b \\" c"}'])
  })

  it('returns an empty array when there is no balanced brace span', () => {
    expect(extractBalancedJson('no json here at all')).toEqual([])
  })

  it('does not double-report a nested object as its own top-level span', () => {
    const spans = extractBalancedJson('{"outer":{"inner":1}}')
    expect(spans).toEqual(['{"outer":{"inner":1}}'])
  })
})

describe('withStructuredLadder', () => {
  it('passes a request with no output straight through untouched, one call', async () => {
    const fake = createFakeProvider([{ text: 'plain answer' }])
    const provider = withStructuredLadder(fake)
    const req: ChatRequest<unknown> = {
      model: 'claude-sonnet-5',
      system: [],
      messages: [{ role: 'user', content: 'hi' }],
      maxOutputTokens: 128,
      meta: { orgId: 'org_1', role: 'draft', idempotencyKey: 'k' },
    }

    const result = await provider.chat(req)

    expect(fake.calls).toHaveLength(1)
    expect(fake.calls[0]).toBe(req)
    expect(result.text).toBe('plain answer')
    expect(result.parsed).toBeNull()
  })

  it('rung 1: a native model that parses on the first call makes exactly one call, keyed :native', async () => {
    const fake = createFakeProvider([{ parsed: { outcome: 'reply', confidence: 0.8 }, parseStrategy: 'native' }], {
      capabilities: { structuredOutput: 'native' },
    })
    const provider = withStructuredLadder(fake)

    const result = await provider.chat(baseRequest())

    expect(fake.calls).toHaveLength(1)
    expect(fake.calls[0]?.meta.idempotencyKey).toBe('k:native')
    expect(result.parsed).toEqual({ outcome: 'reply', confidence: 0.8 })
    expect(result.parseStrategy).toBe('native')
    expect(result.usage.apiCalls).toBe(1)
  })

  it('rung 2: native parses null, json_mode parses — two calls, parseStrategy json_mode, usage summed', async () => {
    const scripts: FakeScript<Decision>[] = [
      { usage: { inputTokens: 10, outputTokens: 5 } },
      { parsed: { outcome: 'reply', confidence: 0.7 }, usage: { inputTokens: 7, outputTokens: 3 } },
    ]
    const fake = createFakeProvider(scripts as FakeScript[], { capabilities: { structuredOutput: 'native' } })
    const provider = withStructuredLadder(fake)

    const result = await provider.chat(baseRequest())

    expect(fake.calls).toHaveLength(2)
    expect(fake.calls[0]?.meta.idempotencyKey).toBe('k:native')
    expect(fake.calls[1]?.meta.idempotencyKey).toBe('k:json_mode')
    expect(result.parsed).toEqual({ outcome: 'reply', confidence: 0.7 })
    expect(result.parseStrategy).toBe('json_mode')
    expect(result.usage.apiCalls).toBe(2)
    expect(result.usage.inputTokens).toBe(17)
    expect(result.usage.outputTokens).toBe(8)
  })

  it('rung 3: both structured rungs fail, the repair call returns valid JSON — key :repair, effort low, capped tokens, no output', async () => {
    const scripts: FakeScript[] = [
      { parsed: null },
      { parsed: null },
      { text: '{"outcome":"reply","confidence":0.9}' },
    ]
    const fake = createFakeProvider(scripts, { capabilities: { structuredOutput: 'native' } })
    const provider = withStructuredLadder(fake)

    const result = await provider.chat(baseRequest())

    expect(fake.calls).toHaveLength(3)
    const repairReq = fake.calls[2]!
    expect(repairReq.meta.idempotencyKey).toBe('k:repair')
    expect(repairReq.effort).toBe('low')
    expect(repairReq.maxOutputTokens).toBe(REPAIR_MAX_OUTPUT_TOKENS)
    expect(repairReq.output).toBeUndefined()
    expect(repairReq.messages).toEqual([{ role: 'user', content: '' }])
    expect(repairReq.system).toHaveLength(1)
    expect(repairReq.system[0]?.stability).toBe('volatile')
    expect(repairReq.system[0]?.text).toContain('JSON schema')

    expect(result.parsed).toEqual({ outcome: 'reply', confidence: 0.9 })
    expect(result.parseStrategy).toBe('repair')
    expect(result.usage.apiCalls).toBe(3)
  })

  it('rung 4: the repair text is not valid JSON on its own, but contains a balanced object that parses — extract', async () => {
    const scripts: FakeScript[] = [
      { parsed: null },
      { parsed: null },
      { text: 'Sure! {"a":1} and also {"outcome":"reply","confidence":0.9}' },
    ]
    const fake = createFakeProvider(scripts, { capabilities: { structuredOutput: 'native' } })
    const provider = withStructuredLadder(fake)

    const result = await provider.chat(baseRequest())

    expect(result.parsed).toEqual({ outcome: 'reply', confidence: 0.9 })
    expect(result.parseStrategy).toBe('extract')
  })

  it('nothing parses at any rung: parsed null, parseStrategy none, text is the last rung\'s', async () => {
    const scripts: FakeScript[] = [{ parsed: null }, { parsed: null }, { text: 'no json here at all' }]
    const fake = createFakeProvider(scripts, { capabilities: { structuredOutput: 'native' } })
    const provider = withStructuredLadder(fake)

    const result = await provider.chat(baseRequest())

    expect(result.parsed).toBeNull()
    expect(result.parseStrategy).toBe('none')
    expect(result.text).toBe('no json here at all')
    expect(fake.calls).toHaveLength(3)
  })

  it('a refusal on rung 1 returns immediately — one call, never re-asked', async () => {
    const fake = createFakeProvider([{ finish: 'refusal' }], { capabilities: { structuredOutput: 'native' } })
    const provider = withStructuredLadder(fake)

    const result = await provider.chat(baseRequest())

    expect(fake.calls).toHaveLength(1)
    expect(result.finish).toBe('refusal')
    expect(result.parsed).toBeNull()
  })

  it('a refusal on rung 2 returns immediately — the repair call is never made (ledger 79)', async () => {
    const scripts: FakeScript[] = [{ parsed: null }, { finish: 'refusal', text: 'I will not do that.' }]
    const fake = createFakeProvider(scripts, { capabilities: { structuredOutput: 'native' } })
    const provider = withStructuredLadder(fake)

    const result = await provider.chat(baseRequest())

    expect(fake.calls.map((c) => c.meta.idempotencyKey)).toEqual(['k:native', 'k:json_mode'])
    expect(result.finish).toBe('refusal')
    expect(result.parsed).toBeNull()
    expect(result.usage.apiCalls).toBe(2)
  })

  it('a refusal on rung 3 (repair) returns immediately — no rung-4 extraction from the refusal text (ledger 79)', async () => {
    const scripts: FakeScript[] = [
      { parsed: null },
      { parsed: null },
      // Valid, parseable JSON in the text — rung 4 WOULD have taken it had the refusal not short-circuited.
      { finish: 'refusal', text: 'I cannot: {"outcome":"reply","confidence":0.9}' },
    ]
    const fake = createFakeProvider(scripts, { capabilities: { structuredOutput: 'native' } })
    const provider = withStructuredLadder(fake)

    const result = await provider.chat(baseRequest())

    expect(fake.calls).toHaveLength(3)
    expect(result.finish).toBe('refusal')
    expect(result.parsed).toBeNull()
    expect(result.parseStrategy).toBe('none')
  })

  it('sums the per-TTL cache-write split across rungs, and leaves it absent when no rung reported one', async () => {
    const split: FakeScript[] = [
      { parsed: null, usage: { cacheWriteTokens: 400, cacheWrite5mTokens: 400, cacheWrite1hTokens: 0 } },
      { parsed: { outcome: 'reply', confidence: 0.7 }, usage: { cacheWriteTokens: 100, cacheWrite5mTokens: 0, cacheWrite1hTokens: 100 } },
    ]
    const withSplit = withStructuredLadder(createFakeProvider(split, { capabilities: { structuredOutput: 'native' } }))
    const summed = await withSplit.chat(baseRequest())
    expect(summed.usage.cacheWriteTokens).toBe(500)
    expect(summed.usage.cacheWrite5mTokens).toBe(400)
    expect(summed.usage.cacheWrite1hTokens).toBe(100)

    const noSplit: FakeScript[] = [
      { parsed: null, usage: { cacheWriteTokens: 400 } },
      { parsed: { outcome: 'reply', confidence: 0.7 }, usage: { cacheWriteTokens: 100 } },
    ]
    const withoutSplit = withStructuredLadder(createFakeProvider(noSplit, { capabilities: { structuredOutput: 'native' } }))
    const plain = await withoutSplit.chat(baseRequest())
    expect(plain.usage.cacheWriteTokens).toBe(500)
    expect(plain.usage.cacheWrite5mTokens).toBeUndefined()
    expect(plain.usage.cacheWrite1hTokens).toBeUndefined()
  })

  it('an LlmError from any rung propagates unchanged', async () => {
    const failure = new LlmError('boom', 'permanent', false)
    const fake = createFakeProvider([{ error: failure }], { capabilities: { structuredOutput: 'native' } })
    const provider = withStructuredLadder(fake)

    await expect(provider.chat(baseRequest())).rejects.toBe(failure)
  })

  it('a json_mode-only model skips rung 1 entirely', async () => {
    const fake = createFakeProvider([{ parsed: { outcome: 'reply', confidence: 0.5 }, parseStrategy: 'json_mode' }], {
      capabilities: { structuredOutput: 'json_mode' },
    })
    const provider = withStructuredLadder(fake)

    const result = await provider.chat(baseRequest())

    expect(fake.calls).toHaveLength(1)
    expect(fake.calls[0]?.meta.idempotencyKey).toBe('k:json_mode')
    expect(result.parseStrategy).toBe('json_mode')
  })

  it('forwards kind and capabilities to the inner provider', () => {
    const fake = createFakeProvider([{ text: 'ok' }], { kind: 'fake-inner', capabilities: { structuredOutput: 'json_mode' } })
    const provider = withStructuredLadder(fake)

    expect(provider.kind).toBe('fake-inner')
    expect(provider.capabilities('any-model')).toEqual(fake.capabilities('any-model'))
  })
})
