import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AUTH_TABLES, ORG_ID_PREDICATE_SQL } from '../src/index.ts'
import { createTestDatabase } from './helpers/test-db.ts'

/** Tables that legitimately carry no org_id. Every other ordinary table in `public` must be tenant-scoped. */
const RLS_EXEMPT = ['platform_state', 'webhook_events', ...AUTH_TABLES]   // Better Auth tables are not tenant data (ruling, STATUS.md)

/** pg renders a policy expression with its own casts and parentheses; compare the shape, not the formatting. */
const normalize = (predicate: string) => predicate.toLowerCase().replaceAll('::text', '').replace(/[()\s]/g, '')

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

  // The invariant, not a list: a Phase 1-7 table that forgets tenantPolicies() or its FORCE line fails here.
  it('every ordinary public table outside RLS_EXEMPT has forced RLS and exactly the two tenant policies', async () => {
    const expected = normalize(ORG_ID_PREDICATE_SQL)
    const tables = await c.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT (c.relname = ANY($1::text[])) ORDER BY 1`,
      [RLS_EXEMPT],
    )
    // A superset check, so a new tenant table extends the loop instead of failing this line.
    expect(tables.rows.map((t) => t.relname))
      .toEqual(expect.arrayContaining([
        'audit_log', 'notification_devices', 'org_data_keys', 'org_settings', 'usage_counters', 'workspaces',
        'oauth_flows', 'mailbox_connections', 'mailbox_credentials', 'gmail_access_requests',
        'agents', 'categories', 'agent_category_policies', 'tickets', 'messages', 'notifications',
      ]))

    for (const t of tables.rows) {
      expect({ table: t.relname, rls: t.relrowsecurity, forced: t.relforcerowsecurity })
        .toEqual({ table: t.relname, rls: true, forced: true })
      const policies = await c.query<{ policyname: string; roles: string[]; qual: string; with_check: string }>(
        `SELECT policyname, roles::text[] AS roles, qual, with_check FROM pg_policies
         WHERE schemaname = 'public' AND tablename = $1 ORDER BY policyname`, [t.relname],
      )
      expect(policies.rows.map((p) => p.policyname)).toEqual([`${t.relname}_org_isolation`, `${t.relname}_platform_all`])
      const [isolation, platform] = policies.rows as [typeof policies.rows[number], typeof policies.rows[number]]
      expect({ table: t.relname, roles: isolation.roles, qual: normalize(isolation.qual), withCheck: normalize(isolation.with_check) })
        .toEqual({ table: t.relname, roles: ['aesa_app'], qual: expected, withCheck: expected })
      expect({ table: t.relname, roles: platform.roles, qual: platform.qual, withCheck: platform.with_check })
        .toEqual({ table: t.relname, roles: ['aesa_platform'], qual: 'true', withCheck: 'true' })
    }
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

  it('aesa_owner does not inherit the runtime roles (membership is for SET ROLE only)', async () => {
    const res = await c.query(
      `SELECT r.rolname, m.inherit_option FROM pg_auth_members m
       JOIN pg_roles r ON r.oid = m.roleid JOIN pg_roles o ON o.oid = m.member
       WHERE o.rolname = 'aesa_owner' AND r.rolname IN ('aesa_app','aesa_platform') ORDER BY 1`,
    )
    expect(res.rows).toEqual([
      { rolname: 'aesa_app', inherit_option: false },
      { rolname: 'aesa_platform', inherit_option: false },
    ])
  })
})
