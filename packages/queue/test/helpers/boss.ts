import pg from 'pg'
import PgBoss from 'pg-boss'
export const DB_URL = process.env.DATABASE_URL ?? 'postgres://aesa:aesa@localhost:5434/aesa_dev'
export async function startTestBoss(): Promise<PgBoss> {
  const boss = new PgBoss({ connectionString: DB_URL, schema: 'pgboss_test' })
  boss.on('error', (e) => console.error('[pg-boss test]', e))
  await boss.start()
  return boss
}
export const uniqueName = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

/** Test-only: removes every job row for a queue in the pgboss_test schema, whatever its state, so deleteQueue's FK check passes even after a failed assertion. */
export async function deleteAllJobs(queueName: string): Promise<void> {
  const c = new pg.Client({ connectionString: DB_URL })
  await c.connect()
  try { await c.query('DELETE FROM pgboss_test.job WHERE name = $1', [queueName]) } finally { await c.end() }
}

/** Test-only: reads back a queue's job rows straight from pgboss_test, bypassing pg-boss's fetch/complete bookkeeping. */
export async function queryJobs(queueName: string): Promise<{ state: string; retryCount: number }[]> {
  const c = new pg.Client({ connectionString: DB_URL })
  await c.connect()
  try {
    const { rows } = await c.query<{ state: string; retry_count: number }>('SELECT state, retry_count FROM pgboss_test.job WHERE name = $1', [queueName])
    return rows.map((r) => ({ state: r.state, retryCount: r.retry_count }))
  } finally {
    await c.end()
  }
}
