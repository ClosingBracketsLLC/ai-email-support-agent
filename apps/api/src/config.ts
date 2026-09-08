import { Secret } from '@aesa/crypto'
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
  /** Extra Better Auth trusted origins (comma-separated), e.g. a staging web origin. */
  AUTH_TRUSTED_ORIGINS: z.string().optional(),
  BETTER_AUTH_SECRET: z.string().min(32, 'BETTER_AUTH_SECRET must be at least 32 characters'),
  AUTH_RATE_LIMIT: z.enum(['on', 'off']).default('on'),
  /** Set when the web app and the api live on different registrable domains (cookies need SameSite=None; Secure). */
  AUTH_CROSS_SITE_COOKIES: z.enum(['true', 'false']).default('false'),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  MICROSOFT_CLIENT_ID: z.string().optional(),
  MICROSOFT_CLIENT_SECRET: z.string().optional(),
  /** resend in production; devsink (in-memory, read back through GET /__dev/mail/latest) for dev, tests and Playwright. */
  EMAIL_TRANSPORT: z.enum(['resend', 'devsink']).optional(),
  RESEND_API_KEY: z.string().optional(),
  MAIL_FROM: z.string().optional(),
})

export interface OAuthClient { clientId: string; clientSecret: Secret }
export type MailConfig = { transport: 'resend'; apiKey: Secret; from: string } | { transport: 'devsink'; from: string }

export interface ApiConfig {
  env: 'development' | 'test' | 'production'
  databaseUrl: string
  port: number
  host: string
  logLevel: string
  appBaseUrl: string
  appWebOrigin: string
  trustedOrigins: string[]
  betterAuthSecret: Secret
  authRateLimit: boolean
  crossSiteCookies: boolean
  google: OAuthClient | null
  microsoft: OAuthClient | null
  mail: MailConfig
}

function oauthPair(name: 'GOOGLE' | 'MICROSOFT', id: string | undefined, secret: string | undefined): OAuthClient | null {
  if (!id && !secret) return null
  if (!id || !secret) throw new Error(`${name}_CLIENT_ID and ${name}_CLIENT_SECRET must be set together`)
  return { clientId: id, clientSecret: new Secret(secret) }
}

export function loadConfig(env: NodeJS.ProcessEnv): ApiConfig {
  const kek = Object.keys(env).filter((k) => k.startsWith('AESA_KEK_'))
  if (kek.length) throw new Error(`api must not be configured with key material (${kek.join(', ')}); only the worker holds the KEK`)
  const parsed = EnvSchema.safeParse(env)
  if (!parsed.success) throw new Error(`Invalid environment: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
  const d = parsed.data
  const production = d.NODE_ENV === 'production'

  const transport = d.EMAIL_TRANSPORT ?? (production ? 'resend' : 'devsink')
  if (transport === 'devsink' && production) throw new Error('EMAIL_TRANSPORT=devsink is not allowed in production')
  let mail: MailConfig
  if (transport === 'resend') {
    if (!d.RESEND_API_KEY) throw new Error('RESEND_API_KEY is required when EMAIL_TRANSPORT=resend')
    if (!d.MAIL_FROM) throw new Error('MAIL_FROM is required when EMAIL_TRANSPORT=resend')
    mail = { transport, apiKey: new Secret(d.RESEND_API_KEY), from: d.MAIL_FROM }
  } else {
    mail = { transport, from: d.MAIL_FROM ?? 'aesa <onboarding@resend.dev>' }
  }

  // Normalize origins once: strip trailing slashes so they match browser Origin headers exactly.
  const appBaseUrl = d.APP_BASE_URL.replace(/\/+$/, '')
  const appWebOrigin = d.APP_WEB_ORIGIN.replace(/\/+$/, '')

  // aesa:// is the native deep-link scheme (OAuth callbacks land there); exp:// covers Expo Go in development.
  const extraOrigins = csv(d.AUTH_TRUSTED_ORIGINS).map((o) => o.startsWith('aesa://') || o.startsWith('exp://') ? o : o.replace(/\/+$/, ''))
  const trustedOrigins = [...new Set([appWebOrigin, 'aesa://', ...(production ? [] : ['exp://']), ...extraOrigins])]

  return {
    env: d.NODE_ENV, databaseUrl: d.DATABASE_URL, port: d.PORT, host: d.HOST, logLevel: d.LOG_LEVEL,
    appBaseUrl, appWebOrigin, trustedOrigins,
    betterAuthSecret: new Secret(d.BETTER_AUTH_SECRET), authRateLimit: d.AUTH_RATE_LIMIT === 'on', crossSiteCookies: d.AUTH_CROSS_SITE_COOKIES === 'true',
    google: oauthPair('GOOGLE', d.GOOGLE_CLIENT_ID, d.GOOGLE_CLIENT_SECRET),
    microsoft: oauthPair('MICROSOFT', d.MICROSOFT_CLIENT_ID, d.MICROSOFT_CLIENT_SECRET),
    mail,
  }
}
