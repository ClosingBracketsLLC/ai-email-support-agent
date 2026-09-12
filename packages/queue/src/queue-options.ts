import type PgBoss from 'pg-boss'
import type { JobQueueOptions } from './define-job.ts'
import { JOB_NAMES, type JobName } from './names.ts'

/**
 * The ONE table of per-queue pg-boss options (Phase 4 residual, folded into Phase 6): `defineJob`
 * reads a queue's options from here, and BOTH pre-create lists (`apps/worker/src/index.ts`,
 * `apps/api/src/boss.ts`) pass `queueOptionsFor(name)` to `createQueueRetrying` — so the options
 * reach `pgboss.queue` at the queue's FIRST-EVER creation, whichever process creates it. Before this
 * table an api-only cold boot created a queue with NULL options, and a job sent before the worker's
 * `registerJob` ran `updateQueue` carried pg-boss's defaults (retry_limit 2, delay 0, 15-min expiry).
 *
 * Values are the ones each job's `defineJob` call carried before this table existed — copied, not
 * changed. `policy` absent means `standard` (ticket.triage, mailbox.sync: push-fed, debounced
 * through `enqueue`'s `debounceSeconds` instead — CLAUDE.md, Jobs).
 */
export const QUEUE_OPTIONS: Record<JobName, JobQueueOptions> = {
  [JOB_NAMES.keysProvision]: { expireInSeconds: 60, retryLimit: 3, retryBackoff: true },
  [JOB_NAMES.storeCredentials]: { expireInSeconds: 60, retryLimit: 5, retryBackoff: true },
  [JOB_NAMES.revokeMailbox]: { expireInSeconds: 120, retryLimit: 3, retryBackoff: true },
  [JOB_NAMES.mailboxSync]: { expireInSeconds: 300 },
  [JOB_NAMES.ticketTriage]: { expireInSeconds: 120, retryLimit: 2, retryBackoff: true },
  [JOB_NAMES.ticketDraft]: { policy: 'short', expireInSeconds: 600, retryLimit: 1, retryDelay: 30, retryBackoff: true },
  [JOB_NAMES.agentSandbox]: { policy: 'short', expireInSeconds: 600, retryLimit: 0 },
  [JOB_NAMES.sendExecute]: { policy: 'short', expireInSeconds: 600, retryLimit: 5, retryDelay: 30, retryBackoff: true },
  [JOB_NAMES.notifyDispatch]: { policy: 'short', expireInSeconds: 60, retryLimit: 2 },
  [JOB_NAMES.knowledgeIngest]: { policy: 'short', expireInSeconds: 600, retryLimit: 2, retryBackoff: true },
  // retryDelay 300 IS `apps/worker/src/jobs/knowledge-crawl.ts`'s `CRAWL_LEASE_SECONDS` — this
  // package cannot import a worker job file, so the value is duplicated by hand; keep them in sync.
  [JOB_NAMES.knowledgeCrawl]: { policy: 'short', expireInSeconds: 1800, retryLimit: 1, retryDelay: 300, retryBackoff: false },
  [JOB_NAMES.knowledgeEmbedBatch]: { policy: 'short', expireInSeconds: 300, retryLimit: 5, retryDelay: 30, retryBackoff: true },
  [JOB_NAMES.memoryCapture]: { policy: 'short', expireInSeconds: 120, retryLimit: 3, retryDelay: 30, retryBackoff: true },
  [JOB_NAMES.guidanceSuggest]: { policy: 'short', expireInSeconds: 120, retryLimit: 1 },
}

/** The `PgBoss.Queue` shape both pre-create lists hand to `createQueueRetrying`. */
export function queueOptionsFor(name: JobName): PgBoss.Queue {
  const { policy = 'standard', ...rest } = QUEUE_OPTIONS[name]
  return { name, policy, ...rest }
}
