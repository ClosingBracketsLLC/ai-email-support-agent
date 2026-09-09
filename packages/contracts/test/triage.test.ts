import { describe, expect, it } from 'vitest'
import { TriageVerdict } from '../src/index.ts'

describe('TriageVerdict', () => {
  it('accepts a full verdict and rejects unknown flags', () => {
    expect(TriageVerdict.safeParse({
      categoryKey: 'returns_refunds', language: 'en', sentiment: 'negative',
      isSpam: false, isAutomated: false, escalationFlags: ['injury'], questions: ['can I return worn shoes?'],
    }).success).toBe(true)
    expect(TriageVerdict.safeParse({
      categoryKey: 'other', language: 'en', sentiment: 'neutral',
      isSpam: false, isAutomated: false, escalationFlags: ['spooky'], questions: [],
    }).success).toBe(false)
  })
})
