/**
 * The `ticket.draft` job (spec §Draft): one drafting run for one ticket — claim, caps, the
 * six-layer prompt, the model call, the guardrails with ONE automatic redraft, `decide()`, and the
 * draft/notification/run/watermark writes.
 *
 * Ported from doge-buddy's `apps/ops/src/jobs/support-agent-run.ts` (`executeSupportAgentRun`'s
 * pinned step order and `runAndHandleOutcome`'s outcome table), adapted to this codebase's
 * `withOrg` transactions, `needs_owner` naming, `drafts` rows and `agent_runs` bookkeeping. The
 * step ORDER below is the correctness — see `drafting/caps.ts` for why the caps are read twice
 * (once unlocked before the claim, once under the org's advisory lock) and `drafting/claim.ts` for
 * the three watermarks the claim turns on.
 *
 * **Every database touch is a short `withOrg` transaction, and the model call, the retrieval call
 * and the watchdog wait all happen OUTSIDE every one of them** — the app role's 5 s
 * idle-in-transaction timeout would turn a slow model call into a killed connection. The api never
 * runs any of this: drafting is worker-only.
 */
import { and, asc, count, desc, eq, gte, inArray, isNotNull } from 'drizzle-orm'
import type PgBoss from 'pg-boss'
import type pino from 'pino'
import { z } from 'zod'
import {
  createUsageAccumulator, guidanceBlock, personaBlock, platformRulesBlock, runDraftCall,
  THREAD_BODY_MAX_CHARS, withWatchdog, workspaceProfileBlock, DRAFT_MODEL,
  type DraftCallResult, type DraftDecision, type DraftPromptInput, type EscalateReason,
  type RetrievedAnswer, type RetrievedChunk, type Retriever, type ThreadMessage, type WorkspaceProfile,
} from '@aesa/agent'
import type { PersonaPreset, Tone } from '@aesa/contracts'
import {
  buildWorkspacePolicy, COLD_START_DECISIONS, collectGroundedNumbers, decide, INVARIANTS,
  resolveSetting, validateReplyBody, type GuardrailResult, type SettingKey,
} from '@aesa/core'
import {
  agentCategoryPolicies, agentRuns, agents, audit, categories, drafts, escalateTicket, mailboxConnections,
  messages, notifications, orgSettings, platformState, tickets, withOrg, workspaces,
  type Db, type OrgTx,
} from '@aesa/db'
import { computeCostMicros, findPricing, LlmError, type ChatMeta, type LlmProvider } from '@aesa/llm'
import { defineJob, enqueue, JOB_NAMES, registerJob, type JobDefinition } from '@aesa/queue'
import { utcDayString } from '../date-utils.ts'
import { gateAndRecordRun, readCapsUnlocked } from '../drafting/caps.ts'
import { claimTicket, recordFailure, unwindClaimStamp, type ClaimedTicket } from '../drafting/claim.ts'
import {
  applyDraftOutcome, applyEscalateOutcome, applyNoReplyOutcome, DRAFT_ACTOR, LostRaceError, recordLostRace,
  type DraftLanding, type OutcomeContext,
} from '../drafting/outcomes.ts'
import { appendRunEvent, finishRun } from '../drafting/runs.ts'

/**
 * Spec §Budgets: $0.40 of managed spend per run. Past it the automatic redraft after a guardrail
 * failure is skipped — the owner gets the blocked body plus the findings instead, which is the same
 * end state a second failing attempt would have produced, for half the money.
 */
export const STOP_LOSS_MICROS = 400_000

/**
 * Spec §Prompt blocks → caching: the per-org/agent 5-minute breakpoint only pays for its write cost
 * above roughly this many drafts an hour. Below it the agent blocks ride uncached and only the
 * cross-tenant static prefix caches.
 */
export const DRAFT_RATE_FOR_AGENT_CACHE = 12

/** The window `DRAFT_RATE_FOR_AGENT_CACHE` is measured over. */
const AGENT_CACHE_WINDOW_MS = 60 * 60_000

/** How long an `org_busy` refusal waits before the job re-enqueues itself. */
const ORG_BUSY_RETRY_MS = 30_000

/** The once-per-org-per-day page when the whole workspace has spent its daily model budget. */
const LLM_CAP_TITLE = 'Daily AI budget reached'
const LLM_CAP_BODY = "Today's AI budget for this workspace is used up. Drafting starts again after midnight UTC."

/**
 * One audit-facing sentence per `escalate` reason the model can return. `escalateTicket`'s
 * owner-facing copy is keyed by the `needs_owner` reason (always `agent_escalated` here), so this
 * is what preserves WHICH judgment the model actually made, in the audit detail and the run output.
 */
