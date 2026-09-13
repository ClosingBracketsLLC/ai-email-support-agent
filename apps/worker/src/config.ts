import { loadKekRing, Secret, type KekRing } from '@aesa/crypto'
import { parseS3Env, type S3Config } from '@aesa/knowledge'
import { parseFirstAddrSpec } from '@aesa/mail'
import { parseMailConfig, type MailConfig } from '@aesa/platform-mail'
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
  // Platform mail (the `cron` role's daily digest email). Same three variables the api reads, and
  // MAIL_FROM MUST name the same address in both apps (see its own comment above).
  EMAIL_TRANSPORT: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  // The api's public origin — the base of the digest email's one-click review links
  // (`<APP_BASE_URL>/a/<draftId>?t=<token>`). Optional: without it the digest email pass stays off.
  APP_BASE_URL: z.string().optional(),
  // The Expo web origin — the base of the digest email's "open the ticket" links
  // (`<APP_WEB_ORIGIN>/ticket/<ticketId>`). Optional, same as APP_BASE_URL.
  APP_WEB_ORIGIN: z.string().optional(),
  // Voyage embeddings (and the optional reranker). Optional here, like ANTHROPIC_API_KEY: the
  // production gates below are what refuse a `knowledge` or `agent` replica without it, so a dev
  // box falls back to the deterministic hash embedder instead of failing to boot.
  VOYAGE_API_KEY: z.string().optional(),
  // Which Voyage model writes (and therefore which model's rows retrieval scores — `embedding_model`
  // is part of the vector leg's WHERE). Changing it on a live workspace makes every existing chunk
  // invisible to the vector leg until Phase 6's re-embed job runs.
  KNOWLEDGE_EMBED_MODEL: z.enum(['voyage-4', 'voyage-4-lite']).default('voyage-4'),
  // The cross-encoder rerank pass over the fused candidates: off by default (it costs one more
  // Voyage call per retrieval) and inert without VOYAGE_API_KEY.
  KNOWLEDGE_RERANK: z.enum(['on', 'off']).default('off'),
  // Object storage for uploads — all six or none (parseS3Env). Required in production when
  // WORKER_ROLES includes `knowledge`: knowledge.ingest reads every uploaded file's bytes from it.
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().optional(),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: z.string().optional(),
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
  /** How the `cron` role's daily digest email is sent; devsink on any replica that never sends one. */
  mail: MailConfig
  /** The api's public origin, trailing slash stripped; null disables the digest email pass. */
  appBaseUrl: string | null
  /** The Expo web origin, trailing slash stripped; null disables the digest email pass. */
  appWebOrigin: string | null
  /** Voyage's key; null falls back to the deterministic hash embedder (dev/test only). */
  voyageApiKey: Secret | null
  /** Which Voyage model `knowledge.embed-batch` writes with (and retrieval therefore scores). */
  knowledgeEmbedModel: 'voyage-4' | 'voyage-4-lite'
  /** KNOWLEDGE_RERANK=on: the optional cross-encoder pass over the fused retrieval candidates. */
  knowledgeRerank: boolean
  /** The six `S3_*` as one config, or null when object storage is not configured at all. */
  s3: WorkerS3Config | null
}

/** `parseS3Env`'s shape with the secret wrapped: the same rule every other credential here follows
 * (`Secret` serializes as `[redacted]`, so a config dump can never spill the bucket's keys). */
export type WorkerS3Config = Omit<S3Config, 'secretAccessKey'> & { secretAccessKey: Secret }

const isHttpUrl = (v: string) => { try { return ['http:', 'https:'].includes(new URL(v).protocol) } catch { return false } }

/** Optional http(s) origin, normalized like the api's own (trailing slashes stripped so links join cleanly). */
function optionalOrigin(name: 'APP_BASE_URL' | 'APP_WEB_ORIGIN', raw: string | undefined): string | null {
  const value = raw?.trim()
  if (!value) return null
  if (!isHttpUrl(value)) throw new Error(`${name} must be an http(s) URL`)
  return value.replace(/\/+$/, '')
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
  // Phase 6: an `agent` replica opens a tenant's BYOK provider key under that org's DEK on every
  // model call (`provider-resolver.ts`), and `llm.probe` re-wraps a freshly sealed key under it —
  // without the ring every BYOK agent silently degrades to `provider_unavailable`, so refuse at boot.
  if (production && roles.has('agent') && !kekRing) {
    throw new Error('AESA_KEK_V<n> and AESA_KEK_ACTIVE are required in production when WORKER_ROLES includes `agent` (BYOK provider keys are opened under the org DEK)')
  }

  // All-or-none, and it throws on a half-configured deploy — read from the ALREADY-PARSED values so
  // the six names are documented in EnvSchema above rather than only inside `parseS3Env`.
  const rawS3 = parseS3Env({
    S3_ENDPOINT: d.S3_ENDPOINT, S3_REGION: d.S3_REGION, S3_BUCKET: d.S3_BUCKET,
    S3_ACCESS_KEY_ID: d.S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY: d.S3_SECRET_ACCESS_KEY,
    S3_FORCE_PATH_STYLE: d.S3_FORCE_PATH_STYLE,
  })
  const s3: WorkerS3Config | null = rawS3 ? { ...rawS3, secretAccessKey: new Secret(rawS3.secretAccessKey) } : null
  // The `knowledge` role reads every upload's bytes out of the bucket and the `agent` role's
  // retriever embeds every query — neither has a production fallback (the hash embedder is a dev
  // convenience whose vectors are not comparable with Voyage's), so refuse at boot rather than
  // running a replica that looks healthy while every ingest fails or every draft loses its grounding.
  if (production && (roles.has('knowledge') || roles.has('agent')) && !d.VOYAGE_API_KEY) {
    throw new Error('VOYAGE_API_KEY is required in production when WORKER_ROLES includes `agent` or `knowledge` (embeddings)')
  }
  if (production && roles.has('knowledge') && !s3) {
    throw new Error('S3_* (endpoint, region, bucket, access key id, secret access key, force path style) are required in production when WORKER_ROLES includes `knowledge` (upload storage)')
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
    // Only the `cron` role sends platform mail (notify.digest's email pass), so only it must be
    // fully configured in production — a sync/agent/send replica lands on the devsink it never calls.
    mail: parseMailConfig(
      { EMAIL_TRANSPORT: d.EMAIL_TRANSPORT, RESEND_API_KEY: d.RESEND_API_KEY, MAIL_FROM: d.MAIL_FROM },
      { production, requireInProduction: roles.has('cron') },
    ),
    appBaseUrl: optionalOrigin('APP_BASE_URL', d.APP_BASE_URL),
    appWebOrigin: optionalOrigin('APP_WEB_ORIGIN', d.APP_WEB_ORIGIN),
    voyageApiKey: d.VOYAGE_API_KEY ? new Secret(d.VOYAGE_API_KEY) : null,
    knowledgeEmbedModel: d.KNOWLEDGE_EMBED_MODEL,
    knowledgeRerank: d.KNOWLEDGE_RERANK === 'on',
    s3,
  }
}
