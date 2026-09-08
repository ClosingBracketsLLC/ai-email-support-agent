import type PgBoss from 'pg-boss'
import type { z } from 'zod'
import { createQueueRetrying } from './pg-boss.ts'

export const JOB_SIGNAL_MARGIN_SECONDS = 30

export interface JobQueueOptions {
  policy?: 'standard' | 'singleton' | 'stately'
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
    for (const job of jobs) {
      const data = def.schema.parse(job.data)                                    // invalid payload → job fails loudly
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
