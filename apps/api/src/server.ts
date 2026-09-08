import { STATUS_CODES } from 'node:http'
import { DrizzleQueryError } from 'drizzle-orm/errors'
import Fastify, { type FastifyError, type FastifyInstance, type FastifyServerOptions } from 'fastify'
import type pg from 'pg'
import type { Db } from '@aesa/db'
import { redactUrl } from './redact.ts'

export interface ServerDeps {
  db: Db
  pool: pg.Pool
  logLevel?: string
  /** Test seam: a pino destination so a suite can assert on the real log output. Production logs to stdout. */
  logStream?: { write(line: string): void }
}

const URL_IN_TEXT = /https?:\/\/[^\s"'<>)\]]+/g

interface SerializedError { [key: string]: unknown; type: string; message: string; stack: string }

/**
 * pino `err` serializer. Emits type/message/stack only — never `params`, `query` or `cause`: drizzle's
 * DrizzleQueryError message is `Failed query: <sql>\nparams: <bound values>` (session tokens, verification
 * codes) and a pg `cause` repeats the offending value in its own `detail`. Any URL left in a message is
 * masked with the same redactUrl() the request serializer uses.
 */
function serializeError(err: Error): SerializedError {
  const type = err?.constructor?.name ?? 'Error'
  const raw = err instanceof DrizzleQueryError ? 'Failed query: [redacted]' : String(err?.message ?? err)
  const message = raw.replace(URL_IN_TEXT, (url) => redactUrl(url))
  // Rebuilt rather than rewritten: an Error's stack starts with its (here multi-line) message.
  const frames = String(err?.stack ?? '').split('\n').filter((line) => /^\s*at /.test(line))
  return { type, message, stack: [`${type}: ${message}`, ...frames].join('\n') }
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  const logger: FastifyServerOptions['logger'] = {
    level: deps.logLevel ?? 'info',
    // Defence in depth: the `req` serializer below never emits headers, so these paths cannot match
    // today; they stay so that adding a header to that serializer cannot silently start leaking one.
    redact: { paths: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-api-key"]'], censor: '[redacted]' },
    serializers: {
      req: (req) => ({ method: req.method, url: redactUrl(req.url), host: req.host, remoteAddress: req.ip }),
      err: serializeError,
    },
    ...(deps.logStream ? { stream: deps.logStream } : {}),
  }
  const app = Fastify({ logger })
  const startedAt = Date.now()

  // Fastify's default handler puts err.message in the body and logs the raw error; both leak query
  // parameters. 5xx answers with a bare body; 4xx keeps Fastify's shape but only Fastify's own message.
  app.setErrorHandler((err: FastifyError, req, reply) => {
    const status = typeof err.statusCode === 'number' && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 500
    if (status >= 500) {
      req.log.error({ err }, 'request failed')
      return reply.code(500).send({ statusCode: 500, error: 'Internal Server Error' })
    }
    req.log.warn({ err }, 'request rejected')
    const generic = STATUS_CODES[status] ?? 'Error'
    const fastifyCode = typeof err.code === 'string' && err.code.startsWith('FST_') ? err.code : undefined
    return reply.code(status).send({
      statusCode: status,
      ...(fastifyCode ? { code: fastifyCode } : {}),
      error: generic,
      message: fastifyCode ? err.message : generic,
    })
  })

  app.get('/healthz', async (_req, reply) => {
    let db: 'ok' | 'error' = 'ok'
    let migrations = { count: 0, latest: null as string | null }
    try {
      await deps.pool.query('SELECT 1')
      const res = await deps.pool.query<{ count: number; latest: string | null }>(
        'SELECT count(*)::int AS count, max(created_at)::text AS latest FROM drizzle.__drizzle_migrations',
      )
      migrations = res.rows[0] ?? migrations
    } catch { db = 'error' }
    return reply.code(db === 'ok' ? 200 : 503).send({ status: db === 'ok' ? 'ok' : 'degraded', db, migrations, uptimeSeconds: Math.round((Date.now() - startedAt) / 1000) })
  })
  return app
}
