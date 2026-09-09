import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestApi } from './helpers/app.ts'

describe('GET /healthz', () => {
  let t: Awaited<ReturnType<typeof createTestApi>>
  beforeAll(async () => { t = await createTestApi() })
  afterAll(async () => { await t.close() })

  it('reports db ok and the applied migration count through the facade', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/healthz' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ status: 'ok', db: 'ok' })
    expect(res.json().migrations.count).toBeGreaterThanOrEqual(5)
  })
})
