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
