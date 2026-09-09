/**
 * `mailboxes.startConnect` / `claimConnection` / `disconnect` — the account-linking security boundary
 * from the spec: the claim step (Task 17 brief) is what stops a CSRF-style attack where an attacker
 * starts an OAuth flow, gets it consumed by a victim's browser (or just races the callback), and then
 * tries to claim the resulting connection as their own. `claimConnection` refuses unless the CALLER is
 * the same user who started the flow. The rest of the `mailboxes` router (addresses, health, …) is
 * Task 19's slice.
 */
import { TRPCError } from '@trpc/server'
import { eq } from 'drizzle-orm'
import { ClaimConnectionInput, DisconnectInput, StartConnectInput } from '@aesa/contracts'
import { audit, ensureDefaultCategories, mailboxConnections, oauthFlows } from '@aesa/db'
import { JOB_NAMES } from '@aesa/queue'
import { createFlow, tryGetOrgBoxPublicKey } from '../../connect/flows.ts'
import { managerProcedure, router } from '../init.ts'

type ClaimOutcome =
  | { kind: 'not_found' }
  | { kind: 'failed'; reason: string }
  | { kind: 'not_ready' }
  | { kind: 'rejected' }
  | { kind: 'ok'; connectionId: string; emailAddress: string }

export const mailboxesRouter = router({
  /** provider configured? enqueue keys.provision (idempotent, debounced) so a brand-new org's DEK/box
   * keypair exists before the callback ever needs to seal a token set to it; box key not provisioned
   * YET → PRECONDITION_FAILED so the app retries rather than the user watching a dead end. */
  startConnect: managerProcedure.input(StartConnectInput).mutation(async ({ ctx, input }) => {
    const oauth = input.provider === 'gmail' ? ctx.deps.config.gmailOauth : ctx.deps.config.msOauth
    if (!oauth) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'provider not configured' })

    await ctx.deps.enqueue(JOB_NAMES.keysProvision, { orgId: ctx.orgId }, { entityId: 'keys', debounceSeconds: 30 })

    const { flowId, state, codeChallenge } = await ctx.deps.api.withOrg(ctx.orgId, async (tx) => {
      const boxPublicKey = await tryGetOrgBoxPublicKey(tx)
      if (!boxPublicKey) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'provisioning' })

      const flow = await createFlow(tx, { userId: ctx.user.id, provider: input.provider, platform: input.platform, flowKey: ctx.deps.config.flowKey })
      await audit(tx, {
        actor: ctx.actor, action: 'mailbox.connect_started', entityType: 'oauth_flow', entityId: flow.flowId,
        detail: { provider: input.provider, platform: input.platform }, ip: ctx.ip, userAgent: ctx.userAgent,
      })
      return flow
    })

    const url = `${ctx.deps.config.appBaseUrl}/connect/${input.provider}/start?state=${encodeURIComponent(state)}&challenge=${encodeURIComponent(codeChallenge)}`
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
      }
      // Idempotent: a second call for an already-'connected' row just returns the same result.
      return { kind: 'ok', connectionId: conn.id, emailAddress: conn.emailAddress }
    })

    switch (outcome.kind) {
      case 'not_found': throw new TRPCError({ code: 'NOT_FOUND', message: 'connect flow not found' })
      case 'failed': throw new TRPCError({ code: 'PRECONDITION_FAILED', message: outcome.reason })
      case 'not_ready': throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'connect flow not ready' })
      case 'rejected': throw new TRPCError({ code: 'FORBIDDEN', message: 'this connection was started by a different user' })
      case 'ok': break
    }

    // Post-tx: seeds the sync cursor. Safe even before Task 19 creates the first agent — routing finds
    // none and nothing is ingested — and re-enqueuing on the idempotent second call above is harmless
    // (singletonKey dedupes it).
    await ctx.deps.enqueue(JOB_NAMES.mailboxSync, { orgId: ctx.orgId, connectionId: outcome.connectionId }, { entityId: outcome.connectionId })
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
})
