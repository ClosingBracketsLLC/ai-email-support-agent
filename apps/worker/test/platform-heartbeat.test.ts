import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { platformState } from '@aesa/db'
import { createDb } from '@aesa/db/raw'
import { createTestDatabase } from '@aesa/db/testing'
import { runHeartbeat } from '../src/jobs/platform-heartbeat.ts'

describe('platform.heartbeat', () => {
  let t: Awaited<ReturnType<typeof createTestDatabase>>
  let h: ReturnType<typeof createDb>
  beforeAll(async () => { t = await createTestDatabase(); h = createDb(t.url) })
  afterAll(async () => { await h.pool.end(); await t.drop() })

  it('upserts worker.last_heartbeat_at through withPlatform and the app role can read it', async () => {
    await runHeartbeat(h.db, () => new Date('2026-09-07T12:00:00Z'))
    await runHeartbeat(h.db, () => new Date('2026-09-07T12:01:00Z'))
    const [row] = await h.db.select().from(platformState).where(eq(platformState.key, 'worker.last_heartbeat_at'))
    expect(row?.value).toBe('2026-09-07T12:01:00.000Z')
  })
})