export const AGENT_ESCALATE_REASON_DETAIL: Record<EscalateReason, string> = {
  needs_human_judgment: 'the agent judged this one needs a person',
  policy_conflict: 'the thread conflicts with the operating guidance',
  legal_or_safety: 'the thread touches a legal threat, an injury or a safety concern',
  angry_customer: 'the customer is angry',
  insufficient_knowledge: 'the agent had nothing it could ground an answer in',
  requested_human: 'the customer asked to speak to a person',
  other: 'the agent asked for a human',
}

/** Rule 10: a provider refusal is `content_filtered`, and with no body there is nothing to review. */
const CONTENT_FILTERED_DETAIL = 'content_filtered'

export const TicketDraftPayload = z.object({ orgId: z.string(), ticketId: z.string() })
export type TicketDraftPayload = z.infer<typeof TicketDraftPayload>

/**
 * The importable definition: producers (`ticket.triage`'s `triaged` outcome, this job's own
 * `org_busy` re-enqueue, Task 12's redraft and Task 14's backstop sweep) `enqueue()` against this —
 * which only ever reads `.name`/`.schema`. `registerTicketDraft` builds the deps-bound definition.
 *
 * `retryLimit: 1`: a failed attempt already counted a failure and cleared its claim stamp, so the
 * one retry can claim immediately; past that the ticket's own failure ceiling (2) escalates it.
 */
export const ticketDraftJob: JobDefinition<TicketDraftPayload> = defineJob({
  name: JOB_NAMES.ticketDraft,
  schema: TicketDraftPayload,
  queue: { expireInSeconds: INVARIANTS.DRAFT_JOB_EXPIRE_SECONDS, retryLimit: 1, retryDelay: 30, retryBackoff: true },
  handler: async () => {
    throw new Error('ticket.draft: this definition has no bound deps — register it through registerTicketDraft(boss, deps)')
  },
})

export interface TicketDraftDeps {
  db: Db
  provider: LlmProvider
  retriever: Retriever
  logger: pino.Logger
  /** index.ts wires this to `enqueueNotifyDispatch`. */
  enqueueNotify: (orgId: string, notificationId: string) => Promise<void>
  /** Self re-enqueue for `org_busy` (startAfter +30 s) and the backstop; index.ts wires `enqueueTicketDraft`. */
  enqueueDraft: (orgId: string, ticketId: string, opts?: { startAfter?: Date }) => Promise<void>
  now?: () => Date
  /** Test seam: the watchdog budget for the WHOLE run (default `INVARIANTS.DRAFT_WATCHDOG_SECONDS`). */
  watchdogMs?: number
}

export async function registerTicketDraft(boss: PgBoss, deps: TicketDraftDeps): Promise<void> {
  const wired: JobDefinition<TicketDraftPayload> = {
    ...ticketDraftJob,
    handler: async (ctx) => {
      await runTicketDraft(deps, ctx.data, ctx.signal)
    },
  }
  await registerJob(boss, wired)
}

export async function enqueueTicketDraft(boss: PgBoss, orgId: string, ticketId: string, opts?: { startAfter?: Date }): Promise<void> {
  await enqueue(boss, ticketDraftJob, { orgId, ticketId }, { entityId: ticketId, ...(opts?.startAfter ? { startAfter: opts.startAfter } : {}) })
}

// -- Rule 1/2: the pre-claim read --

const AGENT_COLUMNS = {
  id: agents.id,
  address: agents.address,
  replyFromAddress: agents.replyFromAddress,
  domain: agents.domain,
  displayName: agents.displayName,
  personaPreset: agents.personaPreset,
  personaText: agents.personaText,
  guidanceExtra: agents.guidanceExtra,
  status: agents.status,
}
type AgentRow = { [K in keyof typeof AGENT_COLUMNS]: (typeof agents.$inferSelect)[K] }

interface PreClaim {
  agent: AgentRow | null
  settings: Partial<Record<SettingKey, unknown>>
  caps: { ticketRunsToday: number; orgCostMicrosToday: number; orgDraftsToday: number }
}

function buildOrgSettings(rows: { key: string; value: unknown }[]): Partial<Record<SettingKey, unknown>> {
  const out: Partial<Record<SettingKey, unknown>> = {}
  for (const row of rows) out[row.key as SettingKey] = row.value
  return out
}

/**
 * ONE read-only transaction covering rules 1-3's inputs: the platform kill lever, the ticket's
 * selectability, the agent, the org's cap settings and today's unlocked counts. Returns null for
 * every "this job has nothing to do" case (the lever is on, the ticket is gone, or it is not
 * `triaged`) — all three are policy no-ops that must write nothing at all.
 */
