import { hkdfSync } from 'node:crypto'
import { Secret } from '@aesa/crypto'
import { parseS3Env, type S3Config } from '@aesa/knowledge'
import { parseMailConfig, type MailConfig } from '@aesa/platform-mail'
import { z } from 'zod'

const isHttpUrl = (v: string) => { try { return ['http:', 'https:'].includes(new URL(v).protocol) } catch { return false } }
const csv = (v: string | undefined) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean)
const httpUrl = (name: string) => z.string({ error: `${name} is required` }).refine(isHttpUrl, { message: `${name} must be an http(s) URL` })

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  PORT: z.coerce.number().int().positive().default(3001),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  /** Public origin of THIS api: Better Auth's baseURL and the base of every OAuth redirect URI. */
  APP_BASE_URL: httpUrl('APP_BASE_URL'),
  /** Origin the Expo web app is served from: CORS allow-list, Better Auth trusted origin, invitation links. */
  APP_WEB_ORIGIN: httpUrl('APP_WEB_ORIGIN'),
  /**
   * Extra Better Auth trusted origins (comma-separated), e.g. a staging web origin. Every http(s) entry
   * also becomes a real web origin (config.webOrigins): CORS and the /trpc CSRF guard accept it, not
   * only Better Auth's own routes (Phase 1 review, Important 6). Native/deep-link schemes (aesa://,
   * exp://) are trusted by Better Auth but excluded from webOrigins — they never send a browser Origin.
   */
  AUTH_TRUSTED_ORIGINS: z.string().optional(),
  BETTER_AUTH_SECRET: z.string().min(32, 'BETTER_AUTH_SECRET must be at least 32 characters'),
  AUTH_RATE_LIMIT: z.enum(['on', 'off']).default('on'),
  /** Global request cap for the whole api (keyed by IP), independent of Better Auth's own /api/auth/* limiter. 0 disables it. */
  API_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().nonnegative().default(300),
  /** Set when the web app and the api live on different registrable domains (cookies need SameSite=None; Secure). */
  AUTH_CROSS_SITE_COOKIES: z.enum(['true', 'false']).default('false'),
  /**
   * 'false' (default): no reverse proxy is trusted. 'true': trust a single hop's x-forwarded-for as-is.
   * A comma-separated list of IPs/CIDRs: trust exactly those proxies and walk a multi-hop chain past them.
   * Feeds both Fastify's own `trustProxy` and Better Auth's `advanced.ipAddress.trustedProxies` (see auth.ts) —
   * without it, behind any proxy, every client collapses into Better Auth's rate limiter's single fallback bucket.
   */
  TRUST_PROXY: z.string().default('false'),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  MICROSOFT_CLIENT_ID: z.string().optional(),
  MICROSOFT_CLIENT_SECRET: z.string().optional(),
  /** resend in production; devsink (in-memory, read back through GET /__dev/mail/latest) for dev, tests and Playwright. */
  EMAIL_TRANSPORT: z.enum(['resend', 'devsink']).optional(),
  RESEND_API_KEY: z.string().optional(),
  MAIL_FROM: z.string().optional(),
  /** Mailbox OAuth (Gmail/Graph mail access) — distinct from GOOGLE_/MICROSOFT_CLIENT_ID above, which are
   * Better Auth's SSO login providers. */
  GMAIL_OAUTH_CLIENT_ID: z.string().optional(),
  GMAIL_OAUTH_CLIENT_SECRET: z.string().optional(),
  MS_OAUTH_CLIENT_ID: z.string().optional(),
  MS_OAUTH_CLIENT_SECRET: z.string().optional(),
  /** Task 18 (Gmail Pub/Sub push webhook verification); parsed now, optional until that task lands. */
  GMAIL_PUBSUB_AUDIENCE: z.string().optional(),
  GMAIL_PUBSUB_SA_EMAIL: z.string().optional(),
  /** Object storage for knowledge uploads — minio locally (`pnpm db:up` starts it, `pnpm s3:init`
   * creates the bucket), S3/R2 in production. All six or none (`parseS3Env`): a half-configured
   * set throws at boot. REQUIRED IN PRODUCTION — the presigned PUT `knowledge.startUpload` issues
   * has nowhere else to point. The worker reads the SAME six names for its own upload reads; point
   * both apps at one bucket. */
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().optional(),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: z.string().optional(),
})

