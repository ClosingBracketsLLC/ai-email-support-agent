import { assertInvariants, loadDotEnv } from '@aesa/core'
import { createDb } from '@aesa/db/raw'
import { loadConfig } from './config.ts'
import { buildServer } from './server.ts'

loadDotEnv(import.meta.url)
const config = loadConfig(process.env)
assertInvariants()
const { db, pool } = createDb(config.databaseUrl, { role: 'app' })
const app = buildServer({ db, pool, logLevel: config.logLevel })
await app.listen({ port: config.port, host: config.host })
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, async () => { await app.close(); await pool.end(); process.exit(0) })
}
