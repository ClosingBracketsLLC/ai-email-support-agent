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

describe('knowledge settings', () => {
  it('knows the knowledge caps and their plan defaults', () => {
    expect(resolveSetting('knowledge.max_sources', {})).toBe(100)
    expect(resolveSetting('knowledge.max_crawl_pages', {})).toBe(200)
    expect(resolveSetting('knowledge.daily_embed_tokens_cap', {})).toBe(5_000_000)
    expect(planSettingDefaults('trial')).toMatchObject({ 'knowledge.max_sources': 10, 'knowledge.max_crawl_pages': 20, 'knowledge.daily_embed_tokens_cap': 200_000 })
    expect(planSettingDefaults('standard')).toMatchObject({ 'knowledge.max_sources': 100, 'knowledge.max_crawl_pages': 200, 'knowledge.daily_embed_tokens_cap': 5_000_000 })
  })
})
