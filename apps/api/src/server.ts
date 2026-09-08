import Fastify, { type FastifyInstance } from 'fastify'
import type pg from 'pg'
import type { Db } from '@aesa/db'
import { redactUrl } from './redact.ts'

export interface ServerDeps { db: Db; pool: pg.Pool; logLevel?: string }

export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({
    logger: {
      level: deps.logLevel ?? 'info',
      redact: { paths: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-api-key"]'], censor: '[redacted]' },
      serializers: { req: (req) => ({ method: req.method, url: redactUrl(req.url), host: req.host, remoteAddress: req.ip }) },
    },
  })
  const startedAt = Date.now()

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
