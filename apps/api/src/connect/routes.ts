/**
 * The two unauthenticated HTTP hops of the mailbox OAuth connect flow (mounted inside server.ts's
 * rate-limited nested routes block — see that file's comment on why routes must be registered there,
 * not on `app` directly, for @fastify/rate-limit's `global: true` mode to actually wrap them).
 *
 * GET /connect/:provider/start    — the tRPC mutation already created the flow; this hop exists only so
 *   the system browser sees the already-opaque `state`, never a token, before it 302s on to the real
 *   provider. The PKCE `code_challenge` is derived HERE, server-side, from the stored verifier
 *   (`prepareAuthorization`) — never accepted from the caller (Task 17 review, Important 1): an
 *   unauthenticated caller-supplied challenge would let anyone bounce an arbitrary `state` on to the
 *   provider with a challenge no longer provably bound to the verifier the callback will decrypt.
 * GET /connect/:provider/callback — sessionless: the provider redirects the system browser straight
 *   back here, so every authorization this route needs comes from `state` (via `consumeFlow`'s
 *   cross-org resolver) — see connect/flows.ts.
 */
import { and, eq, ne } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { MAIL_PROVIDERS, type MailProvider } from '@aesa/contracts'
import { audit, getOrgBoxPublicKeyOrNull, mailboxConnections, oauthFlows } from '@aesa/db'
import { gmailProvider, graphProvider, sealTokens, type MailboxProvider, type TokenSet } from '@aesa/mail'
import { JOB_NAMES } from '@aesa/queue'
import type { ServerDeps } from '../deps.ts'
import { isUniqueViolation } from '../pg-error.ts'
import { consumeFlow, failPendingFlow, prepareAuthorization } from './flows.ts'

function isMailProvider(v: string): v is MailProvider {
  return (MAIL_PROVIDERS as readonly string[]).includes(v)
}

/** `deps.mailProviders` is read fresh on every call (never cached at server-build time) so tests can
 * swap the stub mid-suite; production leaves it unset and always gets the real adapter. */
function resolveProvider(deps: ServerDeps, provider: MailProvider): MailboxProvider {
  return deps.mailProviders?.[provider] ?? (provider === 'gmail' ? gmailProvider() : graphProvider())
}

/** Minimal HTML-entity escaper — every value interpolated into a page this route renders goes through
 * this (Task 17 review, Important 2): the provider-supplied `emailAddress` is untrusted input on its way
 * into an HTML response, and even `metaRefresh` (built from config, not user input) is escaped for the
 * same reason belt-and-braces attribute encoding costs nothing here. */
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

function htmlPage(message: string, opts: { metaRefresh?: string } = {}): string {
  const refresh = opts.metaRefresh ? `<meta http-equiv="refresh" content="1;url=${escapeHtml(opts.metaRefresh)}">` : ''
  return `<!doctype html><html><head><meta charset="utf-8">${refresh}<title>aesa</title></head><body><p>${escapeHtml(message)}</p></body></html>`
}

const GENERIC_RETRY_MESSAGE = 'Something went wrong. Please try again from the app.'

type ExchangeResult = { tokens: TokenSet; emailAddress: string; providerAccountId: string }

/** A thin wrapper so the caller gets a `const`-narrowable `null` on failure instead of a `let` that
 * TypeScript would otherwise widen back to nullable once captured by the later `withOrg` closure. */
async function tryExchangeCode(adapter: MailboxProvider, params: Parameters<MailboxProvider['exchangeCode']>[0]): Promise<ExchangeResult | null> {
  try {
    return await adapter.exchangeCode(params)
  } catch {
    return null
  }
}

type ConnectOutcome =
  | { kind: 'failed'; reason: 'keys_missing' | 'already_connected_elsewhere' }
  | { kind: 'connected'; connectionId: string; emailAddress: string; boxPublicKey: Buffer; wasReconnect: boolean }

