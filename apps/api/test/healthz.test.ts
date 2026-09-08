import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDb } from '@aesa/db/raw'
import { createTestDatabase } from '@aesa/db/testing'
import { buildServer } from '../src/server.ts'

describe('GET /healthz', () => {
  let t: Awaited<ReturnType<typeof createTestDatabase>>
  let handle: ReturnType<typeof createDb>
  beforeAll(async () => { t = await createTestDatabase(); handle = createDb(t.url) })
  afterAll(async () => { await handle.pool.end(); await t.drop() })

  it('reports db ok and the applied migration count', async () => {
    const app = buildServer(handle)
    const res = await app.inject({ method: 'GET', url: '/healthz' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.status).toBe('ok')
    expect(body.db).toBe('ok')
    expect(body.migrations.count).toBeGreaterThanOrEqual(3)
    await app.close()
  })
})