async function loadPreClaim(db: Db, orgId: string, ticketId: string, now: Date): Promise<PreClaim | null> {
  return withOrg(db, orgId, async (tx) => {
    const [lever] = await tx.select({ value: platformState.value }).from(platformState).where(eq(platformState.key, 'killswitch.global'))
    if (lever?.value === true) return null

    const [ticket] = await tx
      .select({ id: tickets.id, status: tickets.status, agentId: tickets.agentId, connectionId: tickets.connectionId })
      .from(tickets)
      .where(eq(tickets.id, ticketId))
    if (!ticket || ticket.status !== 'triaged') return null

    // The ticket's own agent when routing already picked one, else the connection's first `active`
    // agent by priority (the same order `agents_org_connection_idx` is built on).
    const [agent] = ticket.agentId
      ? await tx.select(AGENT_COLUMNS).from(agents).where(eq(agents.id, ticket.agentId)).limit(1)
      : await tx
          .select(AGENT_COLUMNS)
          .from(agents)
          .where(and(eq(agents.connectionId, ticket.connectionId), eq(agents.status, 'active')))
          .orderBy(asc(agents.priority), asc(agents.createdAt))
          .limit(1)

    const settingsRows = await tx
      .select({ key: orgSettings.key, value: orgSettings.value })
      .from(orgSettings)
      .where(inArray(orgSettings.key, ['autonomy.daily_draft_cap', 'autonomy.daily_llm_usd_cap']))
    const settings = buildOrgSettings(settingsRows)

    return { agent: agent ?? null, settings, caps: await readCapsUnlocked(tx, { orgId, ticketId, settings, now }) }
  })
}

// -- Rule 3: the cap exits --

/** The per-ticket daily ceiling. Reason-scoped dedupe key: a cap hit is materially different from
 * whatever else escalated this ticket today, and must still page. */
async function escalateRunCapped(deps: TicketDraftDeps, orgId: string, ticketId: string, day: string, now: Date, runsToday: number): Promise<void> {
  const notificationId = await withOrg(deps.db, orgId, async (tx) => {
    const { notificationId } = await escalateTicket(tx, {
      orgId, ticketId, fromStatus: 'triaged', reason: 'agent_run_cap', day, now,
      dedupeKey: `agent_run_cap:${ticketId}:${day}`, actor: DRAFT_ACTOR, auditAction: 'ticket.escalated',
      detail: { runsToday },
    })
    return notificationId
  })
  if (notificationId) await deps.enqueueNotify(orgId, notificationId)
}

/**
 * The org-wide daily budget. The ticket is left completely untouched — no stamp, no status change —
 * so it is selectable again after UTC midnight; the owner gets ONE page per org per day, keyed on
 * the day, with an empty payload (there is no one ticket to deep-link to).
 */
async function notifyOrgCapped(deps: TicketDraftDeps, orgId: string, day: string): Promise<void> {
  const notificationId = await withOrg(deps.db, orgId, async (tx) => {
    const [row] = await tx
      .insert(notifications)
      .values({ orgId, kind: 'escalation', title: LLM_CAP_TITLE, body: LLM_CAP_BODY, dedupeKey: `llm_cap:${orgId}:${day}`, payload: {} })
      .onConflictDoNothing({ target: notifications.dedupeKey })
      .returning({ id: notifications.id })
    return row?.id
  })
  if (notificationId) await deps.enqueueNotify(orgId, notificationId)
}

function orgCapReached(settings: Partial<Record<SettingKey, unknown>>, caps: PreClaim['caps']): boolean {
  const draftCap = resolveSetting('autonomy.daily_draft_cap', { org: settings })
  const usdCap = resolveSetting('autonomy.daily_llm_usd_cap', { org: settings })
  return caps.orgDraftsToday >= draftCap || caps.orgCostMicrosToday >= Math.round(usdCap * 1_000_000)
}

// -- Rule 6: the run context --

interface DraftContext {
  profile: WorkspaceProfile
  workspaceGuidance: string
  agentGuidance: string
  workspaceKillSwitch: boolean
  agentEnabled: boolean
  cats: { id: string; key: string; label: string }[]
  categoryMode: 'off' | 'review' | 'auto'
  thread: ThreadMessage[]
  latestInboundBody: string
  dmarcPass: boolean | null
  priorDraft: { body: string; rejectReason: string | null } | null
  humanDecisionCount: number
  cacheAgentBlocks: boolean
  mailboxHealthy: boolean
}

