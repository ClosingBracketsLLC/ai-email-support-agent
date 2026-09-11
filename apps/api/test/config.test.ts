import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.ts'

const BASE = { DATABASE_URL: 'postgres://x', APP_BASE_URL: 'http://localhost:3001', APP_WEB_ORIGIN: 'http://localhost:8081', BETTER_AUTH_SECRET: 's'.repeat(32) }
const S3_ENV = {
  S3_ENDPOINT: 'http://localhost:9000', S3_REGION: 'us-east-1', S3_BUCKET: 'aesa-dev',
  S3_ACCESS_KEY_ID: 'aesa', S3_SECRET_ACCESS_KEY: 'aesaaesa', S3_FORCE_PATH_STYLE: 'true',
}

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
    const c = loadConfig({
      ...BASE, ...S3_ENV, NODE_ENV: 'production', RESEND_API_KEY: 're_x', MAIL_FROM: 'aesa <no-reply@mail.example.com>',
      AUTH_TRUSTED_ORIGINS: 'https://app.example.com, https://staging.example.com', TRUST_PROXY: 'true',
    })
    expect(c.mail.transport).toBe('resend')
    expect(c.trustedOrigins).toEqual(['http://localhost:8081', 'aesa://', 'https://app.example.com', 'https://staging.example.com'])
    expect(c.webOrigins).toEqual(['http://localhost:8081', 'https://app.example.com', 'https://staging.example.com'])
  })
  describe('knowledge object storage (Task 9)', () => {
    it('is null in development when S3_* is unset', () => {
      expect(loadConfig(BASE).s3).toBeNull()
    })
    it('parses the six S3_* into one config, the secret still a raw string (index.ts wraps it right before createS3Store)', () => {
      const c = loadConfig({ ...BASE, ...S3_ENV })
      expect(c.s3).toEqual({ endpoint: 'http://localhost:9000', region: 'us-east-1', bucket: 'aesa-dev', accessKeyId: 'aesa', secretAccessKey: 'aesaaesa', forcePathStyle: true })
    })
    it('refuses a half-configured S3_* set', () => {
      expect(() => loadConfig({ ...BASE, S3_BUCKET: 'aesa-dev' })).toThrow(/S3_\* variables are all-or-none/)
    })
    it('is required in production; boots once every S3_* is set', () => {
      expect(() => loadConfig({ ...BASE, NODE_ENV: 'production', RESEND_API_KEY: 're_x', MAIL_FROM: 'a <a@example.com>', TRUST_PROXY: 'true' }))
        .toThrow(/S3_\*.*required in production/)
      const c = loadConfig({ ...BASE, ...S3_ENV, NODE_ENV: 'production', RESEND_API_KEY: 're_x', MAIL_FROM: 'a <a@example.com>', TRUST_PROXY: 'true' })
      expect(c.s3?.bucket).toBe('aesa-dev')
    })
  })
  it('strips trailing slashes from the origins before trusting them', () => {
    const c = loadConfig({ DATABASE_URL: 'postgres://x', APP_BASE_URL: 'http://localhost:3001/', APP_WEB_ORIGIN: 'http://localhost:8081/', BETTER_AUTH_SECRET: 's'.repeat(32), AUTH_TRUSTED_ORIGINS: 'https://app.example.com/' })
    expect(c.appBaseUrl).toBe('http://localhost:3001')
    expect(c.appWebOrigin).toBe('http://localhost:8081')
    expect(c.trustedOrigins).toEqual(['http://localhost:8081', 'aesa://', 'exp://', 'https://app.example.com'])
    expect(c.webOrigins).toEqual(['http://localhost:8081', 'https://app.example.com'])
  })
  it('web origins are appWebOrigin plus every http(s) extra trusted origin; native/deep-link schemes are excluded', () => {
    const c = loadConfig({ ...BASE, AUTH_TRUSTED_ORIGINS: 'https://staging.example.com, aesa://custom, exp://192.168.1.5:8081' })
    expect(c.webOrigins).toEqual(['http://localhost:8081', 'https://staging.example.com'])
  })
  it('production with rate limiting on requires TRUST_PROXY, or Better Auth buckets every client together', () => {
    expect(() => loadConfig({ ...BASE, NODE_ENV: 'production', RESEND_API_KEY: 're_x', MAIL_FROM: 'aesa <no-reply@mail.example.com>' })).toThrow(/TRUST_PROXY/)
  })
  it('parses TRUST_PROXY as a proxy IP/CIDR list or a boolean, defaulting to false', () => {
    expect(loadConfig(BASE).trustProxy).toBe(false)
    expect(loadConfig({ ...BASE, TRUST_PROXY: '10.0.0.0/8, 10.1.2.3' }).trustProxy).toEqual(['10.0.0.0/8', '10.1.2.3'])
    expect(loadConfig({ ...BASE, TRUST_PROXY: 'true' }).trustProxy).toBe(true)
  })
  it('defaults the global per-IP rate limit to 300/min; 0 disables it', () => {
    expect(loadConfig(BASE).rateLimit).toBe(300)
    expect(loadConfig({ ...BASE, API_RATE_LIMIT_PER_MINUTE: '0' }).rateLimit).toBe(0)
    expect(loadConfig({ ...BASE, API_RATE_LIMIT_PER_MINUTE: '5' }).rateLimit).toBe(5)
  })
  it('mailbox OAuth (gmail/microsoft) is unset by default, wrapped when present, and all-or-none', () => {
    expect(loadConfig(BASE).gmailOauth).toBeNull()
    expect(loadConfig(BASE).msOauth).toBeNull()
    expect(() => loadConfig({ ...BASE, GMAIL_OAUTH_CLIENT_ID: 'x' })).toThrow(/GMAIL_OAUTH_CLIENT_ID and GMAIL_OAUTH_CLIENT_SECRET/)
    expect(() => loadConfig({ ...BASE, MS_OAUTH_CLIENT_ID: 'x' })).toThrow(/MS_OAUTH_CLIENT_ID and MS_OAUTH_CLIENT_SECRET/)
    const c = loadConfig({ ...BASE, GMAIL_OAUTH_CLIENT_ID: 'gid', GMAIL_OAUTH_CLIENT_SECRET: 'gsecret', MS_OAUTH_CLIENT_ID: 'mid', MS_OAUTH_CLIENT_SECRET: 'msecret' })
    expect(c.gmailOauth).toMatchObject({ clientId: 'gid' })
    expect(c.gmailOauth?.clientSecret.expose()).toBe('gsecret')
    expect(c.msOauth?.clientSecret.expose()).toBe('msecret')
    expect(JSON.stringify(c)).not.toContain('gsecret')
    expect(JSON.stringify(c)).not.toContain('msecret')
  })
  it('parses the Gmail Pub/Sub webhook fields (Task 18), null when unset', () => {
    expect(loadConfig(BASE).gmailPubsubAudience).toBeNull()
    expect(loadConfig(BASE).gmailPubsubServiceAccount).toBeNull()
    const c = loadConfig({ ...BASE, GMAIL_PUBSUB_AUDIENCE: 'aud', GMAIL_PUBSUB_SA_EMAIL: 'sa@project.iam.gserviceaccount.com' })
    expect(c.gmailPubsubAudience).toBe('aud')
    expect(c.gmailPubsubServiceAccount).toBe('sa@project.iam.gserviceaccount.com')
  })
  it('GMAIL_PUBSUB_AUDIENCE and GMAIL_PUBSUB_SA_EMAIL are all-or-none — the webhook route 404s otherwise, so a half-configured deploy fails at boot instead', () => {
    expect(() => loadConfig({ ...BASE, GMAIL_PUBSUB_AUDIENCE: 'aud' })).toThrow(/GMAIL_PUBSUB_AUDIENCE and GMAIL_PUBSUB_SA_EMAIL/)
    expect(() => loadConfig({ ...BASE, GMAIL_PUBSUB_SA_EMAIL: 'sa@project.iam.gserviceaccount.com' })).toThrow(/GMAIL_PUBSUB_AUDIENCE and GMAIL_PUBSUB_SA_EMAIL/)
  })
  it('derives a stable 32-byte flowKey from BETTER_AUTH_SECRET, distinct from betterAuthSecret itself', () => {
    const c = loadConfig(BASE)
    expect(c.flowKey).toBeInstanceOf(Buffer)
    expect(c.flowKey.length).toBe(32)
    expect(c.flowKey.equals(loadConfig(BASE).flowKey)).toBe(true)
    const other = loadConfig({ ...BASE, BETTER_AUTH_SECRET: 't'.repeat(32) })
    expect(c.flowKey.equals(other.flowKey)).toBe(false)
  })
})
