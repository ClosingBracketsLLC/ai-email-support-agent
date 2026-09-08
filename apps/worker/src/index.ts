import { assertInvariants, loadDotEnv } from '@aesa/core'
import { createDb } from '@aesa/db/raw'
import { startBoss } from '@aesa/queue'
import { loadConfig } from './config.ts'
import { registerPlatformHeartbeat } from './jobs/platform-heartbeat.ts'

loadDotEnv(import.meta.url)
const config = loadConfig(process.env)
assertInvariants()
const { db, pool } = createDb(config.databaseUrl, { role: 'app' })
const boss = await startBoss(config.databaseUrl)
console.log(`[worker] roles: ${[...config.roles].join(',')}; kek: ${config.kekRing ? `v${config.kekRing.active}` : 'none'}`)

if (config.roles.has('cron')) await registerPlatformHeartbeat(boss, db)
// Phase 2+: registerJob(boss, mailboxSync) when roles.has('sync'), etc.

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, async () => { await boss.stop({ graceful: true, wait: true }); await pool.end(); process.exit(0) })
}
