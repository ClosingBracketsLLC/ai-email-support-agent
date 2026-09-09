import { describe, expect, it } from 'vitest'
import { createTestApi, WEB } from './helpers/app.ts'

// The /trpc CSRF guard (server.ts's onRequest hook) had zero test coverage (Phase 1 review, Important 4);
// Important 6 then made it (and CORS) accept every config.webOrigins entry, not only appWebOrigin.
const EVIL = 'https://evil.example'
const SECOND = 'https://staging.example.com'
const THIRD = 'https://another.example.com'

describe('/trpc CSRF origin guard', () => {
  it('blocks a POST from an untrusted origin; a missing Origin or the web origin pass', async () => {
    const t = await createTestApi()
    try {
      const evil = await t.app.inject({ method: 'POST', url: '/trpc/workspace.get', headers: { origin: EVIL, 'content-type': 'application/json' }, payload: {} })
      expect(evil.statusCode).toBe(403)
      expect(evil.json()).toEqual({ statusCode: 403, error: 'Forbidden' })

      const noOrigin = await t.app.inject({ method: 'POST', url: '/trpc/workspace.get', headers: { 'content-type': 'application/json' }, payload: {} })
      expect(noOrigin.statusCode).not.toBe(403)

      const web = await t.app.inject({ method: 'POST', url: '/trpc/workspace.get', headers: { origin: WEB, 'content-type': 'application/json' }, payload: {} })
      expect(web.statusCode).not.toBe(403)
    } finally {
      await t.close()
    }
  })

  it('a documented extra web origin (AUTH_TRUSTED_ORIGINS) passes CORS preflight and the /trpc guard; an undocumented one does not', async () => {
    const t = await createTestApi({ AUTH_TRUSTED_ORIGINS: SECOND })
    try {
      const preflightOk = await t.app.inject({ method: 'OPTIONS', url: '/trpc/workspace.get', headers: { origin: SECOND, 'access-control-request-method': 'POST' } })
      expect(preflightOk.headers['access-control-allow-origin']).toBe(SECOND)
      const postOk = await t.app.inject({ method: 'POST', url: '/trpc/workspace.get', headers: { origin: SECOND, 'content-type': 'application/json' }, payload: {} })
      expect(postOk.statusCode).not.toBe(403)

      const preflightBad = await t.app.inject({ method: 'OPTIONS', url: '/trpc/workspace.get', headers: { origin: THIRD, 'access-control-request-method': 'POST' } })
      expect(preflightBad.headers['access-control-allow-origin']).toBeUndefined()
      const postBad = await t.app.inject({ method: 'POST', url: '/trpc/workspace.get', headers: { origin: THIRD, 'content-type': 'application/json' }, payload: {} })
      expect(postBad.statusCode).toBe(403)
    } finally {
      await t.close()
    }
  })
})
