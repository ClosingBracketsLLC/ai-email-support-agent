/**
 * `mailboxes.startConnect` / `claimConnection` / `disconnect` — the account-linking security boundary
 * from the spec: the claim step (Task 17 brief) is what stops a CSRF-style attack where an attacker
 * starts an OAuth flow, gets it consumed by a victim's browser (or just races the callback), and then
 * tries to claim the resulting connection as their own. `claimConnection` refuses unless the CALLER is
 * the same user who started the flow. The rest of the `mailboxes` router (addresses, health, …) is
 * Task 19's slice.
 */
import { randomInt } from 'node:crypto'
import { TRPCError } from '@trpc/server'
import { and, count, eq } from 'drizzle-orm'
import {
  AddAddressInput, AdminConsentInfoInput, ClaimConnectionInput, ConsentAddressInput, DisconnectInput,
  MAX_AGENTS_PER_DOMAIN, RequestGmailAccessInput, ResendVerificationInput, StartConnectInput, emailDomain,
  type AgentStatus, type MailProvider,
} from '@aesa/contracts'
import {
  agentCategoryPolicies, agents, audit, categories, ensureDefaultCategories, getOrgBoxPublicKeyOrNull,
  gmailAccessRequests, mailboxConnections, oauthFlows,
} from '@aesa/db'
import { hashToken } from '@aesa/crypto'
import { JOB_NAMES } from '@aesa/queue'
import { createFlow } from '../../connect/flows.ts'
import { mailboxClaimedMail, verificationMail } from '../../mail/templates.ts'
import { isUniqueViolation } from '../../pg-error.ts'
import { managerProcedure, orgProcedure, router } from '../init.ts'

const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000

/** RULING (Task 19 brief): a 6-digit numeric code, not `generateToken`'s own base64url token — the
 * code has to survive being typed/read back out of an email subject/body and matched by the worker's
 * sync-walk regex (`packages/mail/src/sync.ts`'s `VERIFICATION_CODE_RE = /\b(\d{6})\b/`). Hashed the
 * same way either way: `hashToken('action', code)`, domain-separated from every other token kind. */
function issueVerificationCode(): { code: string; hash: string; expiresAt: Date } {
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
  return { code, hash: hashToken('action', code), expiresAt: new Date(Date.now() + VERIFICATION_TTL_MS) }
}

type ClaimOutcome =
  | { kind: 'not_found' }
  | { kind: 'failed'; reason: string }
  | { kind: 'not_ready' }
  | { kind: 'rejected' }
  | { kind: 'not_connectable'; status: string }
  | { kind: 'ok'; connectionId: string; emailAddress: string; provider: MailProvider }

