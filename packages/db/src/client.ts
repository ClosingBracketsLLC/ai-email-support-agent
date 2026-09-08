import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { fileURLToPath } from 'node:url'
import * as schema from './schema/index.ts'

export type Db = NodePgDatabase<typeof schema>

export interface CreateDbOptions {
  /**
   * 'app' (the default for api/worker): every connection STARTS as `aesa_app` (via libpq startup
   * options) plus the app-role timeouts, so even a raw handle is subject to forced RLS and sees no
   * tenant rows without `withOrg`. 'owner': the migration/test-admin role — starts as `aesa_owner`,
   * bypasses nothing by policy but is the table owner (RLS is FORCED, so it still sees nothing without
   * a policy match).
   */
  role?: 'owner' | 'app'
  pool?: Omit<pg.PoolConfig, 'connectionString'>
}

export function createDb(connectionString: string, opts: CreateDbOptions = {}): { db: Db; pool: pg.Pool } {
  // The connection user is the cluster admin (locally a superuser, which bypasses RLS). Every connection
  // STARTS in a non-superuser role via libpq startup options (`-c role=…` is applied by the server before
  // the first query — no client-side SET ROLE race, nothing for pg's deprecated query queuing to order):
  // 'app' → aesa_app (forced RLS + the app timeouts), 'owner' → aesa_owner (owns the tables; migrations
  // run as it; FORCE RLS applies to it too). The login user must be a member of both roles.
  const startupOptions =
    (opts.role ?? 'app') === 'app'
      ? '-c role=aesa_app -c idle_in_transaction_session_timeout=5s -c statement_timeout=30s'
      : '-c role=aesa_owner'
  const pool = new pg.Pool({ ...opts.pool, connectionString, options: startupOptions })
  return { db: drizzle(pool, { schema }), pool }
}

const migrationsFolder = fileURLToPath(new URL('../migrations', import.meta.url))

export async function runMigrations(connectionString: string): Promise<void> {
  const { db, pool } = createDb(connectionString, { role: 'owner' })
  try {
    await migrate(db, { migrationsFolder })
  } finally {
    await pool.end()
  }
}
