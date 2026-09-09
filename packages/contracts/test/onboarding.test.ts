import { describe, expect, it } from 'vitest'
import { ONBOARDING_STEPS, isOnboardingStep, nextOnboardingStep } from '../src/index.ts'

describe('onboarding steps', () => {
  it('walks profile → mailbox → knowledge → go_live → done and stays at done', () => {
    expect(ONBOARDING_STEPS).toEqual(['profile', 'mailbox', 'knowledge', 'go_live', 'done'])
    expect(nextOnboardingStep('profile')).toBe('mailbox')
    expect(nextOnboardingStep('mailbox')).toBe('knowledge')
    expect(nextOnboardingStep('knowledge')).toBe('go_live')
    expect(nextOnboardingStep('go_live')).toBe('done')
    expect(nextOnboardingStep('done')).toBe('done')
  })
  it('narrows arbitrary strings', () => {
    expect(isOnboardingStep('mailbox')).toBe(true)
    expect(isOnboardingStep('billing')).toBe(false)
  })
})
