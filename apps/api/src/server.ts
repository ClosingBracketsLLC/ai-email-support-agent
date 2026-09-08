import { STATUS_CODES } from 'node:http'
import cors from '@fastify/cors'
import { fromNodeHeaders } from 'better-auth/node'
import { DrizzleQueryError } from 'drizzle-orm/errors'
import Fastify, { type FastifyError, type FastifyInstance, type FastifyServerOptions } from 'fastify'
import type { ServerDeps } from './deps.ts'
import { redactUrl } from './redact.ts'

export type { ServerDeps } from './deps.ts'

const URL_IN_TEXT = /https?:\/\/[^\s"'<>)\]]+/g
/** Short machine codes are safe to log: Postgres SQLSTATEs, Fastify FST_*, Node ECONN*. Never a message. */
const SAFE_CODE = /^[A-Z0-9_]{1,40}$/

interface SerializedError { [key: string]: unknown; type: string; message: string; stack: string; code?: string }

/**
 * pino `err` serializer. Emits type/message/stack (+ a short code) only — never `params`, `query` or `cause`
 * messages: drizzle's DrizzleQueryError message is `Failed query: <sql>\nparams: <bound values>` (session tokens,
 * verification codes) and a pg `cause` repeats the offending value in its own `detail`.
 */
function serializeError(err: Error & { code?: unknown; cause?: unknown }): SerializedError {
  const type = err?.constructor?.name ?? 'Error'
  const raw = err instanceof DrizzleQueryError ? 'Failed query: [redacted]' : String(err?.message ?? err)
  const message = raw.replace(URL_IN_TEXT, (url) => redactUrl(url))
  const frames = String(err?.stack ?? '').split('\n').filter((line) => /^\s*at /.test(line))
  const candidate = typeof err?.code === 'string' ? err.code : typeof (err?.cause as { code?: unknown })?.code === 'string' ? (err.cause as { code: string }).code : undefined
  const code = candidate && SAFE_CODE.test(candidate) ? candidate : undefined
  return { type, message, stack: [`${type}: ${message}`, ...frames].join('\n'), ...(code ? { code } : {}) }
}

type ThrownError = FastifyError & { status?: number; headers?: Record<string, string> }

export function buildServer(deps: ServerDeps): FastifyInstance {
  const logger: FastifyServerOptions['logger'] = {
    level: deps.logLevel ?? 'info',
    // Defence in depth: the `req` serializer never emits headers, so these paths cannot match today; they stay so
    // that adding a header to that serializer cannot silently start leaking one.
    redact: { paths: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-api-key"]'], censor: '[redacted]' },
    serializers: {
      req: (req) => ({ method: req.method, url: redactUrl(req.url), host: req.host, remoteAddress: req.ip }),
      err: serializeError,
    },
    ...(deps.logStream ? { stream: deps.logStream } : {}),
  }
  const app = Fastify({ logger })
  const startedAt = Date.now()

  // Better Auth's client posts JSON; some calls carry no body. Fastify's stock parser 400s an empty JSON body.
  app.removeContentTypeParser('application/json')
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    if (!body) return done(null, undefined)
    try { done(null, JSON.parse(body as string)) } catch { done(Object.assign(new Error('Bad Request'), { statusCode: 400 }), undefined) }
  })

  // Browser callers: only the Expo web origin, with credentials. Native callers send no Origin and are not CORS.
  app.register(cors, { origin: [deps.config.appWebOrigin], credentials: true })

  // Fastify's default handler puts err.message in the body and logs the raw error; both leak query parameters.
  // 5xx answers with a bare body (a deliberate 502/503 survives, everything else is a 500); 4xx keeps Fastify's
  // shape but only Fastify's own message. err.headers (WWW-Authenticate, Retry-After) and err.status are honoured.
  app.setErrorHandler((err: ThrownError, req, reply) => {
    const raw = typeof err.statusCode === 'number' ? err.statusCode : typeof err.status === 'number' ? err.status : 500
    const status = raw >= 400 && raw < 600 ? raw : 500
    if (err.headers) for (const [name, value] of Object.entries(err.headers)) reply.header(name, value)
    if (status >= 500) {
      req.log.error({ err }, 'request failed')
      const sent = status === 502 || status === 503 ? status : 500
      return reply.code(sent).send({ statusCode: sent, error: STATUS_CODES[sent] ?? 'Error' })
    }
    req.log.warn({ err }, 'request rejected')
    const generic = STATUS_CODES[status] ?? 'Error'
    const fastifyCode = typeof err.code === 'string' && err.code.startsWith('FST_') ? err.code : undefined
    return reply.code(status).send({ statusCode: status, ...(fastifyCode ? { code: fastifyCode } : {}), error: generic, message: fastifyCode ? err.message : generic })
  })

  // Better Auth: build a fetch Request from the Fastify request (URL rooted at the configured base, never the Host
  // header) and copy the Response back. Cookies are copied through getSetCookie so several Set-Cookie lines survive.
  app.route({
    method: ['GET', 'POST'],
    url: '/api/auth/*',
    async handler(request, reply) {
      const url = new URL(request.url, deps.config.appBaseUrl)
      const headers = fromNodeHeaders(request.headers)
      const init: RequestInit = { method: request.method, headers }
      if (request.body !== undefined && request.body !== null) init.body = JSON.stringify(request.body)
      const response = await deps.auth.handler(new Request(url, init))
      reply.status(response.status)
      response.headers.forEach((value, key) => { if (key !== 'set-cookie') reply.header(key, value) })
      const cookies = response.headers.getSetCookie()
      if (cookies.length) reply.header('set-cookie', cookies)
      return reply.send(response.body ? await response.text() : null)
    },
  })

  app.get('/meta', async () => ({ providers: { google: deps.config.google !== null, microsoft: deps.config.microsoft !== null } }))

  app.get('/healthz', async (_req, reply) => {
    const h = await deps.api.health()
    return reply.code(h.db === 'ok' ? 200 : 503).send({ status: h.db === 'ok' ? 'ok' : 'degraded', db: h.db, migrations: h.migrations, uptimeSeconds: Math.round((Date.now() - startedAt) / 1000) })
  })

  // Only exists with the devsink transport, which loadConfig refuses in production.
  if (deps.mail.kind === 'devsink') {
    const sink = deps.mail
    app.get<{ Querystring: { to?: string } }>('/__dev/mail/latest', async (req, reply) => {
      const mail = req.query.to ? sink.latestTo(req.query.to) : undefined
      return mail ? reply.send(mail) : reply.code(404).send({ statusCode: 404, error: 'Not Found' })
    })
  }

  return app
}
