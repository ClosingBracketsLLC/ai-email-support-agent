import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.ts'

const BASE = { DATABASE_URL: 'postgres://x', APP_BASE_URL: 'http://localhost:3001', APP_WEB_ORIGIN: 'http://localhost:8081', BETTER_AUTH_SECRET: 's'.repeat(32) }

describe('api config', () => {
  it('parses defaults: devsink mail outside production, aesa:// and exp:// trusted', () => {
    const c = loadConfig(BASE)
    expect(c).toMatchObject({ databaseUrl: 'postgres://x', port: 3001, host: '0.0.0.0', logLevel: 'info', env: 'development', authRateLimit: true, crossSiteCookies: false, google: null, microsoft: null })
    expect(c.mail).toEqual({ transport: 'devsink', from: 'aesa <onboarding@resend.dev>' })
    expect(c.trustedOrigins).toEqual(['http://localhost:8081', 'aesa://', 'exp://'])
  })
  it('refuses key material — the api never holds the KEK', () => {
    expect(() => loadConfig({ ...BASE, AESA_KEK_V1: 'abc' })).toThrow(/api must not/)
  })
  it('requires APP_BASE_URL, APP_WEB_ORIGIN and a 32+ character BETTER_AUTH_SECRET', () => {
    expect(() => loadConfig({ ...BASE, APP_BASE_URL: 'nope' })).toThrow(/APP_BASE_URL/)
    expect(() => loadConfig({ ...BASE, APP_WEB_ORIGIN: undefined })).toThrow(/APP_WEB_ORIGIN/)
    expect(() => loadConfig({ ...BASE, BETTER_AUTH_SECRET: 'short' })).toThrow(/BETTER_AUTH_SECRET/)
  })
  it('wraps every secret so it never prints', () => {
    const c = loadConfig({ ...BASE, GOOGLE_CLIENT_ID: 'gid', GOOGLE_CLIENT_SECRET: 'gsecret', RESEND_API_KEY: 're_key', EMAIL_TRANSPORT: 'resend', MAIL_FROM: 'aesa <no-reply@mail.example.com>' })
    const printed = JSON.stringify(c) + String(c.betterAuthSecret)
    expect(printed).not.toContain('gsecret'); expect(printed).not.toContain('re_key'); expect(printed).not.toContain('s'.repeat(32))
    expect(c.google?.clientSecret.expose()).toBe('gsecret')
    expect(c.mail.transport === 'resend' && c.mail.apiKey.expose()).toBe('re_key')
  })
  it('an OAuth client id and secret are all-or-none', () => {
    expect(() => loadConfig({ ...BASE, MICROSOFT_CLIENT_ID: 'x' })).toThrow(/MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET/)
  })
  it('production defaults to resend, needs its key and from address, and refuses devsink', () => {
    expect(() => loadConfig({ ...BASE, NODE_ENV: 'production' })).toThrow(/RESEND_API_KEY/)
    expect(() => loadConfig({ ...BASE, NODE_ENV: 'production', RESEND_API_KEY: 're_x' })).toThrow(/MAIL_FROM/)
    expect(() => loadConfig({ ...BASE, NODE_ENV: 'production', EMAIL_TRANSPORT: 'devsink' })).toThrow(/devsink/)
    const c = loadConfig({ ...BASE, NODE_ENV: 'production', RESEND_API_KEY: 're_x', MAIL_FROM: 'aesa <no-reply@mail.example.com>', AUTH_TRUSTED_ORIGINS: 'https://app.example.com, https://staging.example.com' })
    expect(c.mail.transport).toBe('resend')
    expect(c.trustedOrigins).toEqual(['http://localhost:8081', 'aesa://', 'https://app.example.com', 'https://staging.example.com'])
  })
})
