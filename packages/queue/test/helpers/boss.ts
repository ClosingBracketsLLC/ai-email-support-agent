import PgBoss from 'pg-boss'
export const DB_URL = process.env.DATABASE_URL ?? 'postgres://aesa:aesa@localhost:5434/aesa_dev'
export async function startTestBoss(): Promise<PgBoss> {
  const boss = new PgBoss({ connectionString: DB_URL, schema: 'pgboss_test' })
  boss.on('error', (e) => console.error('[pg-boss test]', e))
  await boss.start()
  return boss
}
export const uniqueName = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
