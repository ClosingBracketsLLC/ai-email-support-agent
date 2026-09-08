import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { orgSettings, workspaces, type OrgTx } from '../src/index.ts'
import { createDb } from '../src/raw.ts'
import { withOrg, withPlatform } from '../src/tenant.ts'
import { createTestDatabase } from './helpers/test-db.ts'

const acceptOrgTx = (_tx: OrgTx) => { void _tx }

describe('tenant isolation', () => {
  let t: Awaited<ReturnType<typeof createTestDatabase>>
  let app: ReturnType<typeof createDb>
  let owner: ReturnType<typeof createDb>
  const orgA = crypto.randomUUID()
  const orgB = crypto.randomUUID()

  beforeAll(async () => {
    t = await createTestDatabase()
    app = createDb(t.url, { role: 'app', pool: { max: 1 } })   // max 1 forces connection reuse (GUC-leak test)
    owner = createDb(t.url, { role: 'owner' })
    for (const [orgId, name] of [[orgA, 'A'], [orgB, 'B']] as const) {
      await withOrg(app.db, orgId, async (tx) => {
        await tx.insert(workspaces).values({ orgId, businessName: name, timezone: 'UTC' })
        await tx.insert(orgSettings).values({ orgId, key: 'k', value: name })
      })
    }
  })
  afterAll(async () => { await app.pool.end(); await owner.pool.end(); await t.drop() })

  it('a raw app handle (no withOrg) sees zero tenant rows', async () => {
    expect(await app.db.select().from(workspaces)).toHaveLength(0)
  })

  it('app pool connections run as aesa_app from the first query', async () => {
    const res = await app.pool.query<{ current_user: string }>('SELECT current_user')
    expect(res.rows[0]!.current_user).toBe('aesa_app')
  })

  it('withOrg sees only its own organization', async () => {
    const a = await withOrg(app.db, orgA, (tx) => tx.select().from(workspaces))
    const b = await withOrg(app.db, orgB, (tx) => tx.select().from(orgSettings))
    expect(a.map((r) => r.businessName)).toEqual(['A'])
    expect(b.map((r) => r.value)).toEqual(['B'])
  })

  it('withOrg cannot write a row for another organization (WITH CHECK)', async () => {
    // drizzle wraps the raw driver error (Postgres 42501 "new row violates row-level security policy
    // for table ...") in a DrizzleQueryError whose own .message is "Failed query: insert into …"; the
    // underlying Postgres error is on .cause.
    await expect(
      withOrg(app.db, orgA, (tx) => tx.insert(orgSettings).values({ orgId: orgB, key: 'x', value: 1 })),
    ).rejects.toMatchObject({ cause: { code: '42501', message: expect.stringMatching(/row-level security/) } })
  })

  it('withOrg cannot update or delete another organization even by primary key', async () => {
    const updated = await withOrg(app.db, orgA, (tx) =>
      tx.update(workspaces).set({ businessName: 'pwned' }).where(eq(workspaces.orgId, orgB)).returning(),
    )
    expect(updated).toHaveLength(0)
    const deleted = await withOrg(app.db, orgA, (tx) => tx.delete(orgSettings).where(eq(orgSettings.orgId, orgB)).returning())
    expect(deleted).toHaveLength(0)
  })

  it('a pooled connection does not leak app.org_id into the next raw query', async () => {
    await withOrg(app.db, orgA, (tx) => tx.select().from(workspaces))
    // same physical connection (pool max 1); the earlier SET LOCAL left app.org_id = '' at session level
    expect(await app.db.select().from(workspaces)).toHaveLength(0)
  })

  it('the table owner sees nothing without a policy match (FORCE ROW LEVEL SECURITY)', async () => {
    expect(await owner.db.select().from(workspaces)).toHaveLength(0)
  })

  it('withPlatform sees every organization', async () => {
    const rows = await withPlatform(app.db, 'test:list-all', (tx) => tx.select().from(workspaces))
    expect(rows.map((r) => r.businessName).sort()).toEqual(['A', 'B'])
  })

  it('withOrg rejects a non-uuid org id before touching the database', async () => {
    await expect(withOrg(app.db, 'not-a-uuid', async () => 1)).rejects.toThrow(/uuid/i)
  })

  it('a plain Db is not assignable to OrgTx (compile-time brand check)', () => {
    // @ts-expect-error a raw Db is not an OrgTx
    acceptOrgTx(app.db)
  })
})
