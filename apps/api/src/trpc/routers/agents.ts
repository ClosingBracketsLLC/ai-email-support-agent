/**
 * `agents.list` / `update` / `categories` / `setCategoryPolicy` — the agent settings screens, and
 * (Phase 5) the Autopilot one. `categories` is the whole Autopilot payload for one agent: the policy
 * row per category with its threshold and its graduation/demotion trail, the cold-start counter, and
 * the 30-day stats `stats.rollup` writes. `setCategoryPolicy` is the switch itself — the ONE place an
 * owner can put a category on `auto`, and the only gate in front of that is the cold-start lock.
 */
import { TRPCError } from '@trpc/server'
import { and, asc, count, eq, gte, isNotNull, sql, sum } from 'drizzle-orm'
import {
  AgentIdInput, DEFAULT_AUTO_SEND_THRESHOLD, SandboxOutputView, SandboxRunInput, SandboxStartInput,
  SetCategoryPolicyInput, UpdateAgentInput,
} from '@aesa/contracts'
import { COLD_START_DECISIONS, resolveSetting } from '@aesa/core'
import {
  agentCategoryPolicies, agentRuns, agents, audit, bumpMeter, categories, countHumanDecisions, drafts, mailboxConnections,
  categoryStatsDaily, resolveModelConfig, SANDBOX_METERS, usageCounters,
} from '@aesa/db'
import { JOB_NAMES } from '@aesa/queue'
import { loadOrgSettings } from '../../org-settings.ts'
import { managerProcedure, orgProcedure, router } from '../init.ts'

const utcDayString = (d: Date): string => d.toISOString().slice(0, 10)

/** The window `agents.categories` reports over — the Autopilot screen's "last 30 days" block. */
const STATS_WINDOW_DAYS = 30

/** Owner-authored free text (personaText/guidanceExtra/signature can run to thousands of characters) —
 * the audit row logs a length, never the body. Everything else changed by this input is short and
 * structured enough to log as-is (an enum, a number, a boolean-shaped nullable email, a short label). */
const FREEFORM_TEXT_KEYS = new Set<keyof UpdateAgentInput>(['signature', 'personaText', 'guidanceExtra'])

function auditValue(key: keyof UpdateAgentInput, value: unknown): unknown {
  return FREEFORM_TEXT_KEYS.has(key) && typeof value === 'string' ? { length: value.length } : value
}

