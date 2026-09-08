import type PgBoss from 'pg-boss'
import { platformState, withPlatform, type Db } from '@aesa/db'
import { registerCron } from '@aesa/queue'

export const HEARTBEAT_KEY = 'worker.last_heartbeat_at'

/** Proves the cron rails end to end: a platform-role write every minute that /healthz and alerts can read. */
export async function runHeartbeat(db: Db, now: () => Date = () => new Date()): Promise<void> {
  await withPlatform(db, 'cron:platform.heartbeat', async (tx) => {
    await tx.insert(platformState).values({ key: HEARTBEAT_KEY, value: now().toISOString() })
      .onConflictDoUpdate({ target: platformState.key, set: { value: now().toISOString() } })
  })
}

export async function registerPlatformHeartbeat(boss: PgBoss, db: Db): Promise<void> {
  await registerCron(boss, 'platform.heartbeat', '* * * * *', async () => { await runHeartbeat(db) },
    { policy: 'singleton', singletonKey: 'platform.heartbeat', retryLimit: 0, expireInSeconds: 50 })
}
