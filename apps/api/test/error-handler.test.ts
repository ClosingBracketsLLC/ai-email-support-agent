import { DrizzleQueryError } from 'drizzle-orm/errors'
import type pg from 'pg'
import type { Db } from '@aesa/db'
import { describe, expect, it } from 'vitest'
import { buildServer } from '../src/server.ts'

const SECRET = 'tok_SUPER_SECRET_SESSION_TOKEN'
const QUERY = 'insert into "session" ("token") values ($1)'

/** The error paths never touch the database, so the handles stay unused stubs. */
function buildCapturingServer() {
  const lines: string[] = []
  const app = buildServer({
    db: {} as Db,
    pool: {} as pg.Pool,
    logLevel: 'trace',
    logStream: { write: (line: string) => void lines.push(line) },
  })
  return { app, lines, log: () => lines.join('') }
}

describe('error handler', () => {
  it('returns a bare 500 and logs no SQL or bound parameters for a DrizzleQueryError', async () => {
    const { app, lines, log } = buildCapturingServer()
    app.get('/boom', async () => { throw new DrizzleQueryError(QUERY, [SECRET], new Error('duplicate key')) })
    const res = await app.inject({ method: 'GET', url: '/boom' })
    await app.close()

    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ statusCode: 500, error: 'Internal Server Error' })
    expect(lines.length).toBeGreaterThan(0)
    expect(log()).not.toContain(SECRET)
    expect(log()).not.toContain('insert into')
    expect(log()).toContain('Failed query: [redacted]')
    expect(log()).toContain('"type":"DrizzleQueryError"')
  })

  it('redacts URLs found in an error message and never echoes the message in the body', async () => {
    const { app, log } = buildCapturingServer()
    app.get('/cb', async () => { throw new Error('see https://x.test/cb?code=abc123') })
    const res = await app.inject({ method: 'GET', url: '/cb' })
    await app.close()

    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ statusCode: 500, error: 'Internal Server Error' })
    expect(res.body).not.toContain('x.test')
    expect(log()).toContain('https://x.test/cb?code=[redacted]')
    expect(log()).not.toContain('abc123')
  })

  it('keeps the 4xx shape but does not echo a non-Fastify error message', async () => {
    const { app } = buildCapturingServer()
    app.get('/bad', async () => { throw Object.assign(new Error(`rejected ${SECRET}`), { statusCode: 400 }) })
    const res = await app.inject({ method: 'GET', url: '/bad' })
    await app.close()

    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ statusCode: 400, error: 'Bad Request', message: 'Bad Request' })
    expect(res.body).not.toContain(SECRET)
  })

  it("keeps Fastify's own validation message", async () => {
    const { app } = buildCapturingServer()
    app.get('/q', { schema: { querystring: { type: 'object', required: ['q'], properties: { q: { type: 'string' } } } } }, async () => 'ok')
    const res = await app.inject({ method: 'GET', url: '/q' })
    await app.close()

    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ statusCode: 400, code: 'FST_ERR_VALIDATION', error: 'Bad Request', message: expect.stringContaining("must have required property 'q'") })
  })
})