async function loadContext(
  deps: TicketDraftDeps,
  orgId: string,
  ticket: ClaimedTicket,
  agent: AgentRow,
  now: Date,
  runId: string,
  effort: 'medium' | 'high',
): Promise<DraftContext> {
  return withOrg(deps.db, orgId, async (tx) => {
    const [workspace] = await tx.select().from(workspaces).where(eq(workspaces.orgId, orgId))
    if (!workspace) throw new Error(`ticket.draft: org ${orgId} has no workspace row`)

    const cats = await tx.select({ id: categories.id, key: categories.key, label: categories.label }).from(categories)

    let categoryMode: 'off' | 'review' | 'auto' = 'review'
    if (ticket.categoryId) {
      const [policy] = await tx
        .select({ mode: agentCategoryPolicies.mode })
        .from(agentCategoryPolicies)
        .where(and(eq(agentCategoryPolicies.agentId, agent.id), eq(agentCategoryPolicies.categoryId, ticket.categoryId)))
      if (policy) categoryMode = policy.mode as 'off' | 'review' | 'auto'
    }

    const messageRows = await tx
      .select({ direction: messages.direction, sentAt: messages.sentAt, fromAddress: messages.fromAddress, bodyText: messages.bodyText, dmarcPass: messages.dmarcPass })
      .from(messages)
      .where(eq(messages.ticketId, ticket.id))
      .orderBy(asc(messages.sentAt), asc(messages.createdAt))
    const thread: ThreadMessage[] = messageRows.map((m) => ({
      direction: m.direction === 'outbound' ? 'outbound' : 'inbound',
      at: m.sentAt,
      from: m.fromAddress,
      body: (m.bodyText ?? '').slice(0, THREAD_BODY_MAX_CHARS),
    }))
    const latestInbound = [...messageRows].reverse().find((m) => m.direction === 'inbound')

    // Only worth loading when this run is actually a redraft — the prompt's "previous draft"
    // section exists to stop the model repeating an approach the owner already rejected.
    const isRedraft = ticket.redraftCount > 0 || (ticket.ownerRedraftFeedback ?? '').trim().length > 0
    let priorDraft: { body: string; rejectReason: string | null } | null = null
    if (isRedraft) {
      const [prior] = await tx
        .select({ body: drafts.body, rejectReason: drafts.rejectReason })
        .from(drafts)
        .where(and(eq(drafts.ticketId, ticket.id), inArray(drafts.status, ['rejected', 'superseded'])))
        .orderBy(desc(drafts.createdAt))
        .limit(1)
      priorDraft = prior ?? null
    }

    // The cold-start lock counts HUMAN decisions for this agent in this ticket's category.
    let humanDecisionCount = 0
    if (ticket.categoryId) {
      const [decided] = await tx
        .select({ value: count() })
        .from(drafts)
        .where(and(eq(drafts.agentId, agent.id), eq(drafts.categoryId, ticket.categoryId), isNotNull(drafts.decidedBy)))
      humanDecisionCount = decided?.value ?? 0
    }

    const [hourly] = await tx
      .select({ value: count() })
      .from(agentRuns)
      .where(and(eq(agentRuns.kind, 'draft'), gte(agentRuns.startedAt, new Date(now.getTime() - AGENT_CACHE_WINDOW_MS))))
    const cacheAgentBlocks = (hourly?.value ?? 0) >= DRAFT_RATE_FOR_AGENT_CACHE

    const [connection] = await tx
      .select({ status: mailboxConnections.status })
      .from(mailboxConnections)
      .where(eq(mailboxConnections.id, ticket.connectionId))

    const profile: WorkspaceProfile = {
      businessName: workspace.businessName,
      websiteUrl: workspace.websiteUrl,
      description: workspace.description,
      tone: workspace.tone as Tone,
      timezone: workspace.timezone,
      locale: workspace.locale,
      contactPhone: workspace.contactPhone,
      contactUrls: workspace.contactUrls,
      allowedUrlHosts: workspace.allowedUrlHosts,
      allowedEmailDomains: workspace.allowedEmailDomains,
    }

    const ctx: DraftContext = {
      profile,
      workspaceGuidance: workspace.operatingGuidance,
      agentGuidance: agent.guidanceExtra,
      workspaceKillSwitch: workspace.killSwitch,
      agentEnabled: workspace.agentEnabled,
      cats,
      categoryMode,
      thread,
      latestInboundBody: latestInbound?.bodyText ?? '',
      dmarcPass: latestInbound?.dmarcPass ?? null,
      priorDraft,
      humanDecisionCount,
      cacheAgentBlocks,
      mailboxHealthy: connection?.status === 'connected',
    }

    // The prompt event records the four CONTEXT-derived blocks; the fifth (knowledge) is built from
    // retrieval, which by the pinned order has not run yet — and in Phase 3 is always empty.
    const blocks = [
      platformRulesBlock(),
      workspaceProfileBlock(profile),
      personaBlock(personaFor(agent)),
      guidanceBlock({ workspaceGuidance: ctx.workspaceGuidance, agentGuidance: ctx.agentGuidance }),
    ].filter((b) => b !== null)
    await appendRunEvent(tx, runId, 'prompt', {
      blocks: blocks.map((b) => ({ id: b.id, chars: b.text.length })),
      effort,
      cacheAgentBlocks,
      threadMessages: thread.length,
    })

    return ctx
  })
}

function personaFor(agent: AgentRow): { preset: PersonaPreset; personaText: string; displayName: string; address: string } {
  return {
    preset: agent.personaPreset as PersonaPreset,
    personaText: agent.personaText,
    displayName: agent.displayName,
    address: agent.replyFromAddress ?? agent.address,
  }
}

/** The org's category matching the model's claimed key, falling back to `other` for anything it invents. */
function resolveCategory(cats: { id: string; key: string; label: string }[], key: string): { id: string; label: string } | null {
  const match = cats.find((c) => c.key === key) ?? cats.find((c) => c.key === 'other')
  return match ? { id: match.id, label: match.label } : null
}