export function registerConnectRoutes(routes: FastifyInstance, deps: ServerDeps): void {
  routes.get<{ Params: { provider: string }; Querystring: { state?: string } }>(
    '/connect/:provider/start',
    async (req, reply) => {
      const provider = req.params.provider
      if (!isMailProvider(provider)) return reply.code(404).send({ statusCode: 404, error: 'Not Found' })
      const oauth = provider === 'gmail' ? deps.config.gmailOauth : deps.config.msOauth
      const { state } = req.query
      if (!oauth || !state) return reply.code(400).send({ statusCode: 400, error: 'Bad Request' })

      // No caller-supplied challenge: verified against the stored flow (still pending, unexpired, right
      // nonce) and derived server-side from the verifier this flow itself encrypted at createFlow time.
      const prepared = await prepareAuthorization(deps.api, { state, flowKey: deps.config.flowKey })
      if (!prepared || prepared.provider !== provider) return reply.code(400).send({ statusCode: 400, error: 'Bad Request' })

      const adapter = resolveProvider(deps, provider)
      const redirectUri = `${deps.config.appBaseUrl}/connect/${provider}/callback`
      const authorizationUrl = adapter.authorizationUrl({ clientId: oauth.clientId, redirectUri, state, codeChallenge: prepared.codeChallenge })
      return reply.redirect(authorizationUrl, 302)
    },
  )

  routes.get<{
    Params: { provider: string }
    Querystring: { code?: string; state?: string; error?: string; error_description?: string }
  }>('/connect/:provider/callback', async (req, reply) => {
    const provider = req.params.provider
    if (!isMailProvider(provider)) return reply.code(404).send({ statusCode: 404, error: 'Not Found' })
    const { code, state, error, error_description: errorDescription } = req.query
    reply.type('text/html')

    if (!state) return reply.code(400).send(htmlPage(GENERIC_RETRY_MESSAGE))

    if (error) {
      if (error === 'access_denied') {
        await failPendingFlow(deps.api, { state, reason: 'access_denied' })
        return reply.send(htmlPage('You can close this window. The connection was cancelled.'))
      }
      // AADSTS65001: Microsoft's admin-consent-required signal — the tenant admin disabled user consent
      // for this app, so the owner has to ask their admin to grant it (mailboxes.adminConsentInfo, Task 19).
      const adminConsentRequired = typeof errorDescription === 'string' && /AADSTS65001/.test(errorDescription)
      await failPendingFlow(deps.api, { state, reason: adminConsentRequired ? 'admin_consent_required' : 'oauth_error' })
      return reply.send(htmlPage(
        adminConsentRequired
          ? 'Your Microsoft admin needs to approve this connection. Ask them to grant consent, then try again from the app.'
          : GENERIC_RETRY_MESSAGE,
      ))
    }

    if (!code) return reply.code(400).send(htmlPage(GENERIC_RETRY_MESSAGE))

    const consumed = await consumeFlow(deps.api, { state, flowKey: deps.config.flowKey })
    if (!consumed) return reply.code(400).send(htmlPage('This link has expired or was already used. Please try again from the app.'))

    const oauth = consumed.provider === 'gmail' ? deps.config.gmailOauth : deps.config.msOauth
    if (!oauth) return reply.code(400).send(htmlPage(GENERIC_RETRY_MESSAGE))

    const adapter = resolveProvider(deps, consumed.provider)
    const exchanged = await tryExchangeCode(adapter, {
      clientId: oauth.clientId,
      clientSecret: oauth.clientSecret.expose(),
      redirectUri: `${deps.config.appBaseUrl}/connect/${consumed.provider}/callback`,
      code,
      codeVerifier: consumed.codeVerifier,
    })
    if (!exchanged) return reply.code(400).send(htmlPage(GENERIC_RETRY_MESSAGE))

    // The provider-returned address is about to be persisted (mailbox_connections.email_address, an
    // enqueued job payload) and rendered into the success page — validate its SHAPE before either
    // (Task 17 review, Important 2). A provider that hands back something malformed is a flow failure,
    // not a value this route trusts as-is; the flow already left 'pending' (consumeFlow marked it
    // 'consumed' above), so this is a direct update, not failPendingFlow (which only touches 'pending' rows).
    const parsedEmail = z.email().max(254).safeParse(exchanged.emailAddress)
    if (!parsedEmail.success) {
      await deps.api.withOrg(consumed.orgId, (tx) =>
        tx.update(oauthFlows).set({ status: 'failed', failureReason: 'invalid_email' }).where(eq(oauthFlows.id, consumed.flowId)),
      )
      return reply.send(htmlPage(GENERIC_RETRY_MESSAGE))
    }
    const emailAddress = parsedEmail.data

    const outcome = await deps.api.withOrg<ConnectOutcome>(consumed.orgId, async (tx) => {
      const boxPublicKey = await getOrgBoxPublicKeyOrNull(tx)
      if (!boxPublicKey) {
        await tx.update(oauthFlows).set({ status: 'failed', failureReason: 'keys_missing' }).where(eq(oauthFlows.id, consumed.flowId))
        return { kind: 'failed', reason: 'keys_missing' }
      }

      // RLS already scopes this SELECT to consumed.orgId; the explicit predicate is defense in depth
      // (mailbox_credentials.ts's own convention) — it also documents that "existing" below means
      // "existing IN THIS ORG", which is exactly what makes the insert's unique-violation catch below
      // mean "some OTHER org already holds this (provider, email)".
      const [existing] = await tx.select().from(mailboxConnections).where(
        and(
          eq(mailboxConnections.orgId, consumed.orgId),
          eq(mailboxConnections.provider, consumed.provider),
          eq(mailboxConnections.emailAddress, emailAddress),
          ne(mailboxConnections.status, 'disabled'),
        ),
      )

      let connectionId: string
      if (existing) {
        await tx.update(mailboxConnections)
          .set({ providerAccountId: exchanged.providerAccountId, status: 'pending_claim', connectedByUserId: consumed.userId })
          .where(eq(mailboxConnections.id, existing.id))
        connectionId = existing.id
      } else {
        try {
          // A SAVEPOINT (drizzle's nested tx.transaction()), not the outer transaction: a caught
          // unique_violation otherwise leaves the whole Postgres transaction aborted, and every
          // statement below (marking the flow failed, or — on the success path — recording
          // connection_id) would fail with "current transaction is aborted".
          connectionId = await tx.transaction(async (tx2) => {
            const [inserted] = await tx2.insert(mailboxConnections).values({
              orgId: consumed.orgId,
              provider: consumed.provider,
              providerAccountId: exchanged.providerAccountId,
              emailAddress,
              status: 'pending_claim',
              connectedByUserId: consumed.userId,
            }).returning()
            return inserted!.id
          })
        } catch (err) {
          if (!isUniqueViolation(err)) throw err
          // The partial unique index (provider, email_address) WHERE status <> 'disabled' is the
          // backstop for a cross-org collision the SELECT above cannot see (RLS hides other orgs'
          // rows entirely) — and for a race against a concurrent callback for the same address.
          await tx.update(oauthFlows).set({ status: 'failed', failureReason: 'already_connected_elsewhere' }).where(eq(oauthFlows.id, consumed.flowId))
          return { kind: 'failed', reason: 'already_connected_elsewhere' }
        }
      }

      await tx.update(oauthFlows).set({ connectionId }).where(eq(oauthFlows.id, consumed.flowId))
      return { kind: 'connected', connectionId, emailAddress, boxPublicKey, wasReconnect: Boolean(existing) }
    })

    if (outcome.kind === 'failed') {
      const message = outcome.reason === 'keys_missing'
        ? 'Something went wrong provisioning your workspace. Please try again from the app.'
        : 'This mailbox is already connected to a different aesa workspace.'
      return reply.send(htmlPage(message))
    }

    // Post-tx (deviation 2, spec): the api writes NO mailbox_credentials row — it has no privilege on
    // that table at all (migration 0006's REVOKE). Seal the fresh tokens to the org's box public key and
    // hand the sealed blob to the worker, which owns the only write path.
    const sealed = await sealTokens(outcome.boxPublicKey, exchanged.tokens)
    const jobId = await deps.enqueue(
      JOB_NAMES.storeCredentials,
      { orgId: consumed.orgId, connectionId: outcome.connectionId, sealed: sealed.toString('base64') },
      { entityId: outcome.connectionId },
    )

    // `enqueue()` returns null on a singleton dedupe collision (final-review Important) — the
    // connection is `pending_claim` right now and would otherwise stay that way forever with NO
    // `mailbox_credentials` row: `claimConnection` has no way to tell "no credentials job ever ran"
    // from "still in flight", so it would happily flip an uncredentialed connection to 'connected'.
    // Recovery differs by path: a RECONNECT touched a connection that worked before this attempt, so
    // it goes to `reauth_required` (still visible, still retryable) rather than being torn down; a
    // FRESH connect created this row moments ago in the transaction above, still `pending_claim` with
    // no possible tickets yet (mailbox.sync never touches an unclaimed row), so it is safe to delete
    // outright and let a retry start clean.
    if (jobId === null) {
      await deps.api.withOrg(consumed.orgId, async (tx) => {
        await tx.update(oauthFlows).set({ status: 'failed', failureReason: 'enqueue_failed' }).where(eq(oauthFlows.id, consumed.flowId))
        if (outcome.wasReconnect) {
          await tx.update(mailboxConnections).set({ status: 'reauth_required' }).where(eq(mailboxConnections.id, outcome.connectionId))
          await audit(tx, {
            actor: 'system:connect_callback', action: 'mailbox.claim_enqueue_failed_reverted',
            entityType: 'mailbox_connection', entityId: outcome.connectionId,
          })
        } else {
          await tx.delete(mailboxConnections).where(eq(mailboxConnections.id, outcome.connectionId))
          await audit(tx, {
            actor: 'system:connect_callback', action: 'mailbox.claim_enqueue_failed_deleted',
            entityType: 'mailbox_connection', entityId: outcome.connectionId,
          })
        }
      })
      return reply.send(htmlPage(GENERIC_RETRY_MESSAGE))
    }

    const successMessage = `Connected as ${outcome.emailAddress}. Return to the app to finish.`
    if (consumed.platform === 'web') {
      return reply.send(htmlPage(successMessage, { metaRefresh: `${deps.config.appWebOrigin}/onboarding/mailbox` }))
    }
    return reply.send(htmlPage(successMessage))
  })
}
