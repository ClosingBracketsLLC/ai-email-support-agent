import { assertInvariants, loadDotEnv } from '@aesa/core'
import { createDb } from '@aesa/db/raw'
import { createMailLimiter } from '@aesa/mail'
import { createMailTransport } from '@aesa/platform-mail'
import { createQueueRetrying, JOB_NAMES, startBoss } from '@aesa/queue'
import { maybeRegisterAgentRole } from './agent-role.ts'
import { loadConfig } from './config.ts'
import { registerKeysProvision } from './jobs/keys-provision.ts'
import { enqueueKnowledgeEmbedBatch } from './jobs/knowledge-embed-batch.ts'
import { enqueueMemoryCapture } from './jobs/memory-capture.ts'
import { registerRevokeMailbox, registerStoreCredentials } from './jobs/mailbox-credentials.ts'
import { registerMailboxPollSweep } from './jobs/mailbox-poll-sweep.ts'
import { registerMailboxRenewWatch } from './jobs/mailbox-renew-watch.ts'
import { registerMailboxSync } from './jobs/mailbox-sync.ts'
import { registerNotifyDigest } from './jobs/notify-digest.ts'
import { enqueueNotifyDispatch, registerNotifyDispatch } from './jobs/notify-dispatch.ts'
import { registerPlatformHeartbeat } from './jobs/platform-heartbeat.ts'
import { enqueueSendExecute } from './jobs/send-execute.ts'
import { registerStatsRollup } from './jobs/stats-rollup.ts'
import { registerSweepsDaily } from './jobs/sweeps-daily.ts'
import { registerTicketBackstopSweep } from './jobs/ticket-backstop-sweep.ts'
import { enqueueTicketDraft } from './jobs/ticket-draft.ts'
import { maybeRegisterKnowledgeRole } from './knowledge-role.ts'
import { createWorkerLogger } from './logging.ts'
import { createExpoPush } from './push.ts'
import { maybeRegisterSendRole } from './send-role.ts'

loadDotEnv(import.meta.url)
const config = loadConfig(process.env)
assertInvariants()
const logger = createWorkerLogger(config.logLevel)
const { db, pool } = createDb(config.databaseUrl, { role: 'app' })
const boss = await startBoss(config.databaseUrl)
logger.info({ roles: [...config.roles], kekActive: config.kekRing?.active ?? null }, 'worker up')

// pg-boss 10's insertJob SQL INNER JOINs the new job row against the queue table and returns zero
// rows (no error, `boss.send` resolves `null`) when the named queue does not exist yet. notify.dispatch
// is now registered unconditionally right below, but ticket.triage's, ticket.draft's, agent.sandbox's,
// mailbox.sync's and send.execute's OWN queues are still created only by their config/role-gated
// `registerJob` calls further down — a `WORKER_ROLES=sync` replica with no ANTHROPIC_API_KEY never runs
// `registerTicketTriage`/`registerAgentSandbox` on this process, and mailbox.poll-sweep's (d)/(e) enqueue
// `ticket.triage` regardless; the same gap hits mailbox.sync on a `sync`-role replica missing the KEK
// ring or MAIL_FROM, which mailbox.poll-sweep's (a) enqueues into unconditionally too, agent.sandbox
// (whose producer is the API's sandbox-start mutation, on a process that runs no worker roles at all),
// and send.execute (whose producer is the API's approve mutation, same story). Create all nine
// unconditionally at boot, before any role-gated registration, so a send never silently no-ops on a
// role-partitioned or under-configured replica.
// The policy must match `defineJob`'s `queue.policy`; pg-boss `createQueue` ignores a second call, so
// the FIRST process to boot decides. ticket.triage and mailbox.sync stay optionless — they are
// `standard` on purpose (CLAUDE.md Jobs: their burst source is a push webhook, deduped instead through
// `enqueue`'s `debounceSeconds`). `options.name` below is redundant with the positional `name` arg —
// pg-boss's own `PgBoss.Queue` type requires it, but `manager.js`'s `createQueue` ignores it at
// runtime (`name = name || options.name`) — it's here only to satisfy the type.
await createQueueRetrying(boss, JOB_NAMES.notifyDispatch, { name: JOB_NAMES.notifyDispatch, policy: 'short' })
await createQueueRetrying(boss, JOB_NAMES.ticketTriage)
await createQueueRetrying(boss, JOB_NAMES.ticketDraft, { name: JOB_NAMES.ticketDraft, policy: 'short' })
await createQueueRetrying(boss, JOB_NAMES.agentSandbox, { name: JOB_NAMES.agentSandbox, policy: 'short' })
await createQueueRetrying(boss, JOB_NAMES.mailboxSync)
await createQueueRetrying(boss, JOB_NAMES.sendExecute, { name: JOB_NAMES.sendExecute, policy: 'short' })
// Phase 4's three: the api's knowledge router sends all three (completeUpload/paste → ingest,
// startCrawl → crawl, unflagChunk → embed-batch) and the crawl/ingest jobs send embed-batch
// themselves — none of which may depend on a `knowledge`-role replica having booted first.
await createQueueRetrying(boss, JOB_NAMES.knowledgeIngest, { name: JOB_NAMES.knowledgeIngest, policy: 'short' })
await createQueueRetrying(boss, JOB_NAMES.knowledgeCrawl, { name: JOB_NAMES.knowledgeCrawl, policy: 'short' })
await createQueueRetrying(boss, JOB_NAMES.knowledgeEmbedBatch, { name: JOB_NAMES.knowledgeEmbedBatch, policy: 'short' })
// Phase 5's two: send.execute's onSent seam sends memory.capture from THIS process (worker-only —
// the api never sends it); the api's approve mutation sends guidance.suggest after an edited
// approval. Pre-created here regardless of producer, same as every queue above.
await createQueueRetrying(boss, JOB_NAMES.memoryCapture, { name: JOB_NAMES.memoryCapture, policy: 'short' })
await createQueueRetrying(boss, JOB_NAMES.guidanceSuggest, { name: JOB_NAMES.guidanceSuggest, policy: 'short' })

