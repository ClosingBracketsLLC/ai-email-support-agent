import { assertInvariants, loadDotEnv } from '@aesa/core'
import { createDb } from '@aesa/db/raw'
import { createMailLimiter } from '@aesa/mail'
import { createQueueRetrying, JOB_NAMES, startBoss } from '@aesa/queue'
import { maybeRegisterAgentRole } from './agent-role.ts'
import { loadConfig } from './config.ts'
import { registerKeysProvision } from './jobs/keys-provision.ts'
import { registerRevokeMailbox, registerStoreCredentials } from './jobs/mailbox-credentials.ts'
import { registerMailboxPollSweep } from './jobs/mailbox-poll-sweep.ts'
import { registerMailboxRenewWatch } from './jobs/mailbox-renew-watch.ts'
import { registerMailboxSync } from './jobs/mailbox-sync.ts'
import { registerNotifyDigest } from './jobs/notify-digest.ts'
import { enqueueNotifyDispatch, registerNotifyDispatch } from './jobs/notify-dispatch.ts'
import { registerPlatformHeartbeat } from './jobs/platform-heartbeat.ts'
import { createWorkerLogger } from './logging.ts'
import { createExpoPush } from './push.ts'

loadDotEnv(import.meta.url)
const config = loadConfig(process.env)
assertInvariants()
const logger = createWorkerLogger(config.logLevel)
const { db, pool } = createDb(config.databaseUrl, { role: 'app' })
const boss = await startBoss(config.databaseUrl)
logger.info({ roles: [...config.roles], kekActive: config.kekRing?.active ?? null }, 'worker up')

// pg-boss 10's insertJob SQL INNER JOINs the new job row against the queue table and returns zero
// rows (no error, `boss.send` resolves `null`) when the named queue does not exist yet. notify.dispatch
// is now registered unconditionally right below, but ticket.triage's and mailbox.sync's OWN queues
// are still created only by their config/role-gated `registerJob` calls further down — a
// `WORKER_ROLES=sync` replica with no ANTHROPIC_API_KEY never runs `registerTicketTriage` on this
// process, and mailbox.poll-sweep's (d)/(e) enqueue `ticket.triage` regardless; the same gap hits
// mailbox.sync on a `sync`-role replica missing the KEK ring or MAIL_FROM, which mailbox.poll-sweep's
// (a) enqueues into unconditionally too. Create all three unconditionally at boot, before any
// role-gated registration, so a send never silently no-ops on a role-partitioned or under-configured
// replica.
await createQueueRetrying(boss, JOB_NAMES.notifyDispatch)
await createQueueRetrying(boss, JOB_NAMES.ticketTriage)
await createQueueRetrying(boss, JOB_NAMES.mailboxSync)

// notify.dispatch's producers span every role (ticket.triage's escalations under `agent`,
// mailbox.sync/renew-watch's reauth notices and mailbox.poll-sweep's stuck-pending retry under
// `sync`) and its handler needs no per-role secret (Expo push needs no API key to send) — register
// it unconditionally, wherever this worker process runs, so delivery never depends on which roles
// happen to be active on a given replica.
const push = createExpoPush(logger)
await registerNotifyDispatch(boss, { db, push, logger })

if (config.roles.has('cron')) {
  await registerPlatformHeartbeat(boss, db)
  await registerNotifyDigest(boss, { db, push, logger })
}

await maybeRegisterAgentRole({
  boss, db, logger, config,
  enqueueNotify: (orgId, notificationId) => enqueueNotifyDispatch(boss, orgId, notificationId),
})

if (config.roles.has('sync')) {
  if (!config.kekRing) {
    // loadConfig already refuses to boot in production without a ring when `sync` is active — this
    // branch is reachable only in dev/test, mirroring maybeRegisterAgentRole's ANTHROPIC_API_KEY gate.
    logger.warn(
      'AESA_KEK_V<n>/AESA_KEK_ACTIVE missing; skipping keys.provision, mailbox.store-credentials, ' +
        'mailbox.revoke, mailbox.sync and mailbox.renew-watch registration (sync role otherwise inactive)',
    )
  } else {
    await registerKeysProvision(boss, { db, ring: config.kekRing })
    await registerStoreCredentials(boss, { db })
    await registerRevokeMailbox(boss, { db, ring: config.kekRing, config, logger })
    await registerMailboxRenewWatch(boss, { db, ring: config.kekRing, config, logger })

    if (!config.platformSender) {
      // Same dev/test-only gate as the KEK ring above — loadConfig refuses to boot in production
      // without MAIL_FROM when `sync` is active.
      logger.warn('MAIL_FROM missing; skipping mailbox.sync registration (sync role otherwise inactive)')
    } else {
      const limiter = createMailLimiter()
      await registerMailboxSync(boss, { db, ring: config.kekRing, config, limiter, logger })
    }
  }

  // No KEK dependency: touches mailbox_connections/oauth_flows/tickets/webhook_events/notifications only.
  await registerMailboxPollSweep(boss, { db, logger })
}

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, async () => { await boss.stop({ graceful: true, wait: true }); await pool.end(); process.exit(0) })
}
