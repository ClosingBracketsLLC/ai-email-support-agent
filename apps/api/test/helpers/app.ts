import type { AddressInfo } from 'node:net'
import type { FastifyInstance } from 'fastify'
import { audit } from '@aesa/db'
import { createDb } from '@aesa/db/raw'
import { createTestDatabase } from '@aesa/db/testing'
import { expect } from 'vitest'
import { createAuth } from '../../src/auth.ts'
import { loadConfig } from '../../src/config.ts'
import { createApiFacade, type ServerDeps } from '../../src/deps.ts'
import { createDevSink, type DevSink } from '../../src/mail/transport.ts'
import { buildServer } from '../../src/server.ts'

export const WEB = 'http://localhost:8081'
export const TEST_ENV = {
  DATABASE_URL: 'postgres://unused', APP_BASE_URL: 'http://localhost:3001', APP_WEB_ORIGIN: WEB,
  BETTER_AUTH_SECRET: 'test-secret-'.repeat(4), AUTH_RATE_LIMIT: 'off',
} as const

/** A complete api over a throwaway database; `close()` drops it. */
export async function createTestApi(overrides: Partial<NodeJS.ProcessEnv> = {}) {
  const t = await createTestDatabase()
  const config = loadConfig({ ...TEST_ENV, ...overrides, DATABASE_URL: t.url })
  const handle = createDb(t.url, { role: 'app' })
  const api = createApiFacade(handle)
  const mail = createDevSink()
  const auth = createAuth({ db: handle.db, config, mail, audit: (orgId, entry) => api.withOrg(orgId, (tx) => audit(tx, entry)) })
  const lines: string[] = []
  const app = buildServer({ config, auth, api, mail, logLevel: 'warn', logStream: { write: (line: string) => void lines.push(line) } })
  return { app, config, mail, api, handle, lines, close: async () => { await app.close(); await handle.pool.end(); await t.drop() } }
}

/** Deps for suites that never touch the database (error handler, redaction, /meta). */
export function stubDeps(env: Partial<NodeJS.ProcessEnv> = {}): ServerDeps {
  const config = loadConfig({ ...TEST_ENV, ...env })
  const auth = { handler: async () => new Response(null, { status: 404 }), api: {} } as unknown as ServerDeps['auth']
  const api: ServerDeps['api'] = {
    withOrg: async () => { throw new Error('no database in stubDeps') },
    withPlatform: async () => { throw new Error('no database in stubDeps') },
    health: async () => ({ db: 'error', migrations: { count: 0, latest: null } }),
  }
  return { config, auth, api, mail: createDevSink() }
}

/** Email OTP sign-in through the real routes. Returns the session cookie (name=value) and the user. */
export async function signInWithOtp(app: FastifyInstance, mail: DevSink, email: string, name = 'Robert') {
  const headers = { origin: WEB, 'content-type': 'application/json' }
  const sent = await app.inject({ method: 'POST', url: '/api/auth/email-otp/send-verification-otp', headers, payload: { email, type: 'sign-in' } })
  expect(sent.statusCode).toBe(200)
  const otp = mail.latestTo(email)?.text.match(/\b(\d{6})\b/)?.[1]
  expect(otp).toBeDefined()
  const res = await app.inject({ method: 'POST', url: '/api/auth/sign-in/email-otp', headers, payload: { email, otp, name } })
  expect(res.statusCode).toBe(200)
  const raw = res.headers['set-cookie']
  const first = (Array.isArray(raw) ? raw : [raw]).find((c) => c?.includes('session_token'))
  expect(first).toBeDefined()
  return { cookie: first!.split(';')[0]!, user: res.json().user as { id: string; email: string; name: string } }
}

/** Binds to a random port for suites that need real HTTP (the tRPC client). */
export async function listen(app: FastifyInstance): Promise<string> {
  await app.listen({ port: 0, host: '127.0.0.1' })
  return `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
}
