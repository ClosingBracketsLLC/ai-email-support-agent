import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildServer } from '../src/server.ts'
import { WEB, createTestApi, signInWithOtp, stubDeps } from './helpers/app.ts'

describe('Better Auth on Fastify', () => {
  let t: Awaited<ReturnType<typeof createTestApi>>
  beforeAll(async () => { t = await createTestApi() })
  afterAll(async () => { await t.close() })

  it('emails a 6-digit code, signs in with it, and the session survives a get-session round trip', async () => {
    const { cookie, user } = await signInWithOtp(t.app, t.mail, 'robert@example.com')
    expect(user.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(t.mail.latestTo('robert@example.com')?.subject).toMatch(/\d{6} is your aesa sign-in code/)
    const res = await t.app.inject({ method: 'GET', url: '/api/auth/get-session', headers: { cookie } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ user: { email: 'robert@example.com', name: 'Robert' }, session: { activeOrganizationId: null } })
  })

  it('stores the code hashed, never in clear', async () => {
    await t.app.inject({ method: 'POST', url: '/api/auth/email-otp/send-verification-otp', headers: { origin: WEB, 'content-type': 'application/json' }, payload: { email: 'hash@example.com', type: 'sign-in' } })
    const otp = t.mail.latestTo('hash@example.com')!.text.match(/\b(\d{6})\b/)![1]!
    const { rows } = await t.handle.pool.query<{ value: string }>(`SELECT value FROM verification WHERE identifier LIKE '%hash@example.com%'`)
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) expect(r.value).not.toContain(otp)
  })

  it('rejects a state-changing request from an untrusted origin', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/auth/email-otp/send-verification-otp', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, payload: { email: 'x@example.com', type: 'sign-in' } })
    expect(res.statusCode).toBe(403)
  })

  it('get-session without a cookie is null, and a forged cookie is null', async () => {
    const a = await t.app.inject({ method: 'GET', url: '/api/auth/get-session' })
    expect(a.statusCode).toBe(200); expect(a.json()).toBeNull()
    const b = await t.app.inject({ method: 'GET', url: '/api/auth/get-session', headers: { cookie: 'better-auth.session_token=nope' } })
    expect(b.json()).toBeNull()
  })

  it('answers CORS preflight only for the web origin, with credentials', async () => {
    const ok = await t.app.inject({ method: 'OPTIONS', url: '/api/auth/get-session', headers: { origin: WEB, 'access-control-request-method': 'GET' } })
    expect(ok.headers['access-control-allow-origin']).toBe(WEB)
    expect(ok.headers['access-control-allow-credentials']).toBe('true')
    const no = await t.app.inject({ method: 'OPTIONS', url: '/api/auth/get-session', headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' } })
    expect(no.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('exposes the latest devsink mail for the Playwright smoke and 404s otherwise', async () => {
    await t.mail.send({ to: 'pw@example.com', subject: 'hello', text: 'world' })
    const hit = await t.app.inject({ method: 'GET', url: '/__dev/mail/latest?to=pw@example.com' })
    expect(hit.json()).toEqual({ to: 'pw@example.com', subject: 'hello', text: 'world' })
    expect((await t.app.inject({ method: 'GET', url: '/__dev/mail/latest?to=none@example.com' })).statusCode).toBe(404)
  })
})

describe('/meta', () => {
  it('reports which social providers are configured', async () => {
    const off = buildServer(stubDeps())
    expect((await off.inject({ method: 'GET', url: '/meta' })).json()).toEqual({ providers: { google: false, microsoft: false } })
    await off.close()
    const on = buildServer(stubDeps({ GOOGLE_CLIENT_ID: 'g', GOOGLE_CLIENT_SECRET: 's' }))
    expect((await on.inject({ method: 'GET', url: '/meta' })).json()).toEqual({ providers: { google: true, microsoft: false } })
    await on.close()
  })
})
