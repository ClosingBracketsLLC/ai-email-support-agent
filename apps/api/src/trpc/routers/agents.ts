/**
 * `agents.list` / `update` / `categories` — Task 19's slice. Mode editing per (agent, category)
 * arrives with Phase 5's autonomy screen; `categories` here is read-only, returning the rows
 * `mailboxes.addAddress` already seeded (one per org category, mode 'review').
 */
import { TRPCError } from '@trpc/server'
import { and, asc, eq } from 'drizzle-orm'
import { AgentIdInput, UpdateAgentInput } from '@aesa/contracts'
import { agentCategoryPolicies, agents, audit, categories, mailboxConnections } from '@aesa/db'
import { managerProcedure, orgProcedure, router } from '../init.ts'

/** Owner-authored free text (personaText/guidanceExtra/signature can run to thousands of characters) —
 * the audit row logs a length, never the body. Everything else changed by this input is short and
 * structured enough to log as-is (an enum, a number, a boolean-shaped nullable email, a short label). */
const FREEFORM_TEXT_KEYS = new Set<keyof UpdateAgentInput>(['signature', 'personaText', 'guidanceExtra'])

function auditValue(key: keyof UpdateAgentInput, value: unknown): unknown {
  return FREEFORM_TEXT_KEYS.has(key) && typeof value === 'string' ? { length: value.length } : value
}

const UPDATABLE_KEYS = ['displayName', 'signature', 'personaPreset', 'personaText', 'guidanceExtra', 'priority', 'replyFromAddress', 'status'] as const

export const agentsRouter = router({
  /**
   * `connectionEmailAddress` (one join, no leak — same org's own connection) lets the app render and
   * set `replyFromAddress` without a second round-trip: an alias agent's only two valid values are
   * `null` (sends as itself) and this connection's own address (review fix, Important 1 — the reply-
   * from radios were previously display-only with no way to actually flip the choice).
   */
  list: orgProcedure.query(async ({ ctx }) => {
    const rows = await ctx.deps.api.withOrg(ctx.orgId, (tx) =>
      tx.select({
        id: agents.id, connectionId: agents.connectionId, address: agents.address, replyFromAddress: agents.replyFromAddress,
        connectionEmailAddress: mailboxConnections.emailAddress,
        domain: agents.domain, displayName: agents.displayName, signature: agents.signature, personaPreset: agents.personaPreset,
        personaText: agents.personaText, guidanceExtra: agents.guidanceExtra, priority: agents.priority, status: agents.status,
        autoSendDelayMin: agents.autoSendDelayMin,
      })
        .from(agents)
        .innerJoin(mailboxConnections, eq(mailboxConnections.id, agents.connectionId))
        .where(eq(agents.orgId, ctx.orgId))
        .orderBy(asc(agents.connectionId), asc(agents.priority)),
    )
    return { agents: rows }
  }),

  /**
   * In-org lookup by id — a cross-org agentId is NOT_FOUND by construction (RLS hides the row before
   * this ever sees it). `status` may change ONLY when the agent is NOT consent-gated AND its current
   * status is already `active` or `disabled` — review fix (Critical): a `pending_verification` agent
   * is untouchable by `status` in EITHER direction here, closing the two-hop path that used to
   * resurrect one (set it `disabled` first, a no-op-looking call that this endpoint used to allow
   * from `pending_verification`, then `active` next, which the direct check alone caught — but only
   * on the SECOND call). A consent-gated agent is refused regardless of its current status: consent,
   * not verification, is what's outstanding, and this endpoint has no business deciding either one.
   */
  update: managerProcedure.input(UpdateAgentInput).mutation(async ({ ctx, input }) => {
    await ctx.deps.api.withOrg(ctx.orgId, async (tx) => {
      const [agent] = await tx.select().from(agents).where(and(eq(agents.orgId, ctx.orgId), eq(agents.id, input.agentId)))
      if (!agent) throw new TRPCError({ code: 'NOT_FOUND', message: 'agent not found' })
      if (input.status !== undefined) {
        if (agent.consentRequiredFromUserId) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'this agent is waiting on the connecting user\'s consent; its status cannot be changed until then' })
        }
        if (agent.status !== 'active' && agent.status !== 'disabled') {
          // The direct case (target 'active'): unchanged code/message from before this fix — a
          // `pending_verification` agent hasn't proved it controls its address yet. Every OTHER
          // target (chiefly 'disabled') is the two-hop resurrection this fix closes: setting a
          // pending agent 'disabled' used to succeed outright, silently satisfying the direct
          // check's "already active or disabled" condition for a LATER call that then set it
          // 'active' — so that path is refused too, as FORBIDDEN (this is a real permission
          // boundary, not a transient precondition the caller can just wait out).
          if (input.status === 'active') {
            throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'cannot activate an agent that has not completed address verification' })
          }
          throw new TRPCError({ code: 'FORBIDDEN', message: 'cannot change status on an agent that has not completed address verification' })
        }
      }

      const patch: Record<string, unknown> = {}
      const changed: Record<string, unknown> = {}
      for (const key of UPDATABLE_KEYS) {
        const value = input[key]
        if (value === undefined) continue
        patch[key] = value
        changed[key] = auditValue(key, value)
      }
      if (Object.keys(patch).length === 0) return

      await tx.update(agents).set(patch).where(eq(agents.id, agent.id))
      await audit(tx, { actor: ctx.actor, action: 'agent.updated', entityType: 'agent', entityId: agent.id, detail: changed, ip: ctx.ip, userAgent: ctx.userAgent })
    })
    return { ok: true as const }
  }),

  categories: orgProcedure.input(AgentIdInput).query(async ({ ctx, input }) =>
    ctx.deps.api.withOrg(ctx.orgId, async (tx) => ({
      categories: await tx.select({ categoryId: categories.id, key: categories.key, label: categories.label, mode: agentCategoryPolicies.mode })
        .from(agentCategoryPolicies)
        .innerJoin(categories, eq(categories.id, agentCategoryPolicies.categoryId))
        .where(and(eq(agentCategoryPolicies.orgId, ctx.orgId), eq(agentCategoryPolicies.agentId, input.agentId)))
        .orderBy(asc(categories.key)),
    })),
  ),
})
