/**
 * POST /webhooks/gmail — Google Pub/Sub push delivery (spec §Data flow → Inbound). Unauthenticated by
 * session; the only trust anchor is the push subscription's own OIDC identity token, carried as
 * `Authorization: Bearer <jwt>` and verified against Google's public JWKS. Mounted inside server.ts's
 * rate-limited nested routes block — outside the /trpc CSRF guard (that hook only matches
 * `req.url.startsWith('/trpc')`) and outside Better Auth entirely.
 *
 * Every response is either 404 (the endpoint isn't armed — no GMAIL_PUBSUB_* configured), 403 (the
 * token failed verification or didn't identify the configured service account) or 200 (Pub/Sub only
 * backs off on 4xx/5xx; anything else it retries forever, so a disconnected mailbox or a replayed
 * messageId both have to ack with 200, not skip silently).
 */
import { createRemoteJWKSet, jwtVerify } from 'jose'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { JOB_NAMES } from '@aesa/queue'
import type { ServerDeps } from '../deps.ts'

/** Module-level: `createRemoteJWKSet` itself makes no network call — the cache is only ever populated
 * the first time `jwtVerify` needs a key, and only for a token that already parsed as a structurally
 * valid compact JWS (jose rejects garbage input before it gets that far). */
const GOOGLE_JWKS = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'))

interface GoogleClaims { email?: string; email_verified?: boolean }

/** The production seam implementation, bound to `audience` at server-build time (registerGmailWebhook
 * already has `deps.config.gmailPubsubAudience` in hand). `deps.verifyGoogleJwt` overrides this whole
 * function in tests, so no suite has to mint a real Google-signed token. */
function verifyWithJose(audience: string): (jwt: string) => Promise<GoogleClaims> {
  return async (jwt) => {
    const { payload } = await jwtVerify(jwt, GOOGLE_JWKS, { issuer: 'https://accounts.google.com', audience })
    return {
      email: typeof payload.email === 'string' ? payload.email : undefined,
      email_verified: typeof payload.email_verified === 'boolean' ? payload.email_verified : undefined,
    }
  }
}

const PushBody = z.object({
  message: z.object({
    messageId: z.string().min(1),
    data: z.string().min(1), // base64 JSON: { emailAddress, historyId }
  }),
})

const PushData = z.object({
  emailAddress: z.string().min(1),
  historyId: z.union([z.string(), z.number()]),
})

export function registerGmailWebhook(routes: FastifyInstance, deps: ServerDeps): void {
  const { config } = deps
  const { gmailPubsubAudience: audience, gmailPubsubServiceAccount: serviceAccount } = config
  // Both are all-or-none by construction (config.ts's gmailPubsubPair) — this is just where the two
  // separately-typed `string | null` fields get narrowed together into one armed/unarmed decision.
  const armed = audience !== null && serviceAccount !== null
    ? { verify: deps.verifyGoogleJwt ?? verifyWithJose(audience), serviceAccount }
    : null

  routes.post('/webhooks/gmail', async (req, reply) => {
    if (!armed) return reply.code(404).send({ statusCode: 404, error: 'Not Found' })

    const authHeader = req.headers.authorization
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : null
    if (!token) return reply.code(403).send({ statusCode: 403, error: 'Forbidden' })

    let claims: GoogleClaims
    try {
      claims = await armed.verify(token)
    } catch {
      return reply.code(403).send({ statusCode: 403, error: 'Forbidden' })
    }
    if (claims.email !== armed.serviceAccount || claims.email_verified !== true) {
      return reply.code(403).send({ statusCode: 403, error: 'Forbidden' })
    }

    const parsedBody = PushBody.safeParse(req.body)
    if (!parsedBody.success) return reply.code(400).send({ statusCode: 400, error: 'Bad Request' })
    const { messageId, data } = parsedBody.data.message

    let decoded: { emailAddress: string; historyId: string | number }
    try {
      decoded = PushData.parse(JSON.parse(Buffer.from(data, 'base64').toString('utf8')))
    } catch {
      return reply.code(400).send({ statusCode: 400, error: 'Bad Request' })
    }

    // Dedupe on Pub/Sub's own messageId — a duplicate delivery acks with no further work, same as an
    // unknown mailbox below. Neither branch is distinguished on the wire (both are plain 200s): Pub/Sub
    // just needs to stop redelivering, not learn why.
    const isNew = await deps.api.recordWebhookEvent('gmail', messageId, {
      messageId, historyId: decoded.historyId, emailAddress: decoded.emailAddress,
    })
    if (!isNew) return reply.code(200).send({ ok: true })

    const connection = await deps.api.resolveMailboxConnection('gmail', decoded.emailAddress)
    if (!connection) return reply.code(200).send({ ok: true })

    await deps.enqueue(
      JOB_NAMES.mailboxSync,
      { orgId: connection.orgId, connectionId: connection.connectionId },
      { entityId: connection.connectionId, debounceSeconds: 10 },
    )
    return reply.code(200).send({ ok: true })
  })
}
