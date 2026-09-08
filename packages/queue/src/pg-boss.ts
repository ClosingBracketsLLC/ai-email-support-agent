// Ported from doge-buddy's apps/ops/src/queue.ts (createQueueRetrying, registerCron).
import PgBoss from 'pg-boss'

/**
 * `boss.createQueue` for a brand-new queue name runs DDL (creates the queue's partition table +
 * indexes) after an `INSERT ... ON CONFLICT DO NOTHING`. If two processes race to create the
 * *same never-before-seen* queue at the same time — multiple workers cold-booting against a
 * fresh database, or parallel test files each creating the same queue — Postgres can raise a
 * deadlock (40P01) or serialization failure (40001) on that DDL. Once the queue exists, every
 * future call is a fast no-op, so this only ever matters on first boot; retrying a few times with
 * a short backoff is safe and sufficient.
 */
export async function createQueueRetrying(boss: PgBoss, name: string, options?: PgBoss.Queue): Promise<void> {
  const RETRYABLE_CODES = new Set(['40P01', '40001'])
  const MAX_ATTEMPTS = 5
  for (let attempt = 1; ; attempt++) {
    try {
      await boss.createQueue(name, options)
      return
    } catch (err) {
      const code = (err as { code?: string }).code
      if (attempt >= MAX_ATTEMPTS || !code || !RETRYABLE_CODES.has(code)) {
        throw err
      }
      await new Promise((resolve) => setTimeout(resolve, 50 * attempt))
    }
  }
}

/**
 * Per-cron queue options (`registerCron`'s `opts` param). `retryLimit`/`expireInSeconds` let a
 * caller pin those away from pg-boss defaults (retryLimit 2, a 15-minute expiry) — extend as more
 * crons need more `PgBoss.Queue` fields. `policy` lets a caller pin the queue's dedup policy
 * explicitly; when omitted, `registerCron` reads and passes through whatever policy the queue
 * already has (see below) so opts can never *accidentally* change it — see `registerCron`'s own
 * doc comment for the full explicit-vs-preserved story. `singletonKey` is schedule-level, not
 * queue-level (pg-boss's `Queue` type has no such field), so it's carved out of the
 * `PgBoss.Queue`-shaped object built for `createQueue`/`updateQueue` below and instead threaded
 * through to the `boss.schedule(...)` call, which is how pg-boss actually enforces "at most one
 * pending/active job for this cron's key at a time" on a `policy: 'singleton'` queue.
 */
export interface CronJobOptions {
  retryLimit?: number
  expireInSeconds?: number
  policy?: 'standard' | 'singleton' | 'stately'
  singletonKey?: string
}

/**
 * Creates a queue (if needed), registers its worker, and schedules it on a cron. Used for
 * recurring jobs that aren't triggered by application events.
 *
 * `opts` (optional) pins queue-level settings — e.g. `retryLimit`/`expireInSeconds`/`policy` —
 * that diverge from pg-boss's defaults, plus the schedule-level `singletonKey`. Omitted `opts` is
 * today's behavior exactly: `createQueueRetrying` still creates the queue with no options, same
 * as every existing caller, and `boss.schedule(name, cron)` keeps its two-arg form. When `opts` is
 * given, `createQueueRetrying(boss, name, { name, ...queueOpts })` (where `queueOpts` is `opts`
 * minus `singletonKey`) covers the *first-ever* create, but `createQueue` is idempotent — if the
 * queue already exists (e.g. an earlier `registerCron` call created it first with defaults), that
 * create is a silent no-op and the options never apply. So follow up with
 * `boss.updateQueue(name, { name, ...queueOpts })`, which pg-boss always applies (update, not
 * create-if-missing) and makes the settings stick either way.
 *
 * That follow-up `updateQueue` call must pass `policy` explicitly. pg-boss's `updateQueue`
 * (`manager.js`) destructures `const { policy = 'standard' } = options` *before* building its SQL
 * params, so an omitted `policy` isn't passed through as `null` for the query's `COALESCE(...,
 * policy)` to preserve — it's resolved to the literal string `'standard'` in JS first. That means
 * calling `updateQueue` without `policy` silently downgrades any queue (e.g. one created elsewhere
 * with `policy: 'singleton'`) back to `'standard'`. When `opts.policy` is given explicitly, that
 * value wins outright — no need to consult the queue's current policy at all. Only when `opts`
 * omits `policy` does this read the queue's current policy via `getQueue` and pass it straight
 * through, defaulting to `'standard'` only for the brand-new-queue case where `getQueue` finds
 * nothing yet.
 *
 * Finally, when `opts.singletonKey` is set, `boss.schedule` is called with pg-boss's 4-arg form
 * (`name, cron, {}, { singletonKey }`) so every run of this cron dedupes against that key — e.g. a
 * minute-cadence poll job that must never have two runs pending/active at once. Without it,
 * `schedule` keeps the plain 2-arg form.
 */
export async function registerCron<ReqData extends object = object>(
  boss: PgBoss,
  name: string,
  cron: string,
  handler: PgBoss.WorkHandler<ReqData>,
  opts?: CronJobOptions,
): Promise<void> {
  const { singletonKey, ...queueOpts } = (opts ?? {}) as CronJobOptions
  await createQueueRetrying(boss, name, opts ? { name, ...queueOpts } : undefined)
  if (opts) {
    const policy = queueOpts.policy ?? (await boss.getQueue(name))?.policy ?? 'standard'
    await boss.updateQueue(name, { name, policy, ...queueOpts })
  }
  await boss.work(name, handler)
  if (singletonKey) {
    await boss.schedule(name, cron, {}, { singletonKey })
  } else {
    await boss.schedule(name, cron)
  }
}

export async function startBoss(connectionString: string, schema = 'pgboss'): Promise<PgBoss> {
  const boss = new PgBoss({ connectionString, schema })
  boss.on('error', (e) => console.error('[pg-boss]', e))
  await boss.start()
  return boss
}