export interface OAuthClient { clientId: string; clientSecret: Secret }
/** Re-exported so `ApiConfig.mail`'s type keeps its old import path; the definition lives in @aesa/platform-mail. */
export type { MailConfig }

export interface ApiConfig {
  env: 'development' | 'test' | 'production'
  databaseUrl: string
  port: number
  host: string
  logLevel: string
  appBaseUrl: string
  appWebOrigin: string
  /** appWebOrigin plus every http(s) AUTH_TRUSTED_ORIGINS entry: what CORS and the /trpc CSRF guard accept. */
  webOrigins: string[]
  trustedOrigins: string[]
  betterAuthSecret: Secret
  authRateLimit: boolean
  /** Requests per minute per IP, global across the whole api. 0 disables the global limiter. */
  rateLimit: number
  crossSiteCookies: boolean
  /** false: no proxy trusted. true: trust one hop's x-forwarded-for as-is. string[]: trust exactly these proxies. */
  trustProxy: boolean | string[]
  google: OAuthClient | null
  microsoft: OAuthClient | null
  mail: MailConfig
  /** Gmail mailbox OAuth (GMAIL_OAUTH_CLIENT_ID/_SECRET) — the connect flow, not Better Auth's SSO login. */
  gmailOauth: OAuthClient | null
  /** Microsoft Graph mailbox OAuth (MS_OAUTH_CLIENT_ID/_SECRET). */
  msOauth: OAuthClient | null
  /** Task 18's Gmail Pub/Sub push webhook: the expected OIDC token audience. */
  gmailPubsubAudience: string | null
  /** Task 18's Gmail Pub/Sub push webhook: the expected OIDC token service-account email. */
  gmailPubsubServiceAccount: string | null
  /** HKDF-SHA256(BETTER_AUTH_SECRET, salt 'aesa', info 'oauth-flow-key', 32 bytes) — AES-GCM key for the
   * connect flow's PKCE verifier ciphertext (packages/crypto's encrypt/decrypt). Never derived from a
   * secret this api doesn't already hold, and never persisted anywhere itself. */
  flowKey: Buffer
  /** The six `S3_*` as one config (raw secret — `index.ts` wraps it in a `Secret` right before
   * `createS3Store`, the same point every other credential in this app gets wrapped), or null when
   * object storage is not configured at all. */
  s3: S3Config | null
}

function oauthPair(name: string, id: string | undefined, secret: string | undefined): OAuthClient | null {
  if (!id && !secret) return null
  if (!id || !secret) throw new Error(`${name}_CLIENT_ID and ${name}_CLIENT_SECRET must be set together`)
  return { clientId: id, clientSecret: new Secret(secret) }
}

/** Task 18: the Gmail Pub/Sub webhook is "armed" (routes.ts 404s otherwise) exactly when both are set —
 * one without the other is a half-configured deploy, same all-or-none shape as oauthPair() above. */
function gmailPubsubPair(audience: string | undefined, serviceAccount: string | undefined): { audience: string; serviceAccount: string } | null {
  if (!audience && !serviceAccount) return null
  if (!audience || !serviceAccount) throw new Error('GMAIL_PUBSUB_AUDIENCE and GMAIL_PUBSUB_SA_EMAIL must be set together')
  return { audience, serviceAccount }
}

function deriveFlowKey(betterAuthSecret: string): Buffer {
  return Buffer.from(hkdfSync('sha256', betterAuthSecret, 'aesa', 'oauth-flow-key', 32))
}