const UPDATABLE_KEYS = [
  'displayName', 'signature', 'personaPreset', 'personaText', 'guidanceExtra', 'priority', 'replyFromAddress', 'status',
  // Phase 5's two agent-wide autonomy knobs: whether a category may graduate itself once the
  // evidence is there, and how long an auto-send waits before it goes (the owner's Hold window).
  'autoGraduate', 'autoSendDelayMin',
] as const

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
        autoGraduate: agents.autoGraduate, autoSendDelayMin: agents.autoSendDelayMin,
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

  /**
   * The Autopilot screen's whole payload for one agent, in four queries: the policy rows joined to
   * their categories, the per-category count of decisions a HUMAN made (what the cold-start lock
   * reads — an auto-send has no `decided_by`), and the 30-day stats summed out of
   * `category_stats_daily`. `coldStartAt` travels with it so the app never hard-codes the 10.
   *
   * Read-only and `orgProcedure`: seeing how the agent is doing is every teammate's business;
   * changing it is `setCategoryPolicy`'s, which is a `managerProcedure`.
   */
  categories: orgProcedure.input(AgentIdInput).query(async ({ ctx, input }) =>
    ctx.deps.api.withOrg(ctx.orgId, async (tx) => {
      const [agent] = await tx.select({ autoGraduate: agents.autoGraduate, autoSendDelayMin: agents.autoSendDelayMin })
        .from(agents).where(and(eq(agents.orgId, ctx.orgId), eq(agents.id, input.agentId)))
      if (!agent) throw new TRPCError({ code: 'NOT_FOUND', message: 'agent not found' })

      const rows = await tx.select({
        categoryId: categories.id, key: categories.key, label: categories.label,
        mode: agentCategoryPolicies.mode, autoSendMinConfidence: agentCategoryPolicies.autoSendMinConfidence,
        graduatedAt: agentCategoryPolicies.graduatedAt, demotedAt: agentCategoryPolicies.demotedAt,
        demotedReason: agentCategoryPolicies.demotedReason,
        suggestedAt: agentCategoryPolicies.suggestedAt, suggestedWouldSend: agentCategoryPolicies.suggestedWouldSend,
        suggestedOf: agentCategoryPolicies.suggestedOf,
      })
        .from(agentCategoryPolicies)
        .innerJoin(categories, eq(categories.id, agentCategoryPolicies.categoryId))
        .where(and(eq(agentCategoryPolicies.orgId, ctx.orgId), eq(agentCategoryPolicies.agentId, input.agentId)))
        .orderBy(asc(categories.key))

      const decisions = await tx.select({ categoryId: drafts.categoryId, value: count() })
        .from(drafts)
        .where(and(eq(drafts.orgId, ctx.orgId), eq(drafts.agentId, input.agentId), isNotNull(drafts.decidedBy)))
        .groupBy(drafts.categoryId)
      const decisionsByCategory = new Map(decisions.map((d) => [d.categoryId, d.value]))

      const since = utcDayString(new Date(Date.now() - STATS_WINDOW_DAYS * 86_400_000))
      const stats = await tx.select({
        categoryId: categoryStatsDaily.categoryId,
        drafted: sum(categoryStatsDaily.drafted), approvedUnchanged: sum(categoryStatsDaily.approvedUnchanged),
        approvedEdited: sum(categoryStatsDaily.approvedEdited), rejected: sum(categoryStatsDaily.rejected),
        autoSent: sum(categoryStatsDaily.autoSent), autoSentFlagged: sum(categoryStatsDaily.autoSentFlagged),
        held: sum(categoryStatsDaily.held),
      })
        .from(categoryStatsDaily)
        .where(and(
          eq(categoryStatsDaily.orgId, ctx.orgId), eq(categoryStatsDaily.agentId, input.agentId),
          gte(categoryStatsDaily.day, since),
        ))
        .groupBy(categoryStatsDaily.categoryId)
      const statsByCategory = new Map(stats.map((row) => [row.categoryId, row]))

      return {
        agent: { autoGraduate: agent.autoGraduate, autoSendDelayMin: agent.autoSendDelayMin },
        coldStartAt: COLD_START_DECISIONS,
        categories: rows.map((row) => {
          const s = statsByCategory.get(row.categoryId)
          return {
            categoryId: row.categoryId, key: row.key, label: row.label, mode: row.mode,
            autoSendMinConfidence: row.autoSendMinConfidence,
            humanDecisionCount: decisionsByCategory.get(row.categoryId) ?? 0,
            graduatedAt: row.graduatedAt, demotedAt: row.demotedAt, demotedReason: row.demotedReason,
            // Only a complete suggestion is one: `stats.rollup` writes all three columns together.
            suggestion: row.suggestedAt && row.suggestedWouldSend !== null && row.suggestedOf !== null
              ? { wouldSend: row.suggestedWouldSend, of: row.suggestedOf, at: row.suggestedAt }
              : null,
            stats30d: {
              drafted: Number(s?.drafted ?? 0), approvedUnchanged: Number(s?.approvedUnchanged ?? 0),
              approvedEdited: Number(s?.approvedEdited ?? 0), rejected: Number(s?.rejected ?? 0),
              autoSent: Number(s?.autoSent ?? 0), autoSentFlagged: Number(s?.autoSentFlagged ?? 0),
              held: Number(s?.held ?? 0),
            },
          }
        }),
      }
    }),
  ),

  /**
   * The Autopilot switch. Three preconditions, all of them about the ONE direction that matters —
   * putting a category on `auto`:
   *  - the agent must exist in this org (NOT_FOUND, by construction: RLS hides another org's row);
   *  - it must be `active` — an agent that cannot send has no business auto-sending (`agent_inactive`);
   *  - the cold-start lock: fewer than `COLD_START_DECISIONS` HUMAN decisions in this category and the
   *    answer is `cold_start`. It is the same floor `decide()` enforces on every draft, so lifting it
   *    here would only produce drafts that fall back to review anyway.
   * `review` and `off` pass all three untested: taking autonomy AWAY is always allowed.
   *
   * The threshold falls back to whatever the policy already carried, then to the balanced default, so
   * a re-graduation keeps the owner's number. `graduated_at` is cut only on the way IN to auto, and
   * the graduation suggestion is cleared with it — it has been acted on.
   */
  setCategoryPolicy: managerProcedure.input(SetCategoryPolicyInput).mutation(async ({ ctx, input }) => {
    const now = new Date()
    await ctx.deps.api.withOrg(ctx.orgId, async (tx) => {
      const [agent] = await tx.select({ id: agents.id, status: agents.status })
        .from(agents).where(and(eq(agents.orgId, ctx.orgId), eq(agents.id, input.agentId)))
      if (!agent) throw new TRPCError({ code: 'NOT_FOUND', message: 'agent not found' })
      if (input.mode === 'auto' && agent.status !== 'active') {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'agent_inactive' })
      }

      // Locked for the whole read-modify-write: `demoteCategory` (the worker's backstop, and the
      // inline check the draft service runs on every reject/flag) takes this same row's lock on its
      // guarded `auto → review` UPDATE, so without this an owner's switch could read `auto`, wait,
      // and then write back a `graduated_at` (or a mode) over a demotion that landed in between.
      const [policy] = await tx.select({
        mode: agentCategoryPolicies.mode, autoSendMinConfidence: agentCategoryPolicies.autoSendMinConfidence,
        graduatedAt: agentCategoryPolicies.graduatedAt,
      })
        .from(agentCategoryPolicies)
        .where(and(
          eq(agentCategoryPolicies.orgId, ctx.orgId), eq(agentCategoryPolicies.agentId, input.agentId),
          eq(agentCategoryPolicies.categoryId, input.categoryId),
        ))
        .limit(1)
        .for('update')
      if (!policy) throw new TRPCError({ code: 'NOT_FOUND', message: 'category policy not found' })

      if (input.mode === 'auto') {
        const humanDecisionCount = await countHumanDecisions(tx, input.agentId, input.categoryId)
        if (humanDecisionCount < COLD_START_DECISIONS) {
          throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'cold_start', cause: { humanDecisionCount } })
        }
      }

      const enteringAuto = input.mode === 'auto' && policy.mode !== 'auto'
      const autoSendMinConfidence = input.autoSendMinConfidence ?? policy.autoSendMinConfidence ?? DEFAULT_AUTO_SEND_THRESHOLD
      await tx.update(agentCategoryPolicies)
        .set({
          mode: input.mode, autoSendMinConfidence,
          graduatedAt: enteringAuto ? now : policy.graduatedAt,
          ...(enteringAuto ? { suggestedAt: null, suggestedWouldSend: null, suggestedOf: null } : {}),
        })
        .where(and(
          eq(agentCategoryPolicies.orgId, ctx.orgId), eq(agentCategoryPolicies.agentId, input.agentId),
          eq(agentCategoryPolicies.categoryId, input.categoryId),
        ))

      await audit(tx, {
        actor: ctx.actor, action: 'autonomy.policy_updated', entityType: 'agent', entityId: input.agentId,
        detail: { categoryId: input.categoryId, mode: input.mode, autoSendMinConfidence },
        ip: ctx.ip, userAgent: ctx.userAgent,
      })
    })
    return { ok: true as const }
  }),

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

      const settings = await loadOrgSettings(tx, ['sandbox.daily_cap'])
      const cap = resolveSetting('sandbox.daily_cap', { org: settings })

      const [counter] = await tx.select({ value: usageCounters.value }).from(usageCounters)
        .where(and(eq(usageCounters.orgId, ctx.orgId), eq(usageCounters.day, day), eq(usageCounters.meter, SANDBOX_METERS.runs)))
      if ((counter?.value ?? 0) >= cap) {
        throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: 'sandbox.daily_cap reached for today' })
      }

      // Phase 6: the agent's own choice, through the SAME reader the worker resolves with. The job
      // re-resolves and restamps these before it calls — an owner can change the model between the
      // click and the run — but the row must never claim Managed AI for a BYOK agent even for a moment.
      const cfg = await resolveModelConfig(tx, input.agentId, 'draft')
      const [run] = await tx.insert(agentRuns).values({
        orgId: ctx.orgId, kind: 'sandbox', agentId: input.agentId, provider: cfg.provider, model: cfg.model,
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
