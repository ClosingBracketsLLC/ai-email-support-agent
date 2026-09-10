/**
 * `parseMailConfig` — the four rules the api's `loadConfig` used to inline, now shared with the
 * worker's `loadConfig`. `requireInProduction` is what lets a production worker replica that never
 * sends platform mail (no `cron` role) boot without a Resend key at all.
 */
import { describe, expect, it } from 'vitest'
import { DEVSINK_DEFAULT_FROM, parseMailConfig } from '../src/config.ts'

const required = { production: false, requireInProduction: true }

describe('parseMailConfig', () => {
  it('defaults to devsink outside production, with the shared default from', () => {
    expect(parseMailConfig({}, required)).toEqual({ transport: 'devsink', from: DEVSINK_DEFAULT_FROM })
    expect(DEVSINK_DEFAULT_FROM).toBe('aesa <onboarding@resend.dev>')
  })

  it('keeps MAIL_FROM as the devsink from when one is configured', () => {
    expect(parseMailConfig({ MAIL_FROM: 'aesa <dev@x.test>' }, required)).toEqual({ transport: 'devsink', from: 'aesa <dev@x.test>' })
  })

  it('defaults to resend in production and refuses devsink there', () => {
    expect(() => parseMailConfig({}, { production: true, requireInProduction: true })).toThrow(/RESEND_API_KEY is required/)
    expect(() => parseMailConfig({ EMAIL_TRANSPORT: 'devsink' }, { production: true, requireInProduction: true }))
      .toThrow(/EMAIL_TRANSPORT=devsink is not allowed in production/)
  })

  it('requires both the key and the from address for resend, and wraps the key in a Secret', () => {
    expect(() => parseMailConfig({ EMAIL_TRANSPORT: 'resend' }, required)).toThrow(/RESEND_API_KEY is required when EMAIL_TRANSPORT=resend/)
    expect(() => parseMailConfig({ EMAIL_TRANSPORT: 'resend', RESEND_API_KEY: 're_k' }, required)).toThrow(/MAIL_FROM is required when EMAIL_TRANSPORT=resend/)
    const mail = parseMailConfig({ EMAIL_TRANSPORT: 'resend', RESEND_API_KEY: 're_k', MAIL_FROM: 'aesa <no-reply@x.test>' }, required)
    expect(mail.transport).toBe('resend')
    expect(mail.transport === 'resend' && mail.apiKey.expose()).toBe('re_k')
    expect(JSON.stringify(mail)).not.toContain('re_k')
  })

  it('requireInProduction:false lets a production replica that never sends mail boot on devsink', () => {
    expect(parseMailConfig({}, { production: true, requireInProduction: false })).toEqual({ transport: 'devsink', from: DEVSINK_DEFAULT_FROM })
  })

  it('rejects an unknown EMAIL_TRANSPORT value', () => {
    expect(() => parseMailConfig({ EMAIL_TRANSPORT: 'smtp' }, required)).toThrow(/EMAIL_TRANSPORT must be 'resend' or 'devsink'/)
  })
})
