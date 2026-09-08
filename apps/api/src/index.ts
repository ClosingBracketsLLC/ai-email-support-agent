import { assertInvariants, loadDotEnv } from '@aesa/core'
import { audit } from '@aesa/db'
import { createDb } from '@aesa/db/raw'
import { createAuth } from './auth.ts'
import { loadConfig } from './config.ts'
import { createApiFacade } from './deps.ts'
import { createMailTransport } from './mail/transport.ts'
import { buildServer } from './server.ts'

loadDotEnv(import.meta.url)
const config = loadConfig(process.env)
assertInvariants()

// The only raw handle in the api. Everything below sees the facade or Better Auth, never db/pool.
const handle = createDb(config.databaseUrl, { role: 'app' })
const api = createApiFacade(handle)
const mail = createMailTransport(config.mail)
const auth = createAuth({ db: handle.db, config, mail, audit: (orgId, entry) => api.withOrg(orgId, (tx) => audit(tx, entry)) })
const app = buildServer({ config, auth, api, mail, logLevel: config.logLevel })

await app.listen({ port: config.port, host: config.host })
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, async () => { await app.close(); await handle.pool.end(); process.exit(0) })
}
