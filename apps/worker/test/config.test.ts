import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { Secret } from '@aesa/crypto'
import { loadConfig } from '../src/config.ts'

const DATABASE_URL = 'postgres://aesa:aesa@localhost:5434/aesa_dev'
const kekEnv = { AESA_KEK_V1: randomBytes(32).toString('base64'), AESA_KEK_ACTIVE: '1' }

describe('worker config', () => {
  it('reports no KEK for the blank .env.example shape instead of crashing at boot', () => {
    const config = loadConfig({ DATABASE_URL, AESA_KEK_V1: '', AESA_KEK_ACTIVE: '1' })
    expect(config.kekRing).toBeNull()
  })

  it('loads the ring once a KEK has a value', () => {
    const config = loadConfig({ DATABASE_URL, ...kekEnv })
    expect(config.kekRing?.active).toBe(1)
    expect(config.kekRing?.keys.get(1)?.length).toBe(32)
  })

  it('reports no ANTHROPIC_API_KEY when unset, so boot never crashes on it alone', () => {
    const config = loadConfig({ DATABASE_URL })
    expect(config.anthropicApiKey).toBeNull()
  })

  it('wraps a present ANTHROPIC_API_KEY in a Secret that never leaks the raw value', () => {
    const config = loadConfig({ DATABASE_URL, ANTHROPIC_API_KEY: 'sk-ant-test-key' })
    expect(config.anthropicApiKey).not.toBeNull()
    expect(config.anthropicApiKey?.expose()).toBe('sk-ant-test-key')
    expect(String(config.anthropicApiKey)).toBe('[redacted]')
  })

  describe('gmailOauth / msOauth: all-or-none pairs', () => {
    it('reports null when neither half of a pair is set', () => {
      const config = loadConfig({ DATABASE_URL })
      expect(config.gmailOauth).toBeNull()
      expect(config.msOauth).toBeNull()
    })

    it('throws when only GMAIL_OAUTH_CLIENT_ID is set', () => {
      expect(() => loadConfig({ DATABASE_URL, GMAIL_OAUTH_CLIENT_ID: 'id-only' }))
        .toThrow(/GMAIL_OAUTH_CLIENT_ID and GMAIL_OAUTH_CLIENT_SECRET must be set together/)
    })

    it('throws when only GMAIL_OAUTH_CLIENT_SECRET is set', () => {
      expect(() => loadConfig({ DATABASE_URL, GMAIL_OAUTH_CLIENT_SECRET: 'secret-only' }))
        .toThrow(/GMAIL_OAUTH_CLIENT_ID and GMAIL_OAUTH_CLIENT_SECRET must be set together/)
    })

    it('throws when only MS_OAUTH_CLIENT_ID is set', () => {
      expect(() => loadConfig({ DATABASE_URL, MS_OAUTH_CLIENT_ID: 'id-only' }))
        .toThrow(/MS_OAUTH_CLIENT_ID and MS_OAUTH_CLIENT_SECRET must be set together/)
    })

    it('populates a Secret-wrapped clientSecret once both halves of a pair are set', () => {
      const config = loadConfig({ DATABASE_URL, GMAIL_OAUTH_CLIENT_ID: 'gid', GMAIL_OAUTH_CLIENT_SECRET: 'gsecret' })
      expect(config.gmailOauth).toEqual({ clientId: 'gid', clientSecret: expect.anything() })
      expect(config.gmailOauth?.clientSecret.expose()).toBe('gsecret')
      expect(config.msOauth).toBeNull() // independently optional — a gmail-only deployment sets nothing for MS
    })
  })

  describe('production + WORKER_ROLES=sync guards', () => {
    it('throws when the KEK ring is missing', () => {
      expect(() => loadConfig({ DATABASE_URL, NODE_ENV: 'production', WORKER_ROLES: 'sync', MAIL_FROM: 'no-reply@example.com' }))
        .toThrow(/AESA_KEK_V<n> and AESA_KEK_ACTIVE are required in production when WORKER_ROLES includes `sync`/)
    })

    it('throws when MAIL_FROM is missing (KEK ring present)', () => {
      expect(() => loadConfig({ DATABASE_URL, NODE_ENV: 'production', WORKER_ROLES: 'sync', ...kekEnv }))
        .toThrow(/MAIL_FROM is required in production when WORKER_ROLES includes `sync`/)
    })

    it('boots cleanly in production when sync is active and both are configured', () => {
      const config = loadConfig({ DATABASE_URL, NODE_ENV: 'production', WORKER_ROLES: 'sync', MAIL_FROM: 'no-reply@example.com', ...kekEnv })
      expect(config.kekRing).not.toBeNull()
      expect(config.platformSender).toBe('no-reply@example.com')
    })

    it('does NOT throw in production when the sync role is not active, even with neither configured', () => {
      // `send` is the one role loadConfig gates on nothing at all — the `agent` role this case used
      // to name now has a KEK gate of its own (Phase 6), which would mask the thing being asserted.
      const config = loadConfig({ DATABASE_URL, NODE_ENV: 'production', WORKER_ROLES: 'send' })
      expect(config.kekRing).toBeNull()
      expect(config.platformSender).toBeNull()
    })

    it('does NOT throw in development/test even when the sync role is active and neither is configured', () => {
      const config = loadConfig({ DATABASE_URL, WORKER_ROLES: 'sync' })
      expect(config.kekRing).toBeNull()
      expect(config.platformSender).toBeNull()
    })
  })

  describe('production + WORKER_ROLES=agent KEK guard', () => {
    it('throws when the KEK ring is missing', () => {
      expect(() => loadConfig({ DATABASE_URL, NODE_ENV: 'production', WORKER_ROLES: 'agent', ANTHROPIC_API_KEY: 'sk-ant-x', VOYAGE_API_KEY: 'pa-x' }))
        .toThrow(/AESA_KEK_V<n> and AESA_KEK_ACTIVE are required in production when WORKER_ROLES includes `agent`/)
    })

    it('boots cleanly in production when agent is active and the ring is configured', () => {
      const config = loadConfig({ DATABASE_URL, NODE_ENV: 'production', WORKER_ROLES: 'agent', ANTHROPIC_API_KEY: 'sk-ant-x', VOYAGE_API_KEY: 'pa-x', ...kekEnv })
      expect(config.kekRing?.active).toBe(1)
    })

    it('does NOT throw in development/test when the agent role is active without a ring', () => {
      const config = loadConfig({ DATABASE_URL, WORKER_ROLES: 'agent' })
      expect(config.kekRing).toBeNull()
    })
  })

  describe('platformSender parsing', () => {
    it('reports null when MAIL_FROM is unset', () => {
      const config = loadConfig({ DATABASE_URL })
      expect(config.platformSender).toBeNull()
    })

    it('parses the bare addr-spec out of a display-name MAIL_FROM, lowercased', () => {
      const config = loadConfig({ DATABASE_URL, MAIL_FROM: 'aesa <No-Reply@Mail.Example.com>' })
      expect(config.platformSender).toBe('no-reply@mail.example.com')
    })
  })

  describe('mail / app URLs (Task 16)', () => {
    it('defaults to the devsink transport outside production', () => {
      expect(loadConfig({ DATABASE_URL }).mail).toEqual({ transport: 'devsink', from: 'aesa <onboarding@resend.dev>' })
    })

    it('throws in production when the cron role is active and RESEND_API_KEY is missing (the digest email needs it)', () => {
      expect(() => loadConfig({ DATABASE_URL, NODE_ENV: 'production', WORKER_ROLES: 'cron' }))
        .toThrow(/RESEND_API_KEY is required when EMAIL_TRANSPORT=resend/)
    })

    it('does NOT throw in production without the cron role — that replica never sends platform mail', () => {
      expect(loadConfig({ DATABASE_URL, NODE_ENV: 'production', WORKER_ROLES: 'agent', ANTHROPIC_API_KEY: 'sk-ant-x', VOYAGE_API_KEY: 'pa-x', ...kekEnv }).mail.transport).toBe('devsink')
    })

    it('builds the resend transport config in production when the cron role is fully configured', () => {
      const config = loadConfig({ DATABASE_URL, NODE_ENV: 'production', WORKER_ROLES: 'cron', RESEND_API_KEY: 're_k', MAIL_FROM: 'aesa <no-reply@x.test>' })
      expect(config.mail.transport).toBe('resend')
      expect(config.mail.transport === 'resend' && config.mail.apiKey.expose()).toBe('re_k')
      expect(JSON.stringify(config.mail)).not.toContain('re_k')
    })

    it('reports null app URLs when unset, and strips trailing slashes when set', () => {
      const bare = loadConfig({ DATABASE_URL })
      expect(bare.appBaseUrl).toBeNull()
      expect(bare.appWebOrigin).toBeNull()
      const set = loadConfig({ DATABASE_URL, APP_BASE_URL: 'https://api.example.com/', APP_WEB_ORIGIN: 'https://app.example.com//' })
      expect(set.appBaseUrl).toBe('https://api.example.com')
      expect(set.appWebOrigin).toBe('https://app.example.com')
    })

    it('rejects a non-http(s) APP_BASE_URL / APP_WEB_ORIGIN', () => {
      expect(() => loadConfig({ DATABASE_URL, APP_BASE_URL: 'nope' })).toThrow(/APP_BASE_URL must be an http\(s\) URL/)
      expect(() => loadConfig({ DATABASE_URL, APP_WEB_ORIGIN: 'aesa://app' })).toThrow(/APP_WEB_ORIGIN must be an http\(s\) URL/)
    })
  })
  describe('knowledge: Voyage, the embed model, rerank and S3 (Task 8)', () => {
    const s3Env = {
      S3_ENDPOINT: 'http://localhost:9000', S3_REGION: 'us-east-1', S3_BUCKET: 'aesa-dev',
      S3_ACCESS_KEY_ID: 'aesa', S3_SECRET_ACCESS_KEY: 'aesaaesa', S3_FORCE_PATH_STYLE: 'true',
    }

    it('loads with nulls in development when neither VOYAGE_API_KEY nor S3_* is set', () => {
      const config = loadConfig({ DATABASE_URL, WORKER_ROLES: 'knowledge,agent' })
      expect(config.voyageApiKey).toBeNull()
      expect(config.s3).toBeNull()
      expect(config.knowledgeEmbedModel).toBe('voyage-4')
      expect(config.knowledgeRerank).toBe(false)
    })

    it('wraps VOYAGE_API_KEY in a Secret that never leaks the raw value', () => {
      const config = loadConfig({ DATABASE_URL, VOYAGE_API_KEY: 'pa-voyage-key' })
      expect(config.voyageApiKey?.expose()).toBe('pa-voyage-key')
      expect(String(config.voyageApiKey)).toBe('[redacted]')
    })

    it('reads the embed model and the rerank flag', () => {
      expect(loadConfig({ DATABASE_URL, KNOWLEDGE_EMBED_MODEL: 'voyage-4-lite' }).knowledgeEmbedModel).toBe('voyage-4-lite')
      expect(loadConfig({ DATABASE_URL, KNOWLEDGE_RERANK: 'on' }).knowledgeRerank).toBe(true)
      expect(() => loadConfig({ DATABASE_URL, KNOWLEDGE_EMBED_MODEL: 'voyage-9' })).toThrow(/KNOWLEDGE_EMBED_MODEL/)
      expect(() => loadConfig({ DATABASE_URL, KNOWLEDGE_RERANK: 'yes' })).toThrow(/KNOWLEDGE_RERANK/)
    })

    it('parses the six S3_* into one config with the secret wrapped, and refuses a half-configured set', () => {
      const config = loadConfig({ DATABASE_URL, ...s3Env })
      expect(config.s3).toMatchObject({ endpoint: 'http://localhost:9000', region: 'us-east-1', bucket: 'aesa-dev', accessKeyId: 'aesa', forcePathStyle: true })
      // Same rule as every other credential here: the bucket's secret never survives a config dump.
      expect(config.s3?.secretAccessKey).toBeInstanceOf(Secret)
      expect(config.s3?.secretAccessKey.expose()).toBe('aesaaesa')
      expect(JSON.stringify(config.s3)).not.toContain('aesaaesa')
      expect(() => loadConfig({ DATABASE_URL, S3_BUCKET: 'aesa-dev' })).toThrow(/S3_\* variables are all-or-none/)
    })

    it('throws in production when the agent role is active and VOYAGE_API_KEY is missing', () => {
      expect(() => loadConfig({ DATABASE_URL, NODE_ENV: 'production', WORKER_ROLES: 'agent', ANTHROPIC_API_KEY: 'sk-ant-x', ...kekEnv }))
        .toThrow(/VOYAGE_API_KEY is required in production when WORKER_ROLES includes `agent` or `knowledge`/)
    })

    it('throws in production when the knowledge role is active and S3_* is missing (Voyage present)', () => {
      expect(() => loadConfig({ DATABASE_URL, NODE_ENV: 'production', WORKER_ROLES: 'knowledge', VOYAGE_API_KEY: 'pa-k' }))
        .toThrow(/S3_\* .* are required in production when WORKER_ROLES includes `knowledge`/)
    })

    it('boots in production once the knowledge role has both', () => {
      const config = loadConfig({ DATABASE_URL, NODE_ENV: 'production', WORKER_ROLES: 'knowledge', VOYAGE_API_KEY: 'pa-k', ...s3Env })
      expect(config.voyageApiKey?.expose()).toBe('pa-k')
      expect(config.s3?.bucket).toBe('aesa-dev')
    })

    it('does NOT throw in production for a role that needs neither (send)', () => {
      const config = loadConfig({ DATABASE_URL, NODE_ENV: 'production', WORKER_ROLES: 'send' })
      expect(config.voyageApiKey).toBeNull()
      expect(config.s3).toBeNull()
    })
  })
})
