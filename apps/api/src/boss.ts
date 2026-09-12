import PgBoss from 'pg-boss'
import { createQueueRetrying, JOB_NAMES } from '@aesa/queue'

/**
 * A send-only pg-boss client for the api. The worker (apps/worker) owns every job handler and every
 * maintenance/cron loop; the api only ever `boss.send()`s. `supervise: false` / `schedule: false` (both
 * confirmed real `PgBoss.ConstructorOptions` — `MaintenanceOptions.supervise` / `SchedulingOptions.schedule`,
 * pg-boss 10.4.2's `types.d.ts`, both defaulting to `true`) turn off pg-boss's own archive/purge/monitor-state
 * loops and its cron scheduler on this process: the worker already runs them, and a second supervisor loop
 * racing the same archive/purge/schedule tables from every api replica would be redundant background chatter
 * with no consumer here, not a safety net. `migrate` is left at its default (`true`): the `pgboss` schema has
 * to exist before `boss.send()`/`createQueue()` can run, and in a fresh environment — or a throwaway test
 * database, where the worker never runs at all — the api may be the FIRST process to start a boss client, so
 * its own `start()` has to be able to lay the schema down.
 */
export async function createSendOnlyBoss(connectionString: string): Promise<PgBoss> {
  const boss = new PgBoss({ connectionString, schema: 'pgboss', supervise: false, schedule: false })
  boss.on('error', (e) => console.error('[pg-boss]', e))
  await boss.start()

  // pg-boss 10's insertJob SQL INNER JOINs the new job row against the queue table and silently returns
  // null (no error at all — boss.send() just resolves null) when the named queue doesn't exist yet (Task
  // 15's finding). Create every queue this api will ever send to right after start, so a send from a
  // cold-booted api replica — one that raced ahead of the worker's own queue creation, or is running
  // against a brand-new database in a test — never silently no-ops.
  // The policy must match `defineJob`'s `queue.policy`; pg-boss `createQueue` ignores a second call, so
  // the FIRST process to boot decides. `options.name` below is redundant with the positional `name`
  // arg — pg-boss's own `PgBoss.Queue` type requires it, but `manager.js`'s `createQueue` ignores it
  // at runtime (`name = name || options.name`) — it's here only to satisfy the type.
  await createQueueRetrying(boss, JOB_NAMES.keysProvision)
  await createQueueRetrying(boss, JOB_NAMES.storeCredentials)
  await createQueueRetrying(boss, JOB_NAMES.revokeMailbox)
  await createQueueRetrying(boss, JOB_NAMES.mailboxSync)
  await createQueueRetrying(boss, JOB_NAMES.ticketDraft, { name: JOB_NAMES.ticketDraft, policy: 'short' })
  await createQueueRetrying(boss, JOB_NAMES.agentSandbox, { name: JOB_NAMES.agentSandbox, policy: 'short' })
  await createQueueRetrying(boss, JOB_NAMES.sendExecute, { name: JOB_NAMES.sendExecute, policy: 'short' })
  await createQueueRetrying(boss, JOB_NAMES.notifyDispatch, { name: JOB_NAMES.notifyDispatch, policy: 'short' })
  await createQueueRetrying(boss, JOB_NAMES.knowledgeIngest, { name: JOB_NAMES.knowledgeIngest, policy: 'short' })
  await createQueueRetrying(boss, JOB_NAMES.knowledgeCrawl, { name: JOB_NAMES.knowledgeCrawl, policy: 'short' })
  await createQueueRetrying(boss, JOB_NAMES.knowledgeEmbedBatch, { name: JOB_NAMES.knowledgeEmbedBatch, policy: 'short' })
  // Phase 5: `approveDraft` sends guidance.suggest after an edited approval — the api IS that
  // producer. It never sends memory.capture (the worker's send.execute does, from its onSent seam),
  // but the four-places rule is literal: every queue is pre-created on both processes regardless.
  await createQueueRetrying(boss, JOB_NAMES.guidanceSuggest, { name: JOB_NAMES.guidanceSuggest, policy: 'short' })
  await createQueueRetrying(boss, JOB_NAMES.memoryCapture, { name: JOB_NAMES.memoryCapture, policy: 'short' })

  return boss
}
