/**
 * `agents.list` / `update` / `categories` — Task 19's slice. Mode editing per (agent, category)
 * arrives with Phase 5's autonomy screen; `categories` here is read-only, returning the rows
 * `mailboxes.addAddress` already seeded (one per org category, mode 'review').
 */
import { TRPCError } from '@trpc/server'
import { and, asc, eq } from 'drizzle-orm'
import { AgentIdInput, UpdateAgentInput } from '@aesa/contracts'
import { agentCategoryPolicies, agents, audit, categories } from '@aesa/db'
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
  list: orgProcedure.query(async ({ ctx }) => {
    const rows = await ctx.deps.api.withOrg(ctx.orgId, (tx) =>
      tx.select({
        id: agents.id, connectionId: agents.connectionId, address: agents.address, replyFromAddress: agents.replyFromAddress,
        domain: agents.domain, displayName: agents.displayName, signature: agents.signature, personaPreset: agents.personaPreset,
        personaText: agents.personaText, guidanceExtra: agents.guidanceExtra, priority: agents.priority, status: agents.status,
        autoSendDelayMin: agents.autoSendDelayMin,
      })
        .from(agents)
        .where(eq(agents.orgId, ctx.orgId))
        .orderBy(asc(agents.connectionId), asc(agents.priority)),
    )
    return { agents: rows }
  }),

  /** In-org lookup by id — a cross-org agentId is NOT_FOUND by construction (RLS hides the row before
   * this ever sees it). `status: 'active'` is refused unless the agent is already `active` or
   * `disabled`: a `pending_verification` agent has neither proved it controls its address nor cleared
   * its consent gate, and this endpoint has no business short-circuiting either. */
  update: managerProcedure.input(UpdateAgentInput).mutation(async ({ ctx, input }) => {
    await ctx.deps.api.withOrg(ctx.orgId, async (tx) => {
      const [agent] = await tx.select().from(agents).where(and(eq(agents.orgId, ctx.orgId), eq(agents.id, input.agentId)))
      if (!agent) throw new TRPCError({ code: 'NOT_FOUND', message: 'agent not found' })
      if (input.status === 'active' && agent.status !== 'active' && agent.status !== 'disabled') {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'cannot activate an agent that has not completed address verification' })
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
