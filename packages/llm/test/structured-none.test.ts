import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createFakeProvider, withStructuredLadder, type ChatRequest } from '../src/index.ts'

const Schema = z.object({ answer: z.enum(['yes', 'no']), n: z.number().int() })
const req = (): ChatRequest<z.infer<typeof Schema>> => ({
  model: 'plain-model',
  system: [{ id: 's', text: 'Be brief.', stability: 'static' }],
  messages: [{ role: 'user', content: 'Is water wet?' }],
  output: { name: 'probe', schema: Schema },
  maxOutputTokens: 64,
  meta: { orgId: 'org', role: 'probe', idempotencyKey: 'k' },
})

describe('withStructuredLadder on a model with structuredOutput none', () => {
  it('makes ONE plain call carrying the JSON instruction and parses the reply: parseStrategy plain', async () => {
    const fake = createFakeProvider([{ text: '{"answer":"yes","n":7}' }], { capabilities: { structuredOutput: 'none', tools: false } })
    const res = await withStructuredLadder(fake).chat(req())
    expect(res.parsed).toEqual({ answer: 'yes', n: 7 })
    expect(res.parseStrategy).toBe('plain')
    expect(fake.calls).toHaveLength(1)
    expect(fake.calls[0]!.output).toBeUndefined() // a PLAIN call — no adapter rung asked for
    expect(fake.calls[0]!.system.at(-1)!.text).toMatch(/ONE JSON object/) // the instruction rides as the last (volatile) system block
    expect(fake.calls[0]!.meta.idempotencyKey).toBe('k:plain')
  })

  it('prose around the JSON falls through to repair, then extract', async () => {
    const fake = createFakeProvider(
      [{ text: 'Sure! Here you go: {"answer":"no","n":3} Hope that helps.' }, { text: 'still prose {"answer":"no","n":3}' }],
      { capabilities: { structuredOutput: 'none', tools: false } },
    )
    const res = await withStructuredLadder(fake).chat(req())
    expect(res.parsed).toEqual({ answer: 'no', n: 3 })
    expect(res.parseStrategy).toBe('extract')
    expect(fake.calls.map((c) => c.meta.idempotencyKey)).toEqual(['k:plain', 'k:repair'])
  })

  it('a refusal on the plain call returns immediately', async () => {
    const fake = createFakeProvider([{ text: '', finish: 'refusal' }], { capabilities: { structuredOutput: 'none', tools: false } })
    const res = await withStructuredLadder(fake).chat(req())
    expect(res.finish).toBe('refusal')
    expect(res.parsed).toBeNull()
    expect(fake.calls).toHaveLength(1)
  })
})
