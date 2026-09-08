import pg from 'pg'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { platformState } from '../src/index.ts'
import { createDb, runMigrations } from '../src/raw.ts'
import { createTestDatabase } from './helpers/test-db.ts'

const EXPECTED_TABLES = ['account', 'audit_log', 'invitation', 'member', 'notification_devices', 'org_data_keys', 'org_settings', 'organization', 'platform_state', 'session', 'usage_counters', 'user', 'verification', 'workspaces']

describe('migrations', () => {
  let t: Awaited<ReturnType<typeof createTestDatabase>>
  beforeAll(async () => { t = await createTestDatabase() })
  afterAll(async () => { await t.drop() })

  it('creates exactly the Phase 0 tables', async () => {
    const c = new pg.Client({ connectionString: t.url })
    await c.connect()
    const res = await c.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
       AND table_name NOT LIKE '\\_\\_drizzle%' ESCAPE '\\' ORDER BY table_name`,
    )
    await c.end()
    expect(res.rows.map((r) => r.table_name)).toEqual(EXPECTED_TABLES)
  })

  it('is idempotent', async () => {
    await expect(runMigrations(t.url)).resolves.not.toThrow()
  })

  // platform_state (not a tenant table) so this test keeps passing after Task 3 forces RLS on tenant tables.
  it('bumps updated_at through $onUpdate', async () => {
    const { db, pool } = createDb(t.url, { role: 'owner' })
    try {
      await db.insert(platformState).values({ key: 'onupdate-test', value: { n: 1 } })
      const [before] = await db.select().from(platformState).where(eq(platformState.key, 'onupdate-test'))
      await new Promise((r) => setTimeout(r, 20))
      await db.update(platformState).set({ value: { n: 2 } }).where(eq(platformState.key, 'onupdate-test'))
      const [after] = await db.select().from(platformState).where(eq(platformState.key, 'onupdate-test'))
      expect(after!.updatedAt.getTime()).toBeGreaterThan(before!.updatedAt.getTime())
    } finally {
      await pool.end()
    }
  })

  it('owner pool connections run as aesa_owner from the first query', async () => {
    const { pool } = createDb(t.url, { role: 'owner' })
    try {
      const res = await pool.query<{ current_user: string }>('SELECT current_user')
      expect(res.rows[0]!.current_user).toBe('aesa_owner')
    } finally {
      await pool.end()
    }
  })
})
