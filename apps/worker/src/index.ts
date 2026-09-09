import { assertInvariants, loadDotEnv } from '@aesa/core'
import { createDb } from '@aesa/db/raw'
import { startBoss } from '@aesa/queue'
import { maybeRegisterAgentRole } from './agent-role.ts'
import { loadConfig } from './config.ts'
import { registerPlatformHeartbeat } from './jobs/platform-heartbeat.ts'
import { createWorkerLogger } from './logging.ts'

loadDotEnv(import.meta.url)
const config = loadConfig(process.env)
assertInvariants()
const logger = createWorkerLogger(config.logLevel)
const { db, pool } = createDb(config.databaseUrl, { role: 'app' })
const boss = await startBoss(config.databaseUrl)
logger.info({ roles: [...config.roles], kekActive: config.kekRing?.active ?? null }, 'worker up')

if (config.roles.has('cron')) await registerPlatformHeartbeat(boss, db)
await maybeRegisterAgentRole({
  boss, db, logger, config,
  // Task 16 wires the real notify.dispatch enqueue; until then, log so an escalation notification
  // row created by ticket.triage is never silently undelivered.
  enqueueNotify: async (orgId, notificationId) => {
    logger.warn({ orgId, notificationId }, 'notify.dispatch not yet wired (Task 16) — notification row created but not dispatched')
  },
})
// Phase 2+: registerJob(boss, mailboxSync, { logger }) when roles.has('sync'), etc. — pass `logger` into
// each job registrar added by a later task so every job logs through this one redacted, structured sink.

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, async () => { await boss.stop({ graceful: true, wait: true }); await pool.end(); process.exit(0) })
}
