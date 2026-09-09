import { loadKekRing, Secret, type KekRing } from '@aesa/crypto'
import { parseFirstAddrSpec } from '@aesa/mail'
import { z } from 'zod'
import { parseWorkerRoles, type WorkerRole } from './roles.ts'

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().min(1),
  WORKER_ROLES: z.string().optional(),
  LOG_LEVEL: z.string().default('info'),
  // Optional here: registration (apps/worker/src/index.ts) is what enforces it's required in
  // production when the `agent` role is active — a missing key must never crash config loading
  // itself, only job registration, so local dev without a key still boots on every other role.
  ANTHROPIC_API_KEY: z.string().optional(),
  // All-or-none pairs, same convention as the api's GOOGLE_CLIENT_ID/SECRET (config.ts's oauthPair).
  // Independently optional: a deployment that only supports Gmail need not configure MS_OAUTH at all.
  GMAIL_OAUTH_CLIENT_ID: z.string().optional(),
  GMAIL_OAUTH_CLIENT_SECRET: z.string().optional(),
  MS_OAUTH_CLIENT_ID: z.string().optional(),
  MS_OAUTH_CLIENT_SECRET: z.string().optional(),
  // projects/<p>/topics/<t> — absent means mailbox.renew-watch never subscribes a Gmail connection to
  // push, and mailbox.poll-sweep's fallback cadence (no active push subscription) is what keeps it synced.
  GMAIL_PUBSUB_TOPIC: z.string().optional(),
  // https origin of the api; absent means mailbox.renew-watch never creates a Graph subscription
  // (notificationUrl = `${WEBHOOK_PUBLIC_URL}/webhooks/microsoft`).
  WEBHOOK_PUBLIC_URL: z.string().optional(),
  // The same literal address the api's MailTransport sends platform mail (sign-in codes, invitations,
  // address-verification codes) FROM — @aesa/mail's sync walk compares an inbound message's From
  // against this to recognize the platform's own mail and never let it become a customer ticket.
  // Duplicated across apps/api/.env and apps/worker/.env because each app reads only its own .env
  // (CLAUDE.md); the two MUST name the same address in any real deployment.
  MAIL_FROM: z.string().optional(),
})

export interface OAuthClient {
  clientId: string
  clientSecret: Secret
}

export interface WorkerConfig {
  env: 'development' | 'test' | 'production'
  databaseUrl: string
  roles: Set<WorkerRole>
  kekRing: KekRing | null
  logLevel: string
  anthropicApiKey: Secret | null
  gmailOauth: OAuthClient | null
  msOauth: OAuthClient | null
  gmailPubsubTopic: string | null
  webhookPublicUrl: string | null
  /** Lowercased addr-spec parsed out of MAIL_FROM (which may carry a display name); null when unset. */
  platformSender: string | null
}

function oauthPair(name: 'GMAIL_OAUTH' | 'MS_OAUTH', id: string | undefined, secret: string | undefined): OAuthClient | null {
  if (!id && !secret) return null
  if (!id || !secret) throw new Error(`${name}_CLIENT_ID and ${name}_CLIENT_SECRET must be set together`)
  return { clientId: id, clientSecret: new Secret(secret) }
}

export function loadConfig(env: NodeJS.ProcessEnv): WorkerConfig {
  const parsed = EnvSchema.safeParse(env)
  if (!parsed.success) throw new Error(`Invalid environment: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
  const d = parsed.data
  const production = d.NODE_ENV === 'production'
  const roles = parseWorkerRoles(d.WORKER_ROLES)

  // A *present but blank* AESA_KEK_V1 is the shipped .env.example shape; loadKekRing skips blanks and
  // then throws on AESA_KEK_ACTIVE, so presence alone must not claim a ring.
  const hasKek = Object.entries(env).some(([k, v]) => /^AESA_KEK_V\d+$/.test(k) && Boolean(v))
  const kekRing = hasKek ? loadKekRing(env as Record<string, string | undefined>) : null
  if (production && roles.has('sync') && !kekRing) {
    throw new Error('AESA_KEK_V<n> and AESA_KEK_ACTIVE are required in production when WORKER_ROLES includes `sync` (mailbox credentials)')
  }

  const platformSender = d.MAIL_FROM ? parseFirstAddrSpec(d.MAIL_FROM) : null
  if (production && roles.has('sync') && !platformSender) {
    throw new Error('MAIL_FROM is required in production when WORKER_ROLES includes `sync` (mailbox.sync platform-mail detection)')
  }

  return {
    env: d.NODE_ENV,
    databaseUrl: d.DATABASE_URL,
    roles,
    kekRing,
    logLevel: d.LOG_LEVEL,
    anthropicApiKey: d.ANTHROPIC_API_KEY ? new Secret(d.ANTHROPIC_API_KEY) : null,
    gmailOauth: oauthPair('GMAIL_OAUTH', d.GMAIL_OAUTH_CLIENT_ID, d.GMAIL_OAUTH_CLIENT_SECRET),
    msOauth: oauthPair('MS_OAUTH', d.MS_OAUTH_CLIENT_ID, d.MS_OAUTH_CLIENT_SECRET),
    gmailPubsubTopic: d.GMAIL_PUBSUB_TOPIC?.trim() || null,
    webhookPublicUrl: d.WEBHOOK_PUBLIC_URL ? d.WEBHOOK_PUBLIC_URL.replace(/\/+$/, '') : null,
    platformSender,
  }
}
