import { assertInvariants, loadDotEnv } from '@aesa/core'
import { audit } from '@aesa/db'
import { createDb } from '@aesa/db/raw'
import { createMemoryStore, createS3Store, type ObjectStore } from '@aesa/knowledge/storage'
import { createAuth } from './auth.ts'
import { createStripePort, type StripePort } from './billing/stripe.ts'
import { createSendOnlyBoss } from './boss.ts'
import { loadConfig } from './config.ts'
import { createApiFacade, createEnqueue } from './deps.ts'
import { createAppLogger } from './logging.ts'
import { createMailTransport } from './mail/transport.ts'
import { initObservability } from './observability.ts'
import { buildServer } from './server.ts'

loadDotEnv(import.meta.url)
const config = loadConfig(process.env)
// Task 11: initObservability FIRST, right after loadConfig — every error this process can produce
// from here on (the Fastify handler and the tRPC onError, both wired in server.ts) can reach Sentry.
// `SENTRY_RELEASE` is deliberately not part of `ApiConfig` — the runbook sets it from the deploy's
// git SHA as a plain env var, read here at the composition root.
const sentryEnabled = initObservability({
  sentry: config.sentryDsn ? { dsn: config.sentryDsn, environment: config.sentryEnvironment } : null,
  release: process.env.SENTRY_RELEASE,
})
assertInvariants()

const logger = createAppLogger({ level: config.logLevel })
if (!sentryEnabled) logger.warn('SENTRY_DSN missing; error reporting is off (alerts still log via pino)')
// The only raw handle in the api. Everything below sees the facade or Better Auth, never db/pool.
const handle = createDb(config.databaseUrl, { role: 'app' })
const api = createApiFacade(handle)
const mail = createMailTransport(config.mail)
// Send-only: the api enqueues jobs, never works one (the worker owns every handler and every
// maintenance/cron loop — see boss.ts).
const boss = await createSendOnlyBoss(config.databaseUrl)
const enqueue = createEnqueue(boss)
const auth = createAuth({ db: handle.db, config, mail, logger, audit: (orgId, entry) => api.withOrg(orgId, (tx) => audit(tx, entry)) })

// S3 (minio locally) when configured; loadConfig already refuses to boot a production api with no
// bucket, so the memory-store fallback below is reachable only in dev/test. `config.s3` already
// carries its secret as a `Secret` (loadConfig wraps it); createS3Store takes it as-is.
let store: ObjectStore
if (config.s3) {
  store = createS3Store(config.s3)
} else {
  logger.warn('S3_* missing; knowledge uploads use an in-memory object store (the web upload flow needs minio locally — see .env.example)')
  store = createMemoryStore()
}

// The ONE place the Stripe SDK is constructed. Null outside a configured deploy — loadConfig already
// refuses to boot a production api without STRIPE_*, so the warn below is reachable only in dev/test.
let stripe: StripePort | null = null
if (config.stripe) {
  stripe = createStripePort(config.stripe)
} else {
  logger.warn('STRIPE_* missing; billing is off (Subscribe and Manage billing refuse, POST /webhooks/stripe 404s)')
}

const app = buildServer({ config, auth, api, mail, logger, enqueue, store, stripe })

await app.listen({ port: config.port, host: config.host })
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, async () => { await app.close(); await boss.stop({ graceful: true, wait: true }); await handle.pool.end(); process.exit(0) })
}