// notify.dispatch's producers span every role (ticket.triage's escalations under `agent`,
// mailbox.sync/renew-watch's reauth notices and mailbox.poll-sweep's stuck-pending retry under
// `sync`) and its handler needs no per-role secret (Expo push needs no API key to send) — register
// it unconditionally, wherever this worker process runs, so delivery never depends on which roles
// happen to be active on a given replica.
const push = createExpoPush(logger)
await registerNotifyDispatch(boss, { db, push, logger })

if (config.roles.has('cron')) {
  await registerPlatformHeartbeat(boss, db)
  // The ONLY process that sends platform mail besides the api: notify.digest's daily digest email.
  // Its links need both origins, so an unconfigured deployment logs once and runs push-only.
  const mail = createMailTransport(config.mail)
  await registerNotifyDigest(boss, { db, push, logger, mail, appBaseUrl: config.appBaseUrl, appWebOrigin: config.appWebOrigin })
  await registerTicketBackstopSweep(boss, { db, logger })
  await registerSweepsDaily(boss, { db, logger })
  await registerStatsRollup(boss, { db, logger })
}

await maybeRegisterAgentRole({
  boss, db, logger, config,
  enqueueNotify: (orgId, notificationId) => enqueueNotifyDispatch(boss, orgId, notificationId),
  enqueueDraft: (orgId, ticketId, opts) => enqueueTicketDraft(boss, orgId, ticketId, opts),
  // The auto landing's send. `enqueueSendExecute` resolves the pg-boss job id (or null when the
  // `short` queue collapsed a duplicate); the draft job only needs "it was handed over".
  enqueueSend: (orgId, sendId, opts) => enqueueSendExecute(boss, orgId, sendId, opts).then(() => undefined),
})

await maybeRegisterKnowledgeRole({
  boss, db, logger, config,
  enqueueEmbedBatch: (orgId, documentId) => enqueueKnowledgeEmbedBatch(boss, orgId, documentId),
})

// ONE limiter for the whole process, created ABOVE the role branches and shared by `mailbox.sync`
// and `send.execute`. Its per-connection gate (concurrency 1) is what serializes a send against a
// poll of the SAME mailbox; two instances would each think they held the only slot and let a send
// and a sync hit the provider — and the same thread — at once.
const limiter = createMailLimiter()

await maybeRegisterSendRole({
  boss, db, config, limiter, logger,
  enqueueNotify: (orgId, notificationId) => enqueueNotifyDispatch(boss, orgId, notificationId),
  enqueueDraft: (orgId, ticketId) => enqueueTicketDraft(boss, orgId, ticketId),
  // Phase 5: one delivered reply becomes — or reinforces — one resolved answer. Runs on the `agent`
  // role (it embeds); send.execute never lets this enqueue's own failure fail the send it followed.
  onSent: (p) => enqueueMemoryCapture(boss, p.orgId, p.draftId),
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
      await registerMailboxSync(boss, { db, ring: config.kekRing, config, limiter, logger })
    }
  }

  // No KEK dependency: touches mailbox_connections/oauth_flows/tickets/webhook_events/notifications only.
  await registerMailboxPollSweep(boss, { db, logger })
}

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, async () => { await boss.stop({ graceful: true, wait: true }); await pool.end(); process.exit(0) })
}
