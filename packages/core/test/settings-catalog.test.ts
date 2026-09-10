import { describe, expect, it } from 'vitest'
import { resolveSetting } from '../src/settings-catalog.ts'
import { planSettingDefaults } from '../src/plans.ts'

describe('settings resolution: org override > plan default > code default', () => {
  it('falls back through the three levels', () => {
    expect(resolveSetting('autonomy.daily_draft_cap', {})).toBe(2000)
    expect(resolveSetting('autonomy.daily_draft_cap', { plan: planSettingDefaults('trial') })).toBe(50)
    expect(resolveSetting('autonomy.daily_draft_cap', { plan: planSettingDefaults('trial'), org: { 'autonomy.daily_draft_cap': 75 } })).toBe(75)
  })
  it('rejects a wrongly-typed override instead of returning it', () => {
    expect(() => resolveSetting('autonomy.daily_draft_cap', { org: { 'autonomy.daily_draft_cap': 'lots' } })).toThrow(/expected number/)
    expect(() => resolveSetting('support.spam_shortcircuit.always', { org: { 'support.spam_shortcircuit.always': 1 } })).toThrow(/expected boolean/)
  })
})

describe('digest email settings', () => {
  it('resolve their code defaults', () => {
    expect(resolveSetting('notifications.digest_email', {})).toBe(true)
    expect(resolveSetting('notifications.digest_email_hour', {})).toBe(8)
  })
  it('reject a wrongly-typed override', () => {
    expect(() => resolveSetting('notifications.digest_email', { org: { 'notifications.digest_email': 'yes' } })).toThrow(/expected boolean/)
    expect(() => resolveSetting('notifications.digest_email_hour', { org: { 'notifications.digest_email_hour': '8' } })).toThrow(/expected number/)
  })
})
