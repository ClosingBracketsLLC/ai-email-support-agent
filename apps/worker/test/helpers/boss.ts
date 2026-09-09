import pg from 'pg'
import PgBoss from 'pg-boss'

export const DB_URL = process.env.DATABASE_URL ?? 'postgres://aesa:aesa@localhost:5434/aesa_dev'

export async function startTestBoss(): Promise<PgBoss> {
  const boss = new PgBoss({ connectionString: DB_URL, schema: 'pgboss_test' })
  boss.on('error', (e) => console.error('[pg-boss test]', e))
  await boss.start()
  return boss
}

/**
 * Test-only cleanup, SCOPED to this file's own org ids. `pgboss_test` is a real, shared schema on the
 * stable dev database (not a per-file throwaway database), and job queue NAMES here are the real
 * production names (`JOB_NAMES.*`) — a blanket `DELETE ... WHERE name = $1` would race a concurrently
 * running spec file's rows for the SAME queue (vitest runs test files in parallel by default). Every
 * job payload carries `orgId`, and every test creates its own randomized org, so filtering the delete
 * on THIS file's own org ids can never touch another file's rows.
 */
export async function deleteJobsForOrgs(queueName: string, orgIds: readonly string[]): Promise<void> {
  if (orgIds.length === 0) return
  const c = new pg.Client({ connectionString: DB_URL })
  await c.connect()
  try {
    await c.query(`DELETE FROM pgboss_test.job WHERE name = $1 AND data ->> 'orgId' = ANY($2)`, [queueName, orgIds])
  } finally {
    await c.end()
  }
}

/** Test-only: reads back a queue's job rows straight from pgboss_test, bypassing pg-boss's own fetch/complete bookkeeping. */
export async function queryJobs(queueName: string): Promise<{ id: string; data: unknown; startAfter: Date; state: string }[]> {
  const c = new pg.Client({ connectionString: DB_URL })
  await c.connect()
  try {
    const { rows } = await c.query<{ id: string; data: unknown; start_after: Date; state: string }>(
      'SELECT id, data, start_after, state FROM pgboss_test.job WHERE name = $1',
      [queueName],
    )
    return rows.map((r) => ({ id: r.id, data: r.data, startAfter: r.start_after, state: r.state }))
  } finally {
    await c.end()
  }
}
