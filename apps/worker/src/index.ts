import { assertInvariants, loadDotEnv } from '@aesa/core'
import { loadModelPricing } from '@aesa/db'
import { createDb } from '@aesa/db/raw'
import { createMailLimiter } from '@aesa/mail'
import { createMailTransport } from '@aesa/platform-mail'
import { createQueueRetrying, JOB_NAMES, queueOptionsFor, startBoss } from '@aesa/queue'
import { maybeRegisterAgentRole } from './agent-role.ts'
import { loadConfig } from './config.ts'
import { registerKeysProvision } from './jobs/keys-provision.ts'
import { enqueueKnowledgeEmbedBatch } from './jobs/knowledge-embed-batch.ts'
import { enqueueLlmProbe } from './jobs/llm-probe.ts'
import { registerLlmReprobeSweep } from './jobs/llm-reprobe-sweep.ts'
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
// The platform price table, read ONCE at boot and handed to every metered provider. An empty table
// (nothing seeded, or a database that predates 0020) is passed as `undefined` so `withMetering`
// stays on its code-seeded `PRICING_SEED` rather than costing every call at zero.
const pricing = await loadModelPricing(db)
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
// and send.execute (whose producer is the API's approve mutation, same story). Create all twelve
// unconditionally at boot, before any role-gated registration, so a send never silently no-ops on a
// role-partitioned or under-configured replica.
// Every option below comes from `QUEUE_OPTIONS` (`packages/queue/src/queue-options.ts`) via
// `queueOptionsFor` — the ONE table a queue's policy/retry/expiry values are read from, so this list
// and `apps/api/src/boss.ts`'s can never drift from what each job's OWN `defineJob` call resolves
// to. pg-boss `createQueue` ignores a second call, so the FIRST process to boot decides.
// ticket.triage and mailbox.sync stay `standard` on purpose (CLAUDE.md Jobs: their burst source is
// a push webhook, deduped instead through `enqueue`'s `debounceSeconds`).
await createQueueRetrying(boss, JOB_NAMES.notifyDispatch, queueOptionsFor(JOB_NAMES.notifyDispatch))
await createQueueRetrying(boss, JOB_NAMES.ticketTriage, queueOptionsFor(JOB_NAMES.ticketTriage))
await createQueueRetrying(boss, JOB_NAMES.ticketDraft, queueOptionsFor(JOB_NAMES.ticketDraft))
await createQueueRetrying(boss, JOB_NAMES.agentSandbox, queueOptionsFor(JOB_NAMES.agentSandbox))
await createQueueRetrying(boss, JOB_NAMES.mailboxSync, queueOptionsFor(JOB_NAMES.mailboxSync))
await createQueueRetrying(boss, JOB_NAMES.sendExecute, queueOptionsFor(JOB_NAMES.sendExecute))
// Phase 4's three: the api's knowledge router sends all three (completeUpload/paste → ingest,
// startCrawl → crawl, unflagChunk → embed-batch) and the crawl/ingest jobs send embed-batch
// themselves — none of which may depend on a `knowledge`-role replica having booted first.
await createQueueRetrying(boss, JOB_NAMES.knowledgeIngest, queueOptionsFor(JOB_NAMES.knowledgeIngest))
await createQueueRetrying(boss, JOB_NAMES.knowledgeCrawl, queueOptionsFor(JOB_NAMES.knowledgeCrawl))
await createQueueRetrying(boss, JOB_NAMES.knowledgeEmbedBatch, queueOptionsFor(JOB_NAMES.knowledgeEmbedBatch))
// Phase 5's two: send.execute's onSent seam sends memory.capture from THIS process (worker-only —
// the api never sends it); the api's approve mutation sends guidance.suggest after an edited
// approval. Pre-created here regardless of producer, same as every queue above.
await createQueueRetrying(boss, JOB_NAMES.memoryCapture, queueOptionsFor(JOB_NAMES.memoryCapture))
await createQueueRetrying(boss, JOB_NAMES.guidanceSuggest, queueOptionsFor(JOB_NAMES.guidanceSuggest))
// Phase 6: the api's `llm.addCredential`/`probeCredential` and the worker's own `llm.reprobe-sweep`
// both send it.
await createQueueRetrying(boss, JOB_NAMES.llmProbe, queueOptionsFor(JOB_NAMES.llmProbe))

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
  // Phase 6: every six hours, re-ask each live BYOK credential whether it still works — a key can be
  // revoked or rotated at any time, and without this the workspace finds out from a failed draft.
  await registerLlmReprobeSweep(boss, {
    db, logger, enqueueProbe: (orgId, credentialId, opts) => enqueueLlmProbe(boss, orgId, credentialId, opts),
  })
}

await maybeRegisterAgentRole({
  boss, db, logger, config,
  enqueueNotify: (orgId, notificationId) => enqueueNotifyDispatch(boss, orgId, notificationId),
  enqueueDraft: (orgId, ticketId, opts) => enqueueTicketDraft(boss, orgId, ticketId, opts),
  // The auto landing's send. `enqueueSendExecute` resolves the pg-boss job id (or null when the
  // `short` queue collapsed a duplicate); the draft job only needs "it was handed over".
  enqueueSend: (orgId, sendId, opts) => enqueueSendExecute(boss, orgId, sendId, opts).then(() => undefined),
  ...(pricing.length > 0 ? { pricing } : {}),
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
