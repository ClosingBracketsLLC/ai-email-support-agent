import { describe, expect, it } from 'vitest'
import { createFakeProvider } from '@aesa/llm'
import { LlmError } from '@aesa/llm'
import { buildTriagePrompt, runTriageCall, TRIAGE_MAX_BODY_CHARS, TRIAGE_MODEL, type TriageInput } from '../src/triage.ts'

const META = { orgId: '11111111-1111-1111-1111-111111111111', role: 'triage' as const, idempotencyKey: 'test-key' }

const BASE_INPUT: TriageInput = {
  subject: 'Where is my order?',
  bodies: ['It has been a week.', 'Any update?'],
  categoryKeys: ['order_status', 'shipping_delivery', 'other'],
  businessName: 'Acme Dog Supplies',
}

describe('buildTriagePrompt', () => {
  it('enumerates every category key in the system prompt', () => {
    const { system } = buildTriagePrompt(BASE_INPUT)
    const text = system.map((b) => b.text).join('\n')
    for (const key of BASE_INPUT.categoryKeys) {
      expect(text).toContain(key)
    }
  })

  it('carries the untrusted-data instruction, verbatim in spirit', () => {
    const { system } = buildTriagePrompt(BASE_INPUT)
    const text = system.map((b) => b.text).join('\n')
    expect(text).toMatch(/UNTRUSTED DATA/)
    expect(text).toMatch(/not instructions/i)
    expect(text).toMatch(/classify only/i)
  })

  it('marks the system block static (stable across calls, cacheable)', () => {
    const { system } = buildTriagePrompt(BASE_INPUT)
    expect(system).toHaveLength(1)
    expect(system[0]!.stability).toBe('static')
  })

  it('puts the subject and every numbered body into the user block, wrapped in <email>', () => {
    const { user } = buildTriagePrompt(BASE_INPUT)
    expect(user).toMatch(/^<email>/)
    expect(user).toMatch(/<\/email>$/)
    expect(user).toContain('Subject: Where is my order?')
    expect(user).toContain('Message 1:\nIt has been a week.')
    expect(user).toContain('Message 2:\nAny update?')
  })

  it('renders a null subject as a placeholder rather than "null"', () => {
    const { user } = buildTriagePrompt({ ...BASE_INPUT, subject: null })
    expect(user).not.toContain('Subject: null')
    expect(user).toMatch(/Subject: \(none\)/)
  })
})

describe('runTriageCall', () => {
  it('returns the parsed verdict on a clean call', async () => {
    const verdict = {
      categoryKey: 'order_status',
      language: 'en',
      sentiment: 'neutral' as const,
      isSpam: false,
      isAutomated: false,
      escalationFlags: [],
      questions: [],
    }
    const provider = createFakeProvider([{ parsed: verdict }])

    const result = await runTriageCall(provider, BASE_INPUT, META, new AbortController().signal)

    expect(result).toEqual(verdict)
    expect(provider.calls).toHaveLength(1)
    expect(provider.calls[0]!.model).toBe(TRIAGE_MODEL)
    expect(provider.calls[0]!.maxOutputTokens).toBe(1024)
    expect(provider.calls[0]!.output?.name).toBe('triage')
    expect(provider.calls[0]!.meta).toEqual(META)
  })

  it('throws when the provider returns an unparsable verdict (parsed: null)', async () => {
    const provider = createFakeProvider([{ text: 'not json' }])

    await expect(runTriageCall(provider, BASE_INPUT, META, new AbortController().signal)).rejects.toThrow(/unparsable verdict/)
  })

  it('throws when the job signal is already aborted (the merged-signal wiring propagates it)', async () => {
    const provider = createFakeProvider([{ parsed: { categoryKey: 'other', language: 'en', sentiment: 'neutral', isSpam: false, isAutomated: false, escalationFlags: [], questions: [] } }])
    const controller = new AbortController()
    controller.abort()

    await expect(runTriageCall(provider, BASE_INPUT, META, controller.signal)).rejects.toThrow(LlmError)
  })

  it('slices bodies to TRIAGE_MAX_BODY_CHARS worth of content when building the prompt', () => {
    const longBody = 'x'.repeat(TRIAGE_MAX_BODY_CHARS + 500)
    const { user } = buildTriagePrompt({ ...BASE_INPUT, bodies: [longBody] })
    // buildTriagePrompt itself doesn't truncate (the job layer slices before calling); it just
    // renders whatever it's given — this proves the prompt doesn't itself impose a smaller cap.
    expect(user).toContain(longBody)
  })
})
