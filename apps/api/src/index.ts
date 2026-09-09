import { assertInvariants, loadDotEnv } from '@aesa/core'
import { audit } from '@aesa/db'
import { createDb } from '@aesa/db/raw'
import { createAuth } from './auth.ts'
import { createSendOnlyBoss } from './boss.ts'
import { loadConfig } from './config.ts'
import { createApiFacade, createEnqueue } from './deps.ts'
import { createAppLogger } from './logging.ts'
import { createMailTransport } from './mail/transport.ts'
import { buildServer } from './server.ts'

loadDotEnv(import.meta.url)
const config = loadConfig(process.env)
assertInvariants()

const logger = createAppLogger({ level: config.logLevel })
// The only raw handle in the api. Everything below sees the facade or Better Auth, never db/pool.
const handle = createDb(config.databaseUrl, { role: 'app' })
const api = createApiFacade(handle)
const mail = createMailTransport(config.mail)
// Send-only: the api enqueues jobs, never works one (the worker owns every handler and every
// maintenance/cron loop — see boss.ts).
const boss = await createSendOnlyBoss(config.databaseUrl)
const enqueue = createEnqueue(boss)
const auth = createAuth({ db: handle.db, config, mail, logger, audit: (orgId, entry) => api.withOrg(orgId, (tx) => audit(tx, entry)) })
const app = buildServer({ config, auth, api, mail, logger, enqueue })

await app.listen({ port: config.port, host: config.host })
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, async () => { await app.close(); await boss.stop({ graceful: true, wait: true }); await handle.pool.end(); process.exit(0) })
}
