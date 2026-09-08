import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AUTH_TABLES, notificationDevices, withOrg, workspaces } from '../src/index.ts'
import { createDb } from '../src/raw.ts'
import { createTestDatabase, createTestOrganization } from './helpers/test-db.ts'

describe('Better Auth tables and notification_devices', () => {
  let t: Awaited<ReturnType<typeof createTestDatabase>>
  let owner: pg.Client
  let app: ReturnType<typeof createDb>
  beforeAll(async () => {
    t = await createTestDatabase()
    owner = new pg.Client({ connectionString: t.url }); await owner.connect()
    app = createDb(t.url)
  })
  afterAll(async () => { await owner.end(); await app.pool.end(); await t.drop() })

  it('names the seven tables Better Auth 1.7 needs for email OTP + organization', () => {
    expect([...AUTH_TABLES].sort()).toEqual(['account', 'invitation', 'member', 'organization', 'session', 'user', 'verification'])
  })

  it('generates uuid ids in the database (generateId: false) and is writable by aesa_app', async () => {
    const { rows } = await app.pool.query<{ id: string }>(`INSERT INTO "user" (name, email) VALUES ('A', 'a@example.com') RETURNING id`)
    expect(rows[0]!.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it('has no row-level security on the auth tables (the api reaches them only through Better Auth)', async () => {
    const res = await owner.query(`SELECT relname FROM pg_class WHERE relname = ANY($1::text[]) AND relrowsecurity`, [[...AUTH_TABLES]])
    expect(res.rows).toEqual([])
  })

  it('id and organization columns are uuid, not text', async () => {
    const res = await owner.query<{ table_name: string; column_name: string; data_type: string }>(
      `SELECT table_name, column_name, data_type FROM information_schema.columns
       WHERE (table_name, column_name) IN (('user','id'),('session','user_id'),('session','active_organization_id'),('member','organization_id'),('invitation','inviter_id'))`)
    expect(res.rows).toHaveLength(5)
    expect(res.rows.every((r) => r.data_type === 'uuid')).toBe(true)
  })

  it('workspaces.org_id references organization.id', async () => {
    const orphan = crypto.randomUUID()
    await expect(withOrg(app.db, orphan, (tx) => tx.insert(workspaces).values({ orgId: orphan, businessName: 'x', timezone: 'UTC' })))
      .rejects.toMatchObject({ cause: { code: '23503' } })
    const orgId = await createTestOrganization(app)
    await withOrg(app.db, orgId, (tx) => tx.insert(workspaces).values({ orgId, businessName: 'x', timezone: 'UTC' }))
  })

  it('notification_devices is a forced-RLS tenant table keyed per (org, user, token)', async () => {
    const orgId = await createTestOrganization(app)
    const { rows } = await app.pool.query<{ id: string }>(`INSERT INTO "user" (name, email) VALUES ('B', 'b@example.com') RETURNING id`)
    const userId = rows[0]!.id
    const token = 'ExponentPushToken[abc]'
    await withOrg(app.db, orgId, (tx) => tx.insert(notificationDevices).values({ orgId, userId, expoPushToken: token, platform: 'ios' }))
    await expect(withOrg(app.db, orgId, (tx) => tx.insert(notificationDevices).values({ orgId, userId, expoPushToken: token, platform: 'ios' })))
      .rejects.toMatchObject({ cause: { code: '23505' } })
    await expect(withOrg(app.db, orgId, (tx) => tx.insert(notificationDevices).values({ orgId, userId, expoPushToken: 'ExponentPushToken[web]', platform: 'web' })))
      .rejects.toMatchObject({ cause: { code: '23514' } })
    expect(await app.db.select().from(notificationDevices)).toHaveLength(0)   // raw app handle: RLS hides the row
  })
})
