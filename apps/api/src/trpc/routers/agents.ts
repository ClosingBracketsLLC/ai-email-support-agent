/**
 * `agents.list` / `update` / `categories` — Task 19's slice. Mode editing per (agent, category)
 * arrives with Phase 5's autonomy screen; `categories` here is read-only, returning the rows
 * `mailboxes.addAddress` already seeded (one per org category, mode 'review').
 */
import { TRPCError } from '@trpc/server'
import { and, asc, eq, sql } from 'drizzle-orm'
import { AgentIdInput, DRAFT_MODEL_ID, SandboxOutputView, SandboxRunInput, SandboxStartInput, UpdateAgentInput } from '@aesa/contracts'
import { resolveSetting, type SettingKey } from '@aesa/core'
import {
  agentCategoryPolicies, agentRuns, agents, audit, bumpMeter, categories, mailboxConnections, orgSettings,
  SANDBOX_METERS, usageCounters,
} from '@aesa/db'
import { JOB_NAMES } from '@aesa/queue'
import { managerProcedure, orgProcedure, router } from '../init.ts'

const utcDayString = (d: Date): string => d.toISOString().slice(0, 10)

/** Mirrors the worker's `buildOrgSettings` (apps/worker/src/jobs/ticket-draft.ts) — turns the
 * `org_settings` rows for one key into the map `resolveSetting` expects. */
function buildOrgSettings(rows: { key: string; value: unknown }[]): Partial<Record<SettingKey, unknown>> {
  const out: Partial<Record<SettingKey, unknown>> = {}
  for (const row of rows) out[row.key as SettingKey] = row.value
  return out
}

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

  /**
   * The owner's "Try it" — one hand-typed question through the real draft pipeline, against a
   * synthetic thread (`apps/worker/src/jobs/agent-sandbox.ts` does the actual model call; this
   * procedure only ever inserts the `agent_runs` row and enqueues it). The cap check, the insert and
   * the meter bump are ONE transaction, fail-closed: the cap is read and compared BEFORE the insert,
   * so a capped org never gets a `running` row at all. Under READ COMMITTED that alone still lets two
   * concurrent calls both read the counter before either writes — an org-scoped
   * `pg_advisory_xact_lock`, the FIRST statement of the transaction, serializes them (same shape as
   * the worker's draft gate, `apps/worker/src/drafting/caps.ts`'s `gateAndRecordRun`).
   */
  sandboxStart: orgProcedure.input(SandboxStartInput).mutation(async ({ ctx, input }) => {
    const now = new Date()
    const day = utcDayString(now)

    const runId = await ctx.deps.api.withOrg(ctx.orgId, async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`sandbox-gate:${ctx.orgId}`}))`)

      const [agent] = await tx.select({ status: agents.status }).from(agents)
        .where(and(eq(agents.orgId, ctx.orgId), eq(agents.id, input.agentId)))
      if (!agent || agent.status !== 'active') {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'agent is not active' })
      }

      // The `orgId` predicate is a brace, not the lock: RLS already scopes this read. It is here
      // because every other read in this file carries it, and because a table that ever landed in
      // `RLS_EXEMPT`'s list would otherwise silently read another org's cap (fix wave A5, final-C M3).
      const settingsRows = await tx.select({ key: orgSettings.key, value: orgSettings.value })
        .from(orgSettings).where(and(eq(orgSettings.orgId, ctx.orgId), eq(orgSettings.key, 'sandbox.daily_cap')))
      const cap = resolveSetting('sandbox.daily_cap', { org: buildOrgSettings(settingsRows) })

      const [counter] = await tx.select({ value: usageCounters.value }).from(usageCounters)
        .where(and(eq(usageCounters.orgId, ctx.orgId), eq(usageCounters.day, day), eq(usageCounters.meter, SANDBOX_METERS.runs)))
      if ((counter?.value ?? 0) >= cap) {
        throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: 'sandbox.daily_cap reached for today' })
      }

      const [run] = await tx.insert(agentRuns).values({
        orgId: ctx.orgId, kind: 'sandbox', agentId: input.agentId, provider: 'anthropic', model: DRAFT_MODEL_ID,
        status: 'running', input: { subject: input.subject, question: input.question },
      }).returning({ id: agentRuns.id })

      await bumpMeter(tx, ctx.orgId, day, SANDBOX_METERS.runs, 1)

      await audit(tx, {
        actor: ctx.actor, action: 'agent.sandbox_started', entityType: 'agent_run', entityId: run!.id,
        detail: { runId: run!.id, questionLen: input.question.length }, ip: ctx.ip, userAgent: ctx.userAgent,
      })
      return run!.id
    })

    const jobId = await ctx.deps.enqueue(JOB_NAMES.agentSandbox, { orgId: ctx.orgId, runId }, { entityId: runId })
    if (jobId === null) {
      // No backstop sweep exists for a sandbox run (unlike ticket.draft/send.execute) — this run
      // would otherwise sit `running` forever with the owner staring at a spinner. Fail it outright;
      // the client reads this back through sandboxGet.
      await ctx.deps.api.withOrg(ctx.orgId, (tx) =>
        tx.update(agentRuns).set({ status: 'failed', errorCode: 'enqueue_failed', finishedAt: new Date() })
          .where(and(eq(agentRuns.id, runId), eq(agentRuns.status, 'running'))),
      )
    }
    return { runId }
  }),

  /** The sandbox panel's poll target. The stored `output` is parsed defensively — an unparsable value
   * (should never happen, but the api must never 500 over stored JSON it didn't validate on the way in). */
  sandboxGet: orgProcedure.input(SandboxRunInput).query(async ({ ctx, input }) => {
    const row = await ctx.deps.api.withOrg(ctx.orgId, async (tx) => {
      const [r] = await tx.select({
        status: agentRuns.status, output: agentRuns.output, errorCode: agentRuns.errorCode,
        startedAt: agentRuns.startedAt, finishedAt: agentRuns.finishedAt,
      })
        .from(agentRuns)
        .where(and(eq(agentRuns.orgId, ctx.orgId), eq(agentRuns.id, input.runId), eq(agentRuns.kind, 'sandbox')))
      return r ?? null
    })
    if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'sandbox run not found' })

    const parsed = SandboxOutputView.safeParse(row.output)
    return {
      status: row.status, output: parsed.success ? parsed.data : null,
      errorCode: row.errorCode, startedAt: row.startedAt, finishedAt: row.finishedAt,
    }
  }),
})