export function loadConfig(env: NodeJS.ProcessEnv): ApiConfig {
  const kek = Object.keys(env).filter((k) => k.startsWith('AESA_KEK_'))
  if (kek.length) throw new Error(`api must not be configured with key material (${kek.join(', ')}); only the worker holds the KEK`)
  const parsed = EnvSchema.safeParse(env)
  if (!parsed.success) throw new Error(`Invalid environment: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
  const d = parsed.data
  const production = d.NODE_ENV === 'production'

  // The api ALWAYS sends platform mail (sign-in codes, invitations, verification codes), so it is
  // always `requireInProduction` — the same four rules this function used to inline.
  const mail = parseMailConfig({ EMAIL_TRANSPORT: d.EMAIL_TRANSPORT, RESEND_API_KEY: d.RESEND_API_KEY, MAIL_FROM: d.MAIL_FROM }, { production, requireInProduction: true })

  // Normalize origins once: strip trailing slashes so they match browser Origin headers exactly.
  const appBaseUrl = d.APP_BASE_URL.replace(/\/+$/, '')
  const appWebOrigin = d.APP_WEB_ORIGIN.replace(/\/+$/, '')

  // aesa:// is the native deep-link scheme (OAuth callbacks land there); exp:// covers Expo Go in development.
  const extraOrigins = csv(d.AUTH_TRUSTED_ORIGINS).map((o) => o.startsWith('aesa://') || o.startsWith('exp://') ? o : o.replace(/\/+$/, ''))
  const trustedOrigins = [...new Set([appWebOrigin, 'aesa://', ...(production ? [] : ['exp://']), ...extraOrigins])]
  // Only the http(s) extras are real web origins — a documented staging web origin must work with CORS and the
  // /trpc guard, not only with Better Auth's own routes (Phase 1 review, Important 6).
  const webOrigins = [...new Set([appWebOrigin, ...extraOrigins.filter((o) => o.startsWith('http://') || o.startsWith('https://'))])]

  const trustProxyRaw = d.TRUST_PROXY.trim()
  const trustProxy: boolean | string[] = trustProxyRaw === '' || trustProxyRaw === 'false' ? false : trustProxyRaw === 'true' ? true : csv(trustProxyRaw)
  const authRateLimit = d.AUTH_RATE_LIMIT === 'on'
  if (production && authRateLimit && trustProxy === false) {
    throw new Error('AUTH_RATE_LIMIT=on requires TRUST_PROXY in production: Better Auth keys its limiter on x-forwarded-for and otherwise puts every client in one bucket')
  }

  const gmailPubsub = gmailPubsubPair(d.GMAIL_PUBSUB_AUDIENCE, d.GMAIL_PUBSUB_SA_EMAIL)

  // All-or-none, and it throws on a half-configured deploy — read from the ALREADY-PARSED values so
  // the six names are documented in EnvSchema above rather than only inside `parseS3Env`.
  const s3 = parseS3Env({
    S3_ENDPOINT: d.S3_ENDPOINT, S3_REGION: d.S3_REGION, S3_BUCKET: d.S3_BUCKET,
    S3_ACCESS_KEY_ID: d.S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY: d.S3_SECRET_ACCESS_KEY, S3_FORCE_PATH_STYLE: d.S3_FORCE_PATH_STYLE,
  })
  // Unconditional (unlike the worker's role-gated check): the api always serves the presigned-upload
  // flow, so a production api with no bucket to point browsers at would look healthy while every
  // upload silently failed.
  if (production && !s3) {
    throw new Error('S3_* (endpoint, region, bucket, access key id, secret access key, force path style) are required in production (the presigned upload flow has nowhere to point)')
  }

  return {
    env: d.NODE_ENV, databaseUrl: d.DATABASE_URL, port: d.PORT, host: d.HOST, logLevel: d.LOG_LEVEL,
    appBaseUrl, appWebOrigin, webOrigins, trustedOrigins, trustProxy,
    betterAuthSecret: new Secret(d.BETTER_AUTH_SECRET), authRateLimit, rateLimit: d.API_RATE_LIMIT_PER_MINUTE, crossSiteCookies: d.AUTH_CROSS_SITE_COOKIES === 'true',
    google: oauthPair('GOOGLE', d.GOOGLE_CLIENT_ID, d.GOOGLE_CLIENT_SECRET),
    microsoft: oauthPair('MICROSOFT', d.MICROSOFT_CLIENT_ID, d.MICROSOFT_CLIENT_SECRET),
    mail,
    gmailOauth: oauthPair('GMAIL_OAUTH', d.GMAIL_OAUTH_CLIENT_ID, d.GMAIL_OAUTH_CLIENT_SECRET),
    msOauth: oauthPair('MS_OAUTH', d.MS_OAUTH_CLIENT_ID, d.MS_OAUTH_CLIENT_SECRET),
    gmailPubsubAudience: gmailPubsub?.audience ?? null,
    gmailPubsubServiceAccount: gmailPubsub?.serviceAccount ?? null,
    flowKey: deriveFlowKey(d.BETTER_AUTH_SECRET),
    s3,
  }
}
