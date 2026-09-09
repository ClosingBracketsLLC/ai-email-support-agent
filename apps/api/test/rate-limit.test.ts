import { describe, expect, it } from 'vitest'
import { createTestApi } from './helpers/app.ts'

// TEST_ENV sets API_RATE_LIMIT_PER_MINUTE=0 (disabled) for every other suite; this is the one test that turns
// the global limiter on, with a small enough max to trip it without waiting a minute (Phase 1 review, Important 2).
describe('global rate limit (@fastify/rate-limit, config.rateLimit)', () => {
  it('caps every route (not just /api/auth/*) per IP and reports retry-after on the 429', async () => {
    const t = await createTestApi({ API_RATE_LIMIT_PER_MINUTE: '2' })
    try {
      const hit = () => t.app.inject({ method: 'GET', url: '/healthz' })
      expect((await hit()).statusCode).toBe(200)
      expect((await hit()).statusCode).toBe(200)
      const third = await hit()
      expect(third.statusCode).toBe(429)
      expect(third.headers['retry-after']).toBeDefined()
      expect(third.json()).toMatchObject({ statusCode: 429, error: 'Too Many Requests' })
    } finally {
      await t.close()
    }
  })
})
