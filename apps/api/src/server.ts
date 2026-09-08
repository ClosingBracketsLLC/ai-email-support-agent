import { STATUS_CODES } from 'node:http'
import cors from '@fastify/cors'
import { fromNodeHeaders } from 'better-auth/node'
import Fastify, { type FastifyBaseLogger, type FastifyError, type FastifyInstance } from 'fastify'
import type { ServerDeps } from './deps.ts'

export type { ServerDeps } from './deps.ts'

type ThrownError = FastifyError & { status?: number; headers?: Record<string, string> }

export function buildServer(deps: ServerDeps): FastifyInstance {
  // deps.logger (src/logging.ts) is shared with Better Auth (see auth.ts) so every log line, from either
  // source, goes through the same redaction and the same destination. trustProxy governs both Fastify's own
  // request.ip (used by the `req` serializer) and, separately, Better Auth's rate-limiter IP resolution.
  // Widened to FastifyBaseLogger (pino.Logger satisfies it structurally) so Fastify's own generic Logger
  // param resolves to its default — otherwise the more specific pino type makes app's inferred type
  // incompatible with the plain `FastifyInstance` this function returns (a childLoggerFactory variance issue).
  const loggerInstance: FastifyBaseLogger = deps.logger
  const app = Fastify({ loggerInstance, trustProxy: deps.config.trustProxy })
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