export const mailboxesRouter = router({
  /** provider configured? enqueue keys.provision (idempotent, debounced) so a brand-new org's DEK/box
   * keypair exists before the callback ever needs to seal a token set to it; box key not provisioned
   * YET → PRECONDITION_FAILED so the app retries rather than the user watching a dead end. */
  startConnect: managerProcedure.input(StartConnectInput).mutation(async ({ ctx, input }) => {
    const oauth = input.provider === 'gmail' ? ctx.deps.config.gmailOauth : ctx.deps.config.msOauth
    if (!oauth) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'provider not configured' })

    await ctx.deps.enqueue(JOB_NAMES.keysProvision, { orgId: ctx.orgId }, { entityId: 'keys', debounceSeconds: 30 })

    const { flowId, state } = await ctx.deps.api.withOrg(ctx.orgId, async (tx) => {
      const boxPublicKey = await getOrgBoxPublicKeyOrNull(tx)
      if (!boxPublicKey) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'provisioning' })

      const flow = await createFlow(tx, { userId: ctx.user.id, provider: input.provider, platform: input.platform, flowKey: ctx.deps.config.flowKey })
      await audit(tx, {
        actor: ctx.actor, action: 'mailbox.connect_started', entityType: 'oauth_flow', entityId: flow.flowId,
        detail: { provider: input.provider, platform: input.platform }, ip: ctx.ip, userAgent: ctx.userAgent,
      })
      return flow
    })

    // No challenge param: the /start route derives it server-side from the stored verifier
    // (connect/flows.ts's prepareAuthorization) rather than trusting one from this unauthenticated hop.
    const url = `${ctx.deps.config.appBaseUrl}/connect/${input.provider}/start?state=${encodeURIComponent(state)}`
    return { url, flowId }
  }),

  /** The account-linking fix: only the user who started the flow may claim its connection. A different
   * user in the SAME org gets FORBIDDEN (audited as mailbox.claim_rejected), not a silent hijack. */
  claimConnection: managerProcedure.input(ClaimConnectionInput).mutation(async ({ ctx, input }) => {
    const outcome = await ctx.deps.api.withOrg<ClaimOutcome>(ctx.orgId, async (tx) => {
      const [flow] = await tx.select().from(oauthFlows).where(eq(oauthFlows.id, input.flowId))
      if (!flow) return { kind: 'not_found' }
      if (flow.status === 'failed') return { kind: 'failed', reason: flow.failureReason ?? 'connect failed' }
      if (flow.status !== 'consumed' || !flow.connectionId) return { kind: 'not_ready' }

      if (flow.userId !== ctx.user.id) {
        await audit(tx, {
          actor: ctx.actor, action: 'mailbox.claim_rejected', entityType: 'oauth_flow', entityId: flow.id,
          detail: { flowUserId: flow.userId }, ip: ctx.ip, userAgent: ctx.userAgent,
        })
        return { kind: 'rejected' }
      }

      const [conn] = await tx.select().from(mailboxConnections).where(eq(mailboxConnections.id, flow.connectionId))
      if (!conn) return { kind: 'not_found' }

      if (conn.status === 'pending_claim') {
        await tx.update(mailboxConnections).set({ status: 'connected' }).where(eq(mailboxConnections.id, conn.id))
        await ensureDefaultCategories(tx)
        await audit(tx, {
          actor: ctx.actor, action: 'mailbox.connected', entityType: 'mailbox_connection', entityId: conn.id,
          detail: { emailAddress: conn.emailAddress }, ip: ctx.ip, userAgent: ctx.userAgent,
        })
        return { kind: 'ok', connectionId: conn.id, emailAddress: conn.emailAddress, provider: conn.provider as MailProvider }
      }
      if (conn.status === 'connected') {
        // Idempotent: a second call for an already-connected row returns the same result with no writes.
        return { kind: 'ok', connectionId: conn.id, emailAddress: conn.emailAddress, provider: conn.provider as MailProvider }
      }
      // 'disabled' (disconnected since this flow was consumed) or 'reauth_required': claiming it now
      // would silently report success for a mailbox that isn't actually usable (Task 17 review,
      // Important 4 — a re-claim after disconnect used to report OK and re-enqueue mailbox.sync).
      return { kind: 'not_connectable', status: conn.status }
    })

    switch (outcome.kind) {
      case 'not_found': throw new TRPCError({ code: 'NOT_FOUND', message: 'connect flow not found' })
      case 'failed': throw new TRPCError({ code: 'PRECONDITION_FAILED', message: outcome.reason })
      case 'not_ready': throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'connect flow not ready' })
      case 'rejected': throw new TRPCError({ code: 'FORBIDDEN', message: 'this connection was started by a different user' })
      case 'not_connectable': throw new TRPCError({ code: 'PRECONDITION_FAILED', message: `mailbox connection is ${outcome.status}, cannot claim` })
      case 'ok': break
    }

    // Post-tx: seeds the sync cursor. Safe even before Task 19 creates the first agent — routing finds
    // none and nothing is ingested — and re-enqueuing on the idempotent second call above is harmless
    // (singletonKey dedupes it).
    await ctx.deps.enqueue(JOB_NAMES.mailboxSync, { orgId: ctx.orgId, connectionId: outcome.connectionId }, { entityId: outcome.connectionId })

    // Also post-tx, same reason: this is the mailbox owner's own paper trail of who attached it (Phase 2
    // review's reverse-phish note) — platform mail must never fail the claim itself.
    try {
      await ctx.deps.mail.send(mailboxClaimedMail({
        to: outcome.emailAddress, emailAddress: outcome.emailAddress, provider: outcome.provider,
        claimedByEmail: ctx.user.email, settingsUrl: `${ctx.deps.config.appWebOrigin}/settings/mailboxes`,
      }))
    } catch (err) {
      ctx.deps.logger.warn({ err }, 'mailbox.claim_email_failed')
    }

    return { connectionId: outcome.connectionId, emailAddress: outcome.emailAddress }
  }),

  disconnect: managerProcedure.input(DisconnectInput).mutation(async ({ ctx, input }) => {
    await ctx.deps.api.withOrg(ctx.orgId, async (tx) => {
      const [conn] = await tx.select().from(mailboxConnections).where(eq(mailboxConnections.id, input.connectionId))
      if (!conn) throw new TRPCError({ code: 'NOT_FOUND', message: 'mailbox connection not found' })
      await tx.update(mailboxConnections).set({ status: 'disabled' }).where(eq(mailboxConnections.id, conn.id))
      await audit(tx, { actor: ctx.actor, action: 'mailbox.disconnected', entityType: 'mailbox_connection', entityId: conn.id, ip: ctx.ip, userAgent: ctx.userAgent })
    })
    // Task 15's worker job: provider revoke, push unsubscribe, mailbox_credentials delete — all best-effort.
    await ctx.deps.enqueue(JOB_NAMES.revokeMailbox, { orgId: ctx.orgId, connectionId: input.connectionId }, { entityId: input.connectionId })
    return { ok: true as const }
  }),

  /** Every connection this org has, its agents, and the Gmail-testing-mode 7-day reconnect proxy
   * (`credentialAgeDays` — the connection's own `createdAt`, since a real credential age would need
   * the worker-only `mailbox_credentials` table the api has no privilege on). */
  list: orgProcedure.query(async ({ ctx }) => {
    const { conns, agentRows } = await ctx.deps.api.withOrg(ctx.orgId, async (tx) => ({
      conns: await tx.select().from(mailboxConnections).where(eq(mailboxConnections.orgId, ctx.orgId)),
      agentRows: await tx.select().from(agents).where(eq(agents.orgId, ctx.orgId)).orderBy(agents.priority),
    }))
    const now = Date.now()
    return {
      connections: conns.map((c) => ({
        id: c.id, provider: c.provider, emailAddress: c.emailAddress, status: c.status,
        lastSyncAt: c.lastSyncAt, lastSuccessAt: c.lastSuccessAt, consecutiveFailures: c.consecutiveFailures,
        pushExpiresAt: c.pushExpiresAt, connectedByUserId: c.connectedByUserId, connectedByMe: c.connectedByUserId === ctx.user.id,
        credentialAgeDays: Math.floor((now - c.createdAt.getTime()) / 86_400_000),
        agents: agentRows
          .filter((a) => a.connectionId === c.id)
          .map((a) => ({
            id: a.id, address: a.address, status: a.status, priority: a.priority, displayName: a.displayName,
            // Task 20 (app): the settings Mailboxes screen needs to know which agents are waiting on
            // THIS caller's one-tap consent (mailboxes.consentAddress) to render the approve/reject
            // card — `consentRequiredFromUserId` itself is intentionally not exposed (it would leak
            // another user's id to everyone else on the connection). `consentPending` (task review
            // fix) is the role-neutral counterpart: true for EVERY viewer while the gate is open, not
            // just the one who must decide it — a consent-gated agent has no verification code yet
            // (`addAddress`/task 19's fix withholds it), so any viewer who isn't the decider must never
            // see "Resend code" (it would 404) and instead gets a plain "waiting on approval" line.
            consentRequiredFromMe: a.consentRequiredFromUserId === ctx.user.id,
            consentPending: a.consentRequiredFromUserId !== null,
          })),
      })),
    }
  }),

  /**
   * The address/verification/consent surface (spec §2). Order matters: the domain limit is checked
   * BEFORE anything is written (so a rejected call leaves no half-created agent), and the outgoing
   * verification mail is sent AFTER the transaction commits — `withOrg` may never span network I/O,
   * and `deps.mail.send` is a real network call under the Resend transport.
   */
  addAddress: managerProcedure.input(AddAddressInput).mutation(async ({ ctx, input }) => {
    const result = await ctx.deps.api.withOrg(ctx.orgId, async (tx) => {
      const [conn] = await tx.select().from(mailboxConnections).where(eq(mailboxConnections.id, input.connectionId))
      if (!conn) throw new TRPCError({ code: 'NOT_FOUND', message: 'mailbox connection not found' })
      if (conn.status !== 'connected') throw new TRPCError({ code: 'PRECONDITION_FAILED', message: `mailbox connection is ${conn.status}, cannot add an address` })

      // claimConnection (Task 17) already seeds the org's 8 default categories; idempotent (onConflictDoNothing)
      // belt-and-braces here too, so this endpoint has its own seeded set to copy from regardless of ordering.
      await ensureDefaultCategories(tx)

      const domain = emailDomain(input.address)
      const [activeInDomain] = await tx.select({ value: count() }).from(agents)
        .where(and(eq(agents.orgId, ctx.orgId), eq(agents.domain, domain), eq(agents.status, 'active')))
      if ((activeInDomain?.value ?? 0) >= MAX_AGENTS_PER_DOMAIN) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'agent limit for domain' })
      }

      // Adding an address to a mailbox someone ELSE connected needs that person's one-tap consent
      // (spec §2) — gating applies even to the primary address, which otherwise needs no verification
      // at all: without this, a second manager could silently activate an agent on a mailbox they
      // never proved they control.
      const isPrimary = input.address === conn.emailAddress
      const consentRequiredFromUserId = conn.connectedByUserId === ctx.user.id ? null : conn.connectedByUserId
      const status: AgentStatus = isPrimary && !consentRequiredFromUserId ? 'active' : 'pending_verification'

      // A consent-gated alias gets NO code yet (review fix — status alone used to conflate the two
      // proofs this agent needs: mailbox control via a code, and the connecting user's consent. A
      // code issued here would let the consenting user's own "no" be raced by a customer/attacker
      // simply mailing the code before consent is ever decided). `consentAddress`'s approve branch
      // issues a fresh one, post-approval, once the gate is the only thing left to satisfy.
      let verificationCodeHash: string | null = null
      let verificationExpiresAt: Date | null = null
      let code: string | null = null
      if (!isPrimary && !consentRequiredFromUserId) {
        const issued = issueVerificationCode()
        code = issued.code
        verificationCodeHash = issued.hash
        verificationExpiresAt = issued.expiresAt
      }

      const [onConnection] = await tx.select({ value: count() }).from(agents).where(eq(agents.connectionId, input.connectionId))
      const existingOnConnection = onConnection?.value ?? 0

      // `agents_org_address_uidx` (orgId, address) is the backstop against a race — two concurrent
      // addAddress calls for the same address in this org — that the code above never checks for
      // directly. Caught here rather than left to surface as a raw, unhandled unique-violation.
      let agent: typeof agents.$inferSelect | undefined
      try {
        ;[agent] = await tx.insert(agents).values({
          orgId: ctx.orgId,
          connectionId: input.connectionId,
          address: input.address,
          domain,
          displayName: input.address.split('@')[0]!,
          personaPreset: 'support',
          priority: existingOnConnection,
          status,
          replyFromAddress: input.replyFromConnection ? conn.emailAddress : null,
          verificationCodeHash,
          verificationExpiresAt,
          consentRequiredFromUserId,
        }).returning()
      } catch (err) {
        if (isUniqueViolation(err)) throw new TRPCError({ code: 'CONFLICT', message: 'address already has an agent' })
        throw err
      }

      const orgCategories = await tx.select({ id: categories.id }).from(categories).where(eq(categories.orgId, ctx.orgId))
      if (orgCategories.length > 0) {
        await tx.insert(agentCategoryPolicies).values(
          orgCategories.map((c) => ({ orgId: ctx.orgId, agentId: agent!.id, categoryId: c.id, mode: 'review' })),
        )
      }

      await audit(tx, {
        actor: ctx.actor, action: 'agent.address_added', entityType: 'agent', entityId: agent!.id,
        detail: { address: input.address, isPrimary, status, consentRequired: consentRequiredFromUserId !== null },
        ip: ctx.ip, userAgent: ctx.userAgent,
      })

      return { agentId: agent!.id, status, code }
    })

    if (result.code) await ctx.deps.mail.send(verificationMail(input.address, result.code))
    return { agentId: result.agentId, status: result.status }
  }),

  /** Rotates the code — the old hash stops matching immediately, not just once the new mail arrives.
   * NOT_FOUND for anything that isn't a still-pending alias agent (an active/disabled agent, or a
   * pending PRIMARY agent that never had a code to begin with — that one is waiting on consent, not
   * verification). */
  resendVerification: managerProcedure.input(ResendVerificationInput).mutation(async ({ ctx, input }) => {
    const result = await ctx.deps.api.withOrg(ctx.orgId, async (tx) => {
      const [agent] = await tx.select().from(agents).where(and(eq(agents.orgId, ctx.orgId), eq(agents.id, input.agentId)))
      if (!agent || agent.status !== 'pending_verification' || !agent.verificationCodeHash) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'no pending verification for this agent' })
      }
      const issued = issueVerificationCode()
      await tx.update(agents)
        .set({ verificationCodeHash: issued.hash, verificationExpiresAt: issued.expiresAt })
        .where(eq(agents.id, agent.id))
      await audit(tx, { actor: ctx.actor, action: 'agent.verification_resent', entityType: 'agent', entityId: agent.id, ip: ctx.ip, userAgent: ctx.userAgent })
      return { address: agent.address, code: issued.code }
    })
    await ctx.deps.mail.send(verificationMail(result.address, result.code))
    return { ok: true as const }
  }),

  /**
   * Only the user named in `consent_required_from_user_id` may decide this — `orgProcedure`, not
   * `managerProcedure`: the deciding user is fixed by who connected the mailbox, not by the caller's
   * current role (a demoted admin who still holds the pending consent is still the right person to
   * ask). Reject deletes the agent outright — there is nothing else pending on it to clean up.
   *
   * Approve on an ALIAS issues a FRESH verification code here — this is the only point at which a
   * consent-gated alias ever gets one (`addAddress` above withholds it while gated). The mail send is
   * post-tx, same reason as everywhere else in this file: `withOrg` may never span network I/O.
   */
  consentAddress: orgProcedure.input(ConsentAddressInput).mutation(async ({ ctx, input }) => {
    const result = await ctx.deps.api.withOrg(ctx.orgId, async (tx) => {
      const [agent] = await tx.select().from(agents).where(and(eq(agents.orgId, ctx.orgId), eq(agents.id, input.agentId)))
      if (!agent) throw new TRPCError({ code: 'NOT_FOUND', message: 'agent not found' })
      if (!agent.consentRequiredFromUserId || agent.consentRequiredFromUserId !== ctx.user.id) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'only the user whose consent is required may decide this' })
      }

      if (!input.approve) {
        await tx.delete(agents).where(eq(agents.id, agent.id))
        await audit(tx, { actor: ctx.actor, action: 'agent.consent_decided', entityType: 'agent', entityId: agent.id, detail: { approved: false }, ip: ctx.ip, userAgent: ctx.userAgent })
        return { agentId: agent.id, deleted: true as const, mail: null }
      }

      const [conn] = await tx.select({ emailAddress: mailboxConnections.emailAddress }).from(mailboxConnections).where(eq(mailboxConnections.id, agent.connectionId))
      const isPrimary = conn?.emailAddress === agent.address
      const status: AgentStatus = isPrimary ? 'active' : 'pending_verification'

      const patch: { consentRequiredFromUserId: null; status: AgentStatus; verificationCodeHash?: string; verificationExpiresAt?: Date } = {
        consentRequiredFromUserId: null, status,
      }
      let mail: { address: string; code: string } | null = null
      if (!isPrimary) {
        const issued = issueVerificationCode()
        patch.verificationCodeHash = issued.hash
        patch.verificationExpiresAt = issued.expiresAt
        mail = { address: agent.address, code: issued.code }
      }
      await tx.update(agents).set(patch).where(eq(agents.id, agent.id))
      await audit(tx, { actor: ctx.actor, action: 'agent.consent_decided', entityType: 'agent', entityId: agent.id, detail: { approved: true }, ip: ctx.ip, userAgent: ctx.userAgent })
      return { agentId: agent.id, deleted: false as const, status, mail }
    })

    if (result.mail) await ctx.deps.mail.send(verificationMail(result.mail.address, result.mail.code))
    return result.deleted ? { agentId: result.agentId, deleted: true as const } : { agentId: result.agentId, deleted: false as const, status: result.status }
  }),

  /** Idempotent: the operator grants Gmail testing-mode access by hand (runbook), so a second request
   * for the same address is a no-op, not an error. */
  requestGmailAccess: managerProcedure.input(RequestGmailAccessInput).mutation(async ({ ctx, input }) => {
    const email = input.email.toLowerCase()
    await ctx.deps.api.withOrg(ctx.orgId, async (tx) => {
      await tx.insert(gmailAccessRequests).values({ orgId: ctx.orgId, email })
        .onConflictDoNothing({ target: [gmailAccessRequests.orgId, gmailAccessRequests.email] })
      await audit(tx, { actor: ctx.actor, action: 'mailbox.gmail_access_requested', entityType: 'gmail_access_request', entityId: email, ip: ctx.ip, userAgent: ctx.userAgent })
    })
    return { requested: true as const }
  }),

  /**
   * Microsoft's admin-consent endpoint (the AADSTS65001 recovery path — connect/routes.ts's callback
   * already classifies that error as `admin_consent_required`): `GET
   * /{tenant}/adminconsent?client_id=...&redirect_uri=...`, no `state` (Microsoft's docs list it as
   * optional; there is no return leg here to correlate one against — the owner just mails this link
   * to their admin, who opens it separately). Same `common` tenant the mailbox OAuth adapter itself
   * authorizes against (`packages/mail/src/adapters/graph/oauth.ts`).
   */
  adminConsentInfo: managerProcedure.input(AdminConsentInfoInput).query(async ({ ctx, input }) => {
    if (input.connectionId) {
      const [conn] = await ctx.deps.api.withOrg(ctx.orgId, (tx) => tx.select({ id: mailboxConnections.id }).from(mailboxConnections).where(eq(mailboxConnections.id, input.connectionId!)))
      if (!conn) throw new TRPCError({ code: 'NOT_FOUND', message: 'mailbox connection not found' })
    }
    if (!ctx.deps.config.msOauth) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'microsoft mailbox oauth is not configured' })

    const url = new URL('https://login.microsoftonline.com/common/adminconsent')
    url.searchParams.set('client_id', ctx.deps.config.msOauth.clientId)
    url.searchParams.set('redirect_uri', `${ctx.deps.config.appBaseUrl}/connect/microsoft/callback`)
    return { adminConsentUrl: url.toString() }
  }),
})
