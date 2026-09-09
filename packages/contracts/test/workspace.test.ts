import { describe, expect, it } from 'vitest'
import { CreateWorkspaceInput, TONES, UpdateProfileInput, deriveAllowedHosts, slugify } from '../src/index.ts'

describe('workspace contracts', () => {
  it('CreateWorkspaceInput trims and bounds the business name', () => {
    expect(CreateWorkspaceInput.parse({ businessName: '  Acme ', timezone: 'Europe/Berlin' })).toEqual({ businessName: 'Acme', timezone: 'Europe/Berlin' })
    expect(CreateWorkspaceInput.safeParse({ businessName: '   ', timezone: 'UTC' }).success).toBe(false)
    expect(CreateWorkspaceInput.safeParse({ businessName: 'x'.repeat(121), timezone: 'UTC' }).success).toBe(false)
  })
  it('UpdateProfileInput accepts only http(s) URLs and known tones', () => {
    expect(TONES).toEqual(['friendly', 'formal', 'concise'])
    const ok = UpdateProfileInput.parse({ websiteUrl: 'https://acme.com', description: 'We sell socks', tone: 'formal', contactPhone: null, contactUrls: ['https://acme.com/contact'] })
    expect(ok.tone).toBe('formal')
    expect(UpdateProfileInput.safeParse({ websiteUrl: 'ftp://acme.com', description: '', tone: 'friendly', contactPhone: null, contactUrls: [] }).success).toBe(false)
    expect(UpdateProfileInput.safeParse({ websiteUrl: null, description: '', tone: 'shouty', contactPhone: null, contactUrls: [] }).success).toBe(false)
  })
  it('derives the guardrail host list: lowercased, www stripped, deduplicated, in first-seen order', () => {
    expect(deriveAllowedHosts('https://WWW.Acme.com/about', ['https://acme.com/contact', 'https://help.acme.com', 'https://help.acme.com/x'])).toEqual(['acme.com', 'help.acme.com'])
    expect(deriveAllowedHosts(null, [])).toEqual([])
  })
  it('slugify produces a url-safe base that never starts or ends with a dash', () => {
    expect(slugify('Acme & Sons, Ltd.')).toBe('acme-sons-ltd')
    expect(slugify('Ünïcödé Café')).toBe('unicode-cafe')
    expect(slugify('   ')).toBe('workspace')
    expect(slugify('a'.repeat(80))).toHaveLength(40)
  })
})
