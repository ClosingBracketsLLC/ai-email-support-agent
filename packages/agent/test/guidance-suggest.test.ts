import { describe, expect, it } from 'vitest'
import { createFakeProvider } from '@aesa/llm'
import { buildGuidanceSuggestPrompt, runGuidanceSuggestCall, GUIDANCE_SUGGEST_MODEL, type GuidanceSuggestInput } from '../src/guidance/suggest.ts'

const META = { orgId: '11111111-1111-1111-1111-111111111111', role: 'guidance_suggest' as const, idempotencyKey: 'test-key' }

const INPUT: GuidanceSuggestInput = {
  original: 'Returns take 5 days.',
  edited: 'Returns take 10 business days.',
  categoryLabel: 'Returns & refunds',
  workspaceGuidance: 'Never promise delivery dates.',
  agentGuidance: '',
  businessName: 'Acme',
}

describe('buildGuidanceSuggestPrompt', () => {
  it('renders the original and the edited reply as untrusted data blocks, the existing guidance as trusted, and asks for ONE rule or null', () => {
    const { system, user } = buildGuidanceSuggestPrompt({ original: 'Returns take 5 days.', edited: 'Returns take 10 business days.', categoryLabel: 'Returns & refunds', workspaceGuidance: 'Never promise delivery dates.', agentGuidance: '', businessName: 'Acme' })
    expect(system[0]!.stability).toBe('static')
    expect(system[0]!.text).toMatch(/exactly one rule|null/i)
    expect(user).toContain('<original>\nReturns take 5 days.\n</original>')
    expect(user).toContain('<edited>\nReturns take 10 business days.\n</edited>')
    expect(user).toContain('Never promise delivery dates.')
  })
})

describe('runGuidanceSuggestCall', () => {
  it('runGuidanceSuggestCall returns the parsed suggestion, with role guidance_suggest and the Haiku model', async () => {
    const provider = createFakeProvider([{ parsed: { suggestion: 'Returns take 10 business days, not 5.', rationale: 'The owner corrected the timeframe.' } }])
    const out = await runGuidanceSuggestCall(provider, INPUT, META, new AbortController().signal)
    expect(out).toEqual({ suggestion: 'Returns take 10 business days, not 5.', rationale: 'The owner corrected the timeframe.' })
    expect(provider.calls[0]).toMatchObject({ model: GUIDANCE_SUGGEST_MODEL, meta: { role: 'guidance_suggest' }, maxOutputTokens: 512 })
  })

  it('an unparsable result is a null suggestion, never a throw (the job records nothing)', async () => {
    const provider = createFakeProvider([{ text: 'nope', parseStrategy: 'none' }])
    await expect(runGuidanceSuggestCall(provider, INPUT, META, new AbortController().signal)).resolves.toEqual({ suggestion: null, rationale: '' })
  })
})
