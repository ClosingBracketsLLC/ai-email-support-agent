import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { billingSubscriptions, platformState, withOrg, withPlatform, workspaces } from '../src/index.ts'
import { createDb, runMigrations } from '../src/raw.ts'
import { EXPECTED_TABLES, RLS_EXEMPT } from './helpers/tables.ts'
import { createTestDatabase, createTestOrganization } from './helpers/test-db.ts'

const migrationsDir = fileURLToPath(new URL('../migrations', import.meta.url))
const migrationFiles = (): string[] => readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()

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

  // ---- Phase 7 fix wave, ruling R33: migration 0023's backfill was a silent no-op ----------------

  /**
   * The bug class: migrations run as `aesa_owner`, every tenant table is FORCE RLS with no policy for
   * that role, so a data statement that reads a tenant table (`INSERT … SELECT FROM "workspaces"`)
   * sees nothing and writes nothing — and drizzle reports success. 0025 re-runs 0023's backfill under
   * `SET ROLE aesa_platform`; this drives the file's own SQL through an OWNER connection, exactly as
   * the migrator would, against a workspace whose billing row is missing.
   */
  it('0025 re-runs the billing backfill under the platform role: a workspace with agent_enabled_at and no billing row lands on a trial clock 14 days out', async () => {
    const app = createDb(t.url)
    const owner = createDb(t.url, { role: 'owner' })
    try {
      const orgId = await createTestOrganization(app, 'Backfill')
      const enabledAt = new Date('2026-08-01T09:30:00Z')
      await withOrg(app.db, orgId, (tx) => tx.insert(workspaces).values({
        orgId, businessName: 'Backfill', timezone: 'UTC', agentEnabled: true, agentEnabledAt: enabledAt,
      }))
      // What every pre-Phase-7 workspace looks like after 0023 ran: a workspace and NO billing row.
      await withPlatform(app.db, 'test:drop-billing-row', (tx) =>
        tx.delete(billingSubscriptions).where(eq(billingSubscriptions.orgId, orgId)))

      const file = readFileSync(`${migrationsDir}/0025_billing_backfill.sql`, 'utf8')
      const statements = file.split('--> statement-breakpoint').map((s) => s.trim()).filter((s) => s.length > 0)
      const c = await owner.pool.connect()
      try {
        await c.query('BEGIN')
        for (const statement of statements) await c.query(statement)
        await c.query('COMMIT')
        // The pair hands the connection back to the owner for whatever the batch runs next.
        expect((await c.query<{ current_user: string }>('SELECT current_user')).rows[0]!.current_user).toBe('aesa_owner')
      } finally {
        c.release()
      }

      const [row] = await withOrg(app.db, orgId, (tx) => tx.select().from(billingSubscriptions))
      expect(row).toMatchObject({ orgId, plan: 'trial', status: 'trialing' })
      expect(row!.trialEndsAt).toEqual(new Date(enabledAt.getTime() + 14 * 86_400_000))
    } finally {
      await app.pool.end()
      await owner.pool.end()
    }
  })

  it('0025 repairs a row ensureBillingRow minted with a NULL clock, keeps a clock that is set, and leaves a row past trialing alone', async () => {
    const app = createDb(t.url)
    const owner = createDb(t.url, { role: 'owner' })
    try {
      const enabledAt = new Date('2026-08-01T09:30:00Z')
      const stamped = new Date('2026-08-20T00:00:00Z')
      const mk = async (name: string, row: Partial<typeof billingSubscriptions.$inferInsert>) => {
        const orgId = await createTestOrganization(app, name)
        await withOrg(app.db, orgId, async (tx) => {
          await tx.insert(workspaces).values({ orgId, businessName: name, timezone: 'UTC', agentEnabled: true, agentEnabledAt: enabledAt })
          await tx.insert(billingSubscriptions).values({ orgId, ...row })
        })
        return orgId
      }
      const nullClock = await mk('null clock', {})
      const setClock = await mk('set clock', { trialEndsAt: stamped })
      const paid = await mk('paid', { plan: 'standard', status: 'active' })

      const file = readFileSync(`${migrationsDir}/0025_billing_backfill.sql`, 'utf8')
      const c = await owner.pool.connect()
      try {
        for (const statement of file.split('--> statement-breakpoint').map((s) => s.trim()).filter(Boolean)) await c.query(statement)
      } finally {
        c.release()
      }

      const clockOf = async (orgId: string) =>
        (await withOrg(app.db, orgId, (tx) => tx.select().from(billingSubscriptions)))[0]!
      expect((await clockOf(nullClock)).trialEndsAt).toEqual(new Date(enabledAt.getTime() + 14 * 86_400_000))
      expect((await clockOf(setClock)).trialEndsAt).toEqual(stamped)
      expect(await clockOf(paid)).toMatchObject({ plan: 'standard', status: 'active', trialEndsAt: null })
    } finally {
      await app.pool.end()
      await owner.pool.end()
    }
  })

  /**
   * THE GUARD, so the class cannot recur: a migration statement that writes DATA into a tenant table
   * (anything outside `RLS_EXEMPT`) runs as `aesa_owner` and, under FORCE RLS, reads and writes
   * nothing — silently. Such a file must switch to the platform role around it (`SET ROLE
   * aesa_platform` … `RESET ROLE`). DDL (`CREATE`, `ALTER`, `GRANT`, …) is unaffected and not checked.
   *
   * 0023 is the known offender this rule was written from: its backfill is the no-op 0025 re-runs,
   * and a migration that has already been applied is never edited.
   */
  it('every migration that INSERTs, UPDATEs or DELETEs against a tenant table does so under SET ROLE aesa_platform', () => {
    const KNOWN_NO_OP = new Set(['0023_billing_hardening.sql'])
    const offenders: string[] = []
    for (const name of migrationFiles()) {
      const file = readFileSync(`${migrationsDir}/${name}`, 'utf8')
      const statements = file
        .split('--> statement-breakpoint')
        .map((s) => s.replace(/^\s*--.*$/gm, '').trim())
        .filter((s) => s.length > 0)
      const tenantWrites = statements.flatMap((s) => {
        const m = /^(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"?([A-Za-z_]+)"?/i.exec(s)
        return m && !RLS_EXEMPT.includes(m[1]!) ? [m[1]!] : []
      })
      if (tenantWrites.length === 0) continue
      const hasSetRole = statements.some((s) => /^SET\s+ROLE\s+aesa_platform\s*;?$/i.test(s))
      const hasReset = statements.some((s) => /^RESET\s+ROLE\s*;?$/i.test(s))
      if (!(hasSetRole && hasReset)) offenders.push(`${name} (${tenantWrites.join(', ')})`)
    }
    expect(offenders.filter((o) => !KNOWN_NO_OP.has(o.split(' ')[0]!))).toEqual([])
    // And the known offender really is one — if 0023 is ever rewritten, drop it from the set.
    expect(offenders.map((o) => o.split(' ')[0])).toContain('0023_billing_hardening.sql')
  })
})
