import type PgBoss from 'pg-boss'
import { ZodError, type z } from 'zod'
import { JOB_SIGNAL_MARGIN_SECONDS } from '@aesa/core'
import { createQueueRetrying } from './pg-boss.ts'

export interface JobQueueOptions {
  /**
   * pg-boss 10 gates its singleton unique indexes on the queue's policy (plans.js: job_i1
   * `state='created' AND policy='short'`, job_i2 `state='active' AND policy='singleton'`, job_i3
   * `state<=active AND policy='stately'`), so on the DEFAULT `standard` a `singletonKey` is INERT —
   * `enqueue()` sets one on every send and it dedupes nothing (fix wave W8 / final-A1 M3, pinned by
   * `test/pg-boss-behaviour.test.ts`). Pick `'short'` on any queue whose producers may re-send the
   * same entity while an earlier job is still `created`: it collapses those, and stops collapsing
   * once the job goes active — so an event that arrived after the job started reading is never lost.
   */
  policy?: 'standard' | 'short' | 'singleton' | 'stately'
  retryLimit?: number
  retryDelay?: number
  retryBackoff?: boolean
  /** Required: it sizes the AbortSignal deadline (expire - 30 s). pg-boss does NOT cancel a running handler on expiry. */
  expireInSeconds: number
}

export interface JobContext<T> { data: T; signal: AbortSignal; job: PgBoss.JobWithMetadata<T> }

export interface JobDefinition<T extends { orgId: string }> {
  name: string
  schema: z.ZodType<T>
  queue: JobQueueOptions
  handler: (ctx: JobContext<T>) => Promise<void>
}

export function defineJob<T extends { orgId: string }>(def: JobDefinition<T>): JobDefinition<T> {
  const shape = (def.schema as unknown as { shape?: Record<string, unknown> }).shape
  if (!shape || !('orgId' in shape)) throw new Error(`job ${def.name}: payload schema must be a z.object with an orgId field`)
  if (def.queue.expireInSeconds <= JOB_SIGNAL_MARGIN_SECONDS) throw new Error(`job ${def.name}: expireInSeconds must exceed ${JOB_SIGNAL_MARGIN_SECONDS}`)
  return def
}

export interface RegisterJobOptions {
  /**
   * Jobs per worker invocation (default 1). NOTE: pg-boss completes or fails a batch as a unit — a throw
   * from any job (payload validation or the handler) fails every job in the batch, including siblings that
   * already ran. Use the default of 1 for handlers with side effects; raise it only for idempotent work.
   */
  batchSize?: number
  /** Defaults to pg-boss's polling interval; tests pass a small value to keep signal-deadline checks fast. */
  pollingIntervalSeconds?: number
}

/** Creates/updates the queue with the definition's options and registers a worker that validates, times and aborts. */
export async function registerJob<T extends { orgId: string }>(boss: PgBoss, def: JobDefinition<T>, opts: RegisterJobOptions = {}): Promise<void> {
  const { policy = 'standard', ...queueOpts } = def.queue
  await createQueueRetrying(boss, def.name, { name: def.name, policy, ...queueOpts })
  await boss.updateQueue(def.name, { name: def.name, policy, ...queueOpts })   // createQueue is a no-op on an existing queue
  const workOptions: PgBoss.WorkOptions & { includeMetadata: true } = { batchSize: opts.batchSize ?? 1, includeMetadata: true }
  if (opts.pollingIntervalSeconds !== undefined) workOptions.pollingIntervalSeconds = opts.pollingIntervalSeconds
  await boss.work<T>(def.name, workOptions, async (jobs) => {
    // pg-boss invokes this callback once per batch inside a single try/catch: a throw from any job here
    // (schema validation or the handler) fails every job in the batch, including siblings that already
    // completed. There is no per-job isolation without manual complete/fail bookkeeping — see batchSize doc.
    for (const job of jobs) {
      let data: T
      try {
        data = def.schema.parse(job.data)
      } catch (err) {
        if (!(err instanceof ZodError)) throw err
        // A schema-invalid payload can never succeed by retrying it. boss.fail() is NOT permanent here:
        // pg-boss's failJobs SQL re-inserts the row as 'retry' whenever retry_count < retry_limit, so a
        // freshly-sent job (retry_count 0) would just be retried — and fail identically — retryLimit times
        // before finally landing on 'failed'. deleteJob removes it outright, in one step, on first sight.
        console.error(`[queue] job ${def.name} ${job.id} dropped: schema-invalid payload`, err.issues.slice(0, 5))
        await boss.deleteJob(def.name, job.id)
        continue
      }
      const controller = new AbortController()
      const deadlineMs = (def.queue.expireInSeconds - JOB_SIGNAL_MARGIN_SECONDS) * 1000
      const timer = setTimeout(() => controller.abort(new Error(`job ${def.name} ${job.id} hit its deadline`)), deadlineMs)
      try {
        await def.handler({ data, signal: controller.signal, job: job as PgBoss.JobWithMetadata<T> })
      } finally {
        clearTimeout(timer)
      }
    }
  })
}
