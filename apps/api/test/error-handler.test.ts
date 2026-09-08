import { DrizzleQueryError } from 'drizzle-orm/errors'
import { describe, expect, it } from 'vitest'
import { buildServer } from '../src/server.ts'
import { stubDeps } from './helpers/app.ts'

const SECRET = 'tok_SUPER_SECRET_SESSION_TOKEN'
const QUERY = 'insert into "session" ("token") values ($1)'

/** The error paths never touch the database, so deps stay stubs. */
function buildCapturingServer() {
  const lines: string[] = []
  const app = buildServer(stubDeps({}, { level: 'trace', stream: { write: (line: string) => void lines.push(line) } }))
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

  it('copies err.headers onto the reply and honours err.status (Better Auth throws status + headers)', async () => {
    const { app } = buildCapturingServer()
    app.get('/rl', async () => { throw Object.assign(new Error('slow down'), { status: 429, headers: { 'retry-after': '7' } }) })
    const res = await app.inject({ method: 'GET', url: '/rl' })
    await app.close()
    expect(res.statusCode).toBe(429)
    expect(res.headers['retry-after']).toBe('7')
    expect(res.json()).toEqual({ statusCode: 429, error: 'Too Many Requests', message: 'Too Many Requests' })
  })

  it('lets a deliberate 502/503 through and collapses every other 5xx to 500', async () => {
    const { app } = buildCapturingServer()
    app.get('/down', async () => { throw Object.assign(new Error('db gone'), { statusCode: 503 }) })
    app.get('/odd', async () => { throw Object.assign(new Error('x'), { statusCode: 507 }) })
    const a = await app.inject({ method: 'GET', url: '/down' })
    const b = await app.inject({ method: 'GET', url: '/odd' })
    await app.close()
    expect(a.statusCode).toBe(503); expect(a.json()).toEqual({ statusCode: 503, error: 'Service Unavailable' })
    expect(b.statusCode).toBe(500); expect(b.json()).toEqual({ statusCode: 500, error: 'Internal Server Error' })
  })

  it('keeps a short error code (Postgres SQLSTATE) in the log line but never the cause message', async () => {
    const { app, log } = buildCapturingServer()
    app.get('/pg', async () => { throw new DrizzleQueryError(QUERY, [SECRET], Object.assign(new Error(`duplicate key ${SECRET}`), { code: '23505' })) })
    const res = await app.inject({ method: 'GET', url: '/pg' })
    await app.close()
    expect(res.statusCode).toBe(500)
    expect(log()).toContain('"code":"23505"')
    expect(log()).not.toContain(SECRET)
  })
})
