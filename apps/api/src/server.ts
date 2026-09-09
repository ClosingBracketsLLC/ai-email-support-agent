import { STATUS_CODES } from 'node:http'
import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'
import { fastifyTRPCPlugin, type FastifyTRPCPluginOptions } from '@trpc/server/adapters/fastify'
import { fromNodeHeaders } from 'better-auth/node'
import Fastify, { type FastifyBaseLogger, type FastifyError, type FastifyInstance } from 'fastify'
import { registerConnectRoutes } from './connect/routes.ts'
import type { ServerDeps } from './deps.ts'
import { createContextFactory } from './trpc/context.ts'
import { appRouter, type AppRouter } from './trpc/router.ts'
import { registerGmailWebhook } from './webhooks/gmail.ts'
import { registerMicrosoftWebhook } from './webhooks/microsoft.ts'

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

  // Browser callers: the Expo web origin plus any documented extra web origin (config.webOrigins — e.g. a
  // staging deploy), with credentials. Native callers send no Origin and are not CORS.
  app.register(cors, { origin: deps.config.webOrigins, credentials: true })

  // A global request-rate ceiling. Better Auth's own limiter only covers /api/auth/*; everything else — /trpc
  // above all, since `team.invite` is an authenticated mail relay and `workspace.create` is otherwise unbounded
  // — had no limit at all (Phase 1 review, Important 2). In-memory, so per replica, same as Better Auth's own
  // (STATUS.md). config.rateLimit === 0 (tests) disables it outright rather than registering a 0-max plugin,
  // which would 429 every request instead of none.
  if (deps.config.rateLimit > 0) {
    app.register(rateLimit, { global: true, max: deps.config.rateLimit, timeWindow: '1 minute', keyGenerator: (req) => req.ip })
  }

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

  // Browser CSRF guard for mutations: a POST that carries an Origin must come from a trusted web origin
  // (config.webOrigins). Native clients send no Origin (and no ambient cookies), so they pass; CORS already
  // blocks other browsers' reads. A plain onRequest hook on the root instance, unlike @fastify/rate-limit's
  // onRoute-based `global` mode below, applies to every route regardless of registration order.
  app.addHook('onRequest', async (req, reply) => {
    if (req.method !== 'POST' || !req.url.startsWith('/trpc')) return
    if (req.headers.origin && !deps.config.webOrigins.includes(req.headers.origin)) return reply.code(403).send({ statusCode: 403, error: 'Forbidden' })
  })

  // Every route below is declared inside a nested register() so @fastify/rate-limit's `global: true` mode
  // actually reaches it. That plugin decorates each route at declaration time via an onRoute event; a route
  // declared directly on `app` (fastify.get/route) runs synchronously — before any register()ed plugin,
  // rate-limit included, has executed its body — so it would never be wrapped no matter where in this
  // function the plugin itself is registered. fastifyTRPCPlugin already gets this for free (it declares its
  // routes inside its own register() call, which boots after rate-limit's in FIFO order).
  app.register(async (routes) => {
    // Better Auth: build a fetch Request from the Fastify request (URL rooted at the configured base, never
    // the Host header) and copy the Response back. Cookies are copied through getSetCookie so several
    // Set-Cookie lines survive.
    routes.route({
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

    routes.get('/meta', async () => ({
      providers: { google: deps.config.google !== null, microsoft: deps.config.microsoft !== null },
      // Mailbox OAuth (Gmail/Graph mail access), distinct from the sign-in providers above — the app
      // uses this to decide which "connect a mailbox" options to offer.
      mail: { gmail: deps.config.gmailOauth !== null, microsoft: deps.config.msOauth !== null },
    }))

    routes.get('/healthz', async (_req, reply) => {
      const h = await deps.api.health()
      return reply.code(h.db === 'ok' ? 200 : 503).send({ status: h.db === 'ok' ? 'ok' : 'degraded', db: h.db, migrations: h.migrations, uptimeSeconds: Math.round((Date.now() - startedAt) / 1000) })
    })

    // Only exists with the devsink transport, which loadConfig refuses in production.
    if (deps.mail.kind === 'devsink') {
      const sink = deps.mail
      routes.get<{ Querystring: { to?: string } }>('/__dev/mail/latest', async (req, reply) => {
        const mail = req.query.to ? sink.latestTo(req.query.to) : undefined
        return mail ? reply.send(mail) : reply.code(404).send({ statusCode: 404, error: 'Not Found' })
      })
    }

    // The mailbox OAuth connect flow's two unauthenticated hops (connect/routes.ts) — mounted here, not
    // on `app` directly, for the same reason every other plain route in this block is: only a route
    // declared inside a register() actually gets wrapped by @fastify/rate-limit's onRoute-driven
    // `global: true` mode (see this block's own opening comment).
    registerConnectRoutes(routes, deps)

    // Task 18: the Gmail Pub/Sub and Microsoft Graph inbound webhooks — same "why here, not on `app`"
    // reasoning as registerConnectRoutes above (rate-limit's `global: true` onRoute hook). Neither
    // carries a session; each has its own trust anchor (the OIDC bearer token, clientState) instead.
    registerGmailWebhook(routes, deps)
    registerMicrosoftWebhook(routes, deps)
  })

  app.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: {
      router: appRouter,
      createContext: createContextFactory(deps),
      onError({ path, error }) {
        // Client errors are expected traffic; only unexpected failures deserve the (redacting) err serializer.
        if (error.code === 'INTERNAL_SERVER_ERROR') app.log.error({ err: error.cause ?? error, path }, 'trpc failed')
        else app.log.warn({ path, code: error.code }, 'trpc rejected')
      },
    } satisfies FastifyTRPCPluginOptions<AppRouter>['trpcOptions'],
  })

  return app
}
