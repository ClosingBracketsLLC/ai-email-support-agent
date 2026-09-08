import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fairSelectSql } from '../src/fair-select.ts'
import { DB_URL } from './helpers/boss.ts'

describe('fairSelectSql', () => {
  const c = new pg.Client({ connectionString: DB_URL })
  beforeAll(async () => {
    await c.connect()
    await c.query(`CREATE TEMP TABLE fair_t (org_id uuid, n int)`)
    const a = crypto.randomUUID(), b = crypto.randomUUID(), d = crypto.randomUUID()
    const rows = [[a, 1], [a, 2], [a, 3], [a, 4], [a, 5], [b, 1], [d, 1]]
    for (const [o, n] of rows) await c.query(`INSERT INTO fair_t VALUES ($1, $2)`, [o, n])
  })
  afterAll(async () => { await c.end() })

  it('round-robins across organizations before taking a second row from any', async () => {
    const { text, values } = fairSelectSql({ from: 'fair_t', where: 'n > 0', orderBy: 'n ASC', limit: 4 })
    const res = await c.query(text, values)
    const orgs = res.rows.map((r) => r.org_id)
    expect(new Set(orgs.slice(0, 3)).size).toBe(3)      // one row from each of the three orgs first
    expect(res.rows).toHaveLength(4)
  })
})
