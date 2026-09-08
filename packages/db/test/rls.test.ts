import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestDatabase } from './helpers/test-db.ts'

const TENANT_TABLES = ['workspaces', 'org_settings', 'usage_counters', 'audit_log', 'org_data_keys']

describe('row-level security', () => {
  let t: Awaited<ReturnType<typeof createTestDatabase>>
  let c: pg.Client
  beforeAll(async () => {
    t = await createTestDatabase()
    c = new pg.Client({ connectionString: t.url })
    await c.connect()
  })
  afterAll(async () => { await c.end(); await t.drop() })

  it('creates both runtime roles', async () => {
    const res = await c.query(`SELECT rolname FROM pg_roles WHERE rolname IN ('aesa_app','aesa_platform') ORDER BY 1`)
    expect(res.rows.map((r) => r.rolname)).toEqual(['aesa_app', 'aesa_platform'])
  })

  it.each(TENANT_TABLES)('%s has RLS enabled AND forced', async (table) => {
    const res = await c.query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = $1`, [table])
    expect(res.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true })
  })

  it.each(TENANT_TABLES)('%s has an org-isolation policy for aesa_app and a platform policy for aesa_platform', async (table) => {
    const res = await c.query(
      `SELECT policyname, roles::text[] AS roles, qual FROM pg_policies WHERE tablename = $1 ORDER BY policyname`, [table],
    )
    const byName = Object.fromEntries(res.rows.map((r) => [r.policyname, r]))
    expect(byName[`${table}_org_isolation`].roles).toEqual(['aesa_app'])
    expect(byName[`${table}_org_isolation`].qual).toContain("NULLIF(current_setting('app.org_id'::text, true), ''::text))::uuid")
    expect(byName[`${table}_platform_all`].roles).toEqual(['aesa_platform'])
  })

  it('platform_state has no RLS, is readable by aesa_app and writable only by aesa_platform', async () => {
    const rls = await c.query(`SELECT relrowsecurity FROM pg_class WHERE relname = 'platform_state'`)
    expect(rls.rows[0]).toEqual({ relrowsecurity: false })
    const grants = await c.query(
      `SELECT grantee, privilege_type FROM information_schema.role_table_grants
       WHERE table_name = 'platform_state' AND grantee IN ('aesa_app','aesa_platform') ORDER BY 1, 2`,
    )
    const appPrivs = grants.rows.filter((r) => r.grantee === 'aesa_app').map((r) => r.privilege_type)
    const platformPrivs = grants.rows.filter((r) => r.grantee === 'aesa_platform').map((r) => r.privilege_type)
    expect(appPrivs).toEqual(['SELECT'])
    expect(platformPrivs).toEqual(expect.arrayContaining(['DELETE', 'INSERT', 'SELECT', 'UPDATE']))
  })

  it('migrates a SECOND database in the same cluster (CREATE ROLE is idempotent)', async () => {
    const second = await createTestDatabase()
    await second.drop()
  })
})