function errorToDetail(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// -- The run function (pure w.r.t. pg-boss — this is what tests call directly) --

export async function runTicketDraft(deps: TicketDraftDeps, payload: TicketDraftPayload, signal: AbortSignal): Promise<void> {
  const { orgId, ticketId } = payload
  const now = deps.now?.() ?? new Date()
  const day = utcDayString(now)

  // --- Rules 1 + 2: the kill lever, selectability, the agent, and the unlocked caps. One read tx.
  const pre = await loadPreClaim(deps.db, orgId, ticketId, now)
  if (pre === null) return

  if (pre.agent === null) {
    const notificationId = await withOrg(deps.db, orgId, async (tx) => {
      const { notificationId } = await escalateTicket(tx, {
        orgId, ticketId, fromStatus: 'triaged', reason: 'no_agent', day, now,
        actor: DRAFT_ACTOR, auditAction: 'ticket.escalated',
      })
      return notificationId
    })
    if (notificationId) await deps.enqueueNotify(orgId, notificationId)
    return
  }
  const agent = pre.agent

  // --- Rule 3: pre-claim cap checks. Plain SELECT counts already read above: no lock, no insert
  // and above all NO STAMP — a capped ticket must never be touched before it is refused, or the
  // claim's stuck branch would charge it a failure 20 minutes later for a run that never happened.
  if (pre.caps.ticketRunsToday >= INVARIANTS.AGENT_MAX_RUNS_PER_TICKET_PER_DAY) {
    await escalateRunCapped(deps, orgId, ticketId, day, now, pre.caps.ticketRunsToday)
    return
  }
  if (orgCapReached(pre.settings, pre.caps)) {
    await notifyOrgCapped(deps, orgId, day)
    return
  }

  // --- Rule 4: the CAS claim, its own transaction. A queued duplicate whose predicate fails on the
  // locked row exits here, before any run row exists.
  const claim = await withOrg(deps.db, orgId, (tx) => claimTicket(tx, { orgId, ticketId, now }))
  if (!claim.claimed) {
    if (claim.reason === 'stuck_escalated') {
      // The claim transaction already inserted the page; this job only has to dispatch it.
      if (claim.notificationId) await deps.enqueueNotify(orgId, claim.notificationId)
      return
    }
    await withOrg(deps.db, orgId, (tx) =>
      appendSkipAudit(tx, ticketId, claim.reason, claim.status))
    return
  }
  const ticket = claim.ticket
  const threadSnapshotAt = claim.threadSnapshotAt
  const ownerFeedbackPending = (ticket.ownerRedraftFeedback ?? '').trim().length > 0
  const isRedraft = ownerFeedbackPending || ticket.redraftCount > 0

  // --- Rule 5: the advisory-locked gate + the run row (which IS the spend row, written BEFORE the
  // model call so a process that dies mid-run still counts).
  const gate = await withOrg(deps.db, orgId, (tx) =>
    gateAndRecordRun(tx, {
      orgId, ticketId, agentId: agent.id, kind: 'draft',
      provider: deps.provider.kind, model: DRAFT_MODEL,
      input: { redraft: isRedraft, feedbackChars: (ticket.ownerRedraftFeedback ?? '').length },
      settings: pre.settings, now,
    }))
  if (gate.outcome !== 'proceed') {
    if (gate.outcome === 'ticket_capped') {
      // A genuine race past the unlocked read. The claim's stamp is moot — the ticket is leaving
      // `triaged` entirely, and every claim predicate requires that status.
      await escalateRunCapped(deps, orgId, ticketId, day, now, gate.runsToday)
      return
    }
    // Every other refusal leaves the ticket exactly as if the claim had never run.
    await withOrg(deps.db, orgId, (tx) => unwindClaimStamp(tx, ticketId, claim.stampedLastAgentRunAt, claim.priorLastAgentRunAt))
    if (gate.outcome === 'org_busy') {
      await deps.enqueueDraft(orgId, ticketId, { startAfter: new Date(now.getTime() + ORG_BUSY_RETRY_MS) })
      return
    }
    await notifyOrgCapped(deps, orgId, day)
    return
  }
  const runId = gate.runId

  const usage = createUsageAccumulator()
  const outcomeCtx = (): OutcomeContext => ({
    db: deps.db, orgId, ticketId, runId, agentId: agent.id, now, day, threadSnapshotAt,
    usage: usage.totals(), logger: deps.logger,
  })

  /**
   * The failure path (rule 9): count the attempt, settle the run, trace the error. It deliberately
   * does NOT stamp `last_agent_finished_at` — a failed attempt must keep reading as "claimed but
   * never finished", which is exactly what stuck recovery looks for. Returns true at the ceiling,
   * where the ticket has been escalated and the job returns instead of retrying further.
   */
  const fail = async (code: string, detail: string, status: 'failed' | 'aborted'): Promise<boolean> => {
    const result = await withOrg(deps.db, orgId, async (tx) => {
      const recorded = await recordFailure(tx, { orgId, ticketId, code, detail, now, runId })
      const settled = await finishRun(tx, { runId, status, errorCode: code, errorMessage: detail.slice(0, 500), usage: usage.totals(), now })
      if (!settled) deps.logger.warn({ runId, ticketId }, 'ticket.draft: run was already settled by the backstop sweep')
      await appendRunEvent(tx, runId, 'error', { code, detail })
      return recorded
    })
    if (result.notificationId) await deps.enqueueNotify(orgId, result.notificationId)
    return result.agentFailureCount >= INVARIANTS.AGENT_FAILURE_ESCALATE_AT
  }

  // --- Rule 6: the run context, one read tx, ending in the `prompt` trace event.
  const firstEffort: 'medium' | 'high' = ownerFeedbackPending ? 'high' : 'medium'
  const ctx = await loadContext(deps, orgId, ticket, agent, now, runId, firstEffort)
  const categoryKey = ctx.cats.find((c) => c.id === ticket.categoryId)?.key ?? null

  // ONE watchdog for the whole run — the first call, retrieval, and the automatic redraft all share
  // this deadline, so a slow first attempt cannot buy a second full budget.
  const watchdog = withWatchdog(signal, deps.watchdogMs)

  // --- Rule 7: retrieval, OUTSIDE every transaction. Empty in Phase 3.
  let knowledge: { chunks: RetrievedChunk[]; answers: RetrievedAnswer[] }
  try {
    knowledge = await deps.retriever.retrieve({ orgId, questions: ticket.triageQuestions, text: ctx.latestInboundBody, signal: watchdog })
  } catch (err) {
    const aborted = watchdog.aborted
    if (await fail(aborted ? 'watchdog' : 'retrieval', errorToDetail(err), aborted ? 'aborted' : 'failed')) return
    throw err
  }

  const promptInput = (guardrailRetry: { codes: string[] } | null, effort: 'medium' | 'high'): DraftPromptInput => ({
    ticket: {
      subject: ticket.subject, categoryKey, sentiment: ticket.sentiment, language: ticket.language,
      triageQuestions: ticket.triageQuestions, dmarcPass: ctx.dmarcPass,
    },
    thread: ctx.thread,
    priorDraft: ctx.priorDraft,
    ownerFeedback: ticket.ownerRedraftFeedback,
    guardrailRetry,
    categoryKeys: ctx.cats.map((c) => c.key),
    profile: ctx.profile,
    persona: personaFor(agent),
    guidance: { workspaceGuidance: ctx.workspaceGuidance, agentGuidance: ctx.agentGuidance },
    knowledge,
    cacheAgentBlocks: ctx.cacheAgentBlocks,
    effort,
  })

  /** One model attempt plus its accounting: usage, cost and the `call` trace event. */
  const callModel = async (attempt: number, guardrailRetry: { codes: string[] } | null, effort: 'medium' | 'high'): Promise<DraftCallResult> => {
    const meta: ChatMeta = { orgId, agentId: agent.id, runId, role: 'draft', idempotencyKey: `draft:${runId}:${attempt}` }
    const call = await runDraftCall(deps.provider, promptInput(guardrailRetry, effort), meta, watchdog)
    const pricing = findPricing(call.result.model)
    const costMicros = pricing ? computeCostMicros(call.result.usage, pricing, '1h') : 0
    usage.add(call.result.usage, costMicros)
    await withOrg(deps.db, orgId, (tx) =>
      appendRunEvent(tx, runId, 'call', {
        attempt, finish: call.result.finish, parseStrategy: call.result.parseStrategy,
        model: call.result.model, latencyMs: call.result.latencyMs, costMicros, usage: call.result.usage,
      }))
    return call
  }

  // --- Rule 8: model call #1.
  let first: DraftCallResult
  try {
    first = await callModel(1, null, firstEffort)
  } catch (err) {
    // Rule 9. The watchdog check comes FIRST: a timeout surfaces as a transient provider error, and
    // `llm_transient` would hide the real cause.
    const aborted = watchdog.aborted
    const code = aborted ? 'watchdog' : err instanceof LlmError ? `llm_${err.code}` : 'llm_unknown'
    if (await fail(code, errorToDetail(err), aborted ? 'aborted' : 'failed')) return
    throw err
  }

  // Rule 9 again: an unparsable envelope. The structured-output ladder has already spent its rungs.
  if (first.decision === null && first.result.finish !== 'refusal') {
    const detail = `finish ${first.result.finish}, parse strategy ${first.result.parseStrategy}`
    if (await fail('unparsable', detail, 'failed')) return
    throw new Error(`ticket.draft: unparsable decision for ticket ${ticketId} (${detail})`)
  }

  // --- Rule 10: a refusal is content_filtered. The spec routes content_filtered to Review, but with
  // no body there is nothing to review, so the ticket goes to the owner as an agent escalation.
  let decision: DraftDecision =
    first.decision ?? { outcome: 'escalate', reason: 'other', rationale: 'the model declined to answer this thread' }
  const escalateDetail = first.decision === null ? CONTENT_FILTERED_DETAIL : ''

  // --- Rule 13: the guardrails, and the one automatic redraft a hard failure buys.
  let guardrail: GuardrailResult | null = null
  if (decision.outcome === 'reply') {
    const attempted = decision
    guardrail = await screen(deps, orgId, runId, 1, attempted, ctx, agent, ticket.language, knowledge)
    if (!guardrail.ok) {
      const stopLoss = usage.totals().costMicros >= STOP_LOSS_MICROS
      if (stopLoss || watchdog.aborted) {
        deps.logger.warn({ runId, ticketId, stopLoss }, 'ticket.draft: skipping the automatic redraft')
      } else {
        const codes = guardrail.findings.filter((f) => f.severity === 'fail').map((f) => f.code)
        let second: DraftCallResult | null = null
        try {
          second = await callModel(2, { codes }, 'high')
        } catch (err) {
          // A failed redraft is not a failed run: the first attempt's body still goes to the owner
          // with its findings, which is the same end state a second failing attempt would produce.
          deps.logger.warn({ runId, ticketId, err: errorToDetail(err) }, 'ticket.draft: the automatic redraft failed')
        }
        if (second?.decision) {
          const next = second.decision
          decision = next
          guardrail = next.outcome === 'reply'
            ? await screen(deps, orgId, runId, 2, next, ctx, agent, ticket.language, knowledge)
            : null
        }
      }
    }
  }

  // --- Rule 14: the autonomy decision, then the landing.
  const verdict = decide({
    platformKillSwitch: false, // rule 1 already returned if the lever were on
    workspaceKillSwitch: ctx.workspaceKillSwitch,
    agentEnabled: ctx.agentEnabled,
    agentActive: agent.status === 'active',
    subscriptionActive: true,
    tripwire: false, // a tripwired ticket is never `triaged`, so a draft run can never see one
    outcome: decision.outcome,
    ownerFeedbackPending,
    guardrail: guardrail ? { ok: guardrail.ok, warningCount: guardrail.warningCount } : { ok: true, warningCount: 0 },
    dmarcPass: ctx.dmarcPass,
    categoryMode: ctx.categoryMode,
    isRedraft,
    humanDecisionCount: ctx.humanDecisionCount,
    evidence: null, // Phase 5
    threshold: null,
    hasAttachments: ticket.hasAttachments,
    allowanceExhausted: false,
    autoSendCapReached: false,
    mailboxHealthy: ctx.mailboxHealthy,
  })
  await withOrg(deps.db, orgId, (tx) =>
    appendRunEvent(tx, runId, 'decision', {
      outcome: decision.outcome, action: verdict.action, reason: verdict.reason, quiet: verdict.quiet === true,
      guardrailOk: guardrail?.ok ?? null, warningCount: guardrail?.warningCount ?? null,
    }))

  // Rule 11.
  if (decision.outcome === 'escalate') {
    const notificationId = await applyEscalateOutcome(outcomeCtx(), {
      escalateReason: decision.reason,
      rationale: decision.rationale,
      detail: escalateDetail || AGENT_ESCALATE_REASON_DETAIL[decision.reason],
    })
    if (notificationId) await deps.enqueueNotify(orgId, notificationId)
    return
  }

  // Rule 12. `|| ownerFeedbackPending` is the belt on `decide()`'s brace: an earlier short-circuit
  // (a workspace kill switch, a disabled agent) answers `review` for every outcome, and a plain
  // no_reply under one would leave a ticket carrying unfulfilled owner feedback `triaged` with a
  // finish stamp — never re-selected, never escalated, the correction silently swallowed.
  if (decision.outcome === 'no_reply') {
    const notificationId = await applyNoReplyOutcome(outcomeCtx(), {
      reason: decision.reason,
      rationale: decision.rationale,
      ownerFeedbackPending: verdict.reason === 'redraft_unfulfilled' || ownerFeedbackPending,
    })
    if (notificationId) await deps.enqueueNotify(orgId, notificationId)
    return
  }

  // Rules 13/14's shared landing: a body exists, and it is stored either way.
  const screened = guardrail!
  const category = resolveCategory(ctx.cats, decision.categoryKey)
  const warnings = screened.findings.filter((f) => f.severity === 'warn').map((f) => f.code)
  const retrievedChunkIds = knowledge.chunks.map((c) => c.id)
  const retrievedAnswerIds = knowledge.answers.map((a) => a.id)
  // An id retrieval never returned cannot be a citation — a model that invents one must not be able
  // to make a draft look grounded (spec §Tenancy: re-check every id that crosses a prompt boundary).
  const citedChunkIds = decision.citedChunkIds.filter((id) => retrievedChunkIds.includes(id))
  const usedAnswerIds = decision.usedAnswerIds.filter((id) => retrievedAnswerIds.includes(id))
  const memoryConflictIds = decision.memoryConflictIds.filter((id) => retrievedChunkIds.includes(id) || retrievedAnswerIds.includes(id))

  // `escalate` is `guardrail_failed` or `category_off`; everything else lands in the review queue.
  // `send` is unreachable in Phase 3 (`evidence: null` forces `below_threshold` first) and would
  // land here as `review` anyway — the safe direction, and never an unattended send.
  const landing: DraftLanding =
    verdict.action === 'escalate'
      ? {
          kind: 'escalate',
          reason: verdict.reason === 'category_off' ? 'category_off' : 'guardrail_failed',
          decisionReason: verdict.reason,
          quiet: verdict.quiet === true,
        }
      : { kind: 'review', decisionReason: verdict.reason }

  try {
    const { notificationId } = await applyDraftOutcome(outcomeCtx(), landing, {
      // What was SCREENED is what is stored and sent. The signature is appended by the send path,
      // never here and never by the model.
      body: screened.normalizedBody,
      categoryId: category?.id ?? null,
      categoryLabel: category?.label ?? 'Other',
      confidence: decision.confidence,
      confidenceBreakdown: {
        blockers: {
          tripwire: false,
          guardrail: !screened.ok,
          dmarcFail: ctx.dmarcPass !== true,
          attachments: ticket.hasAttachments,
          redraft: isRedraft,
          categoryOff: ctx.categoryMode === 'off',
          coldStart: ctx.humanDecisionCount < COLD_START_DECISIONS,
        },
        model: decision.confidence,
        memory: null,
        grounding: null, // Phase 4 fills this once retrieval returns anything
        evidence: null, // Phase 5
        warnings,
      },
      guardrailResult: { ok: screened.ok, findings: screened.findings },
      retrievedChunkIds,
      citedChunkIds,
      retrievedAnswerIds,
      usedAnswerIds,
      memoryConflictIds,
      rationale: decision.rationale,
      unresolvedQuestions: decision.unresolvedQuestions,
      customerLanguage: decision.customerLanguage,
      isRedraft,
      warnings,
    })
    if (notificationId) await deps.enqueueNotify(orgId, notificationId)
  } catch (err) {
    if (!(err instanceof LostRaceError)) throw err
    // Someone moved the ticket while the model call was in flight. The draft is dropped on the
    // floor — nothing is anchored to it — but the run still finished, so it is finalized.
    await recordLostRace(outcomeCtx())
  }
}

/** Rule 4's audit row for a claim that matched nothing: the CAS lost, or the ticket moved on. */
async function appendSkipAudit(tx: OrgTx, ticketId: string, reason: string, status: string | undefined): Promise<void> {
  await audit(tx, {
    actor: DRAFT_ACTOR, action: 'draft.run_skipped', entityType: 'ticket', entityId: ticketId,
    detail: status === undefined ? { reason } : { reason, status },
  })
}

/**
 * Rule 13's screen: the workspace policy, the guardrails and the `guardrail` trace event. Pure
 * except for that one short write.
 */
async function screen(
  deps: TicketDraftDeps,
  orgId: string,
  runId: string,
  attempt: number,
  decision: Extract<DraftDecision, { outcome: 'reply' }>,
  ctx: DraftContext,
  agent: AgentRow,
  ticketLanguage: string | null,
  knowledge: { chunks: RetrievedChunk[]; answers: RetrievedAnswer[] },
): Promise<GuardrailResult> {
  const personaText = personaBlock(personaFor(agent)).text
  const policy = buildWorkspacePolicy({
    workspace: {
      allowedUrlHosts: ctx.profile.allowedUrlHosts,
      allowedEmailDomains: ctx.profile.allowedEmailDomains,
      contactPhone: ctx.profile.contactPhone,
      contactUrls: ctx.profile.contactUrls,
      locale: ctx.profile.locale,
    },
    agentDomain: agent.domain,
    trustedTexts: [platformRulesBlock().text, personaText, ctx.workspaceGuidance, ctx.agentGuidance],
    expectedLanguage: ticketLanguage,
  })
  const groundedNumbers = collectGroundedNumbers([
    ...ctx.thread.map((m) => m.body),
    ctx.profile.description ?? '',
    ctx.workspaceGuidance,
    ctx.agentGuidance,
    ...knowledge.chunks.map((c) => c.content),
    ...knowledge.answers.map((a) => `${a.question}\n${a.answer}`),
  ])
  const result = validateReplyBody(decision.body, policy, { replyLanguage: decision.customerLanguage, groundedNumbers })
  await withOrg(deps.db, orgId, (tx) =>
    appendRunEvent(tx, runId, 'guardrail', {
      attempt, ok: result.ok, warningCount: result.warningCount,
      codes: result.findings.map((f) => f.code),
    }))
  return result
}
