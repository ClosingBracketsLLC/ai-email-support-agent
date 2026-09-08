import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { fileURLToPath } from 'node:url'
import * as schema from './schema/index.ts'

export type Db = NodePgDatabase<typeof schema>

export interface CreateDbOptions {
  /**
   * 'app' (the default for api/worker): every checked-out connection runs `SET ROLE aesa_app` plus the
   * app-role timeouts, so even a raw handle is subject to forced RLS and sees no tenant rows without
   * `withOrg`. 'owner': the migration/test-admin role — no SET ROLE, bypasses nothing by policy but
   * is the table owner (RLS is FORCED, so it still sees nothing without a policy match).
   */
  role?: 'owner' | 'app'
  pool?: Omit<pg.PoolConfig, 'connectionString'>
}

export function createDb(connectionString: string, opts: CreateDbOptions = {}): { db: Db; pool: pg.Pool } {
  const pool = new pg.Pool({ ...opts.pool, connectionString })
  // The connection user is the cluster admin (locally a superuser, which bypasses RLS). Every checked-out
  // connection switches to a NON-superuser role first: 'app' → aesa_app (forced RLS + timeouts),
  // 'owner' → aesa_owner (owns the tables; migrations run as it; FORCE RLS applies to it too).
  // pg queues this statement on the client before the caller's first query, so ordering is guaranteed.
  const roleStatement =
    (opts.role ?? 'app') === 'app'
      ? "SET ROLE aesa_app; SET idle_in_transaction_session_timeout = '5s'; SET statement_timeout = '30s'"
      : 'SET ROLE aesa_owner'
  pool.on('connect', (client) => {
    client.query(roleStatement).catch((err) => {
      console.error('[db] failed to set connection role', err)
      client.release(err)
    })
  })
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
