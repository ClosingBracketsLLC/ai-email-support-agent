import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { runMigrations } from './raw.ts'

export const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://aesa:aesa@localhost:5434/aesa_dev'

/** Swaps the database name, keeping credentials, port and any query string (a regex on the path drops `?sslmode=`). */
export function testDatabaseUrl(adminUrl: string, name: string): string {
  const url = new URL(adminUrl)
  url.pathname = `/${name}`
  return url.toString()
}

/** Creates a fresh database in the local cluster, migrates it, and returns its URL + a drop() hook. */
export async function createTestDatabase(): Promise<{ url: string; drop: () => Promise<void> }> {
  const name = `aesa_test_${Date.now()}_${randomBytes(3).toString('hex')}`
  const admin = new pg.Client({ connectionString: ADMIN_URL })
  await admin.connect()
  await admin.query(`CREATE DATABASE ${name} OWNER aesa_owner`)
  await admin.end()
  const url = testDatabaseUrl(ADMIN_URL, name)
  // pgvector's control file is not `trusted`, so only a superuser can install it (0012_pgvector.sql
  // runs as the non-superuser aesa_owner and depends on it already being present). ADMIN_URL is the
  // cluster superuser: install it here, directly in the fresh database, so every throwaway test
  // database is self-sufficient and does not depend on `template1` having been seeded by
  // scripts/db-init/001-roles.sql (which still seeds `template1` for `aesa_dev` itself).
  const superuser = new pg.Client({ connectionString: url })
  await superuser.connect()
  await superuser.query('CREATE EXTENSION IF NOT EXISTS vector')
  await superuser.end()
  await runMigrations(url)
  return {
    url,
    drop: async () => {
      const c = new pg.Client({ connectionString: ADMIN_URL })
      await c.connect()
      await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
      await c.end()
    },
  }
}

/** Tests only: inserts a Better Auth organization row so tenant rows can satisfy workspaces.org_id → organization.id. */
export async function createTestOrganization(handle: { pool: pg.Pool }, name = 'Test Org'): Promise<string> {
  const { rows } = await handle.pool.query<{ id: string }>(
    `INSERT INTO organization (name, slug) VALUES ($1, $2) RETURNING id`, [name, `t-${randomBytes(4).toString('hex')}`])
  return rows[0]!.id
}
