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
  THREAD_BODY_MAX_CHARS, withWatchdog, workspaceProfileBlock,
  type DraftCallResult, type DraftDecision, type DraftPromptInput, type EscalateReason,
  type RetrievedAnswer, type RetrievedChunk, type Retriever, type ThreadMessage, type WorkspaceProfile,
} from '@aesa/agent'
import { DEFAULT_AUTO_SEND_THRESHOLD, MANAGED_MODELS, type LlmEffort } from '@aesa/contracts'
import {
  COLD_START_DECISIONS, collectGroundedNumbers, decide, INVARIANTS, isAllowanceExhausted, PLANS, QUALITY_CAPS,
  resolveSetting, THREAD_MAX_MESSAGES_FOR_AUTO, validateReplyBody, type GuardrailResult,
} from '@aesa/core'
import {
  agentCategoryPolicies, agentRuns, agents, audit, countManagedConversations, drafts, escalateTicket,
  loadSettingSources, mailboxConnections, messages, notifications, platformState,
  SEND_METERS, tickets, usageCounters, withOrg,
  type BillingStateView, type Db, type OrgTx, type SettingSources,
} from '@aesa/db'
import { computeCostMicros, findPricing, LlmError, type ChatMeta } from '@aesa/llm'
// type-only: the base `Retriever` is what this job depends on; this is the shape of the richer one.
import type { DetailedRetriever } from '@aesa/knowledge'
import { defineJob, enqueue, JOB_NAMES, registerJob, type RegisteredJobDefinition } from '@aesa/queue'
import { utcDayString } from '../date-utils.ts'
import { noAdmission, type AdmissionPool } from '../drafting/admission.ts'
import { gateAndRecordRun, readCapsUnlocked, trialBudgetApplies, usdCapToMicros, type SpendCapScope, type UnlockedCaps } from '../drafting/caps.ts'
import { claimTicket, recordFailure, unwindClaimStamp, type ClaimedTicket } from '../drafting/claim.ts'
import { loadSharedDraftContext } from '../drafting/context.ts'
import {
  applyDraftOutcome, applyEscalateOutcome, applyNoReplyOutcome, DRAFT_ACTOR, escalateProviderUnavailable,
  killCredential, LostRaceError, recordLostRace,
  type DraftLanding, type OutcomeContext,
} from '../drafting/outcomes.ts'
import { buildReplyPolicy, personaFor } from '../drafting/policy.ts'
import { computeEvidence } from '../drafting/evidence.ts'
import { alert } from '../observability.ts'
import { appendRunEvent, finishRun } from '../drafting/runs.ts'
import { cacheTtlFor, FALLBACK_CODES, type ProviderResolver } from '../provider-resolver.ts'

/**
 * Spec §Budgets: $0.40 of managed spend per run. Past it the automatic redraft after a guardrail
 * failure is skipped — the owner gets the blocked body plus the findings instead, which is the same
 * end state a second failing attempt would have produced, for half the money.
 */
export const STOP_LOSS_MICROS = 400_000

/**
 * Spec §Budgets, the other half of the same sentence — "$0.40 managed / 30k output tokens BYOK".
 * A tenant's model is very often not in `model_pricing` at all (every `custom` endpoint, every
 * un-seeded catalog id), and an unpriced call costs `0`, which makes the micro-dollar stop-loss
 * silently inert for exactly the runs this limit was written for. Output tokens are reported by
 * every provider, so they are the currency that always works — and it is the owner's bill, not the
 * platform's, that this protects.
 */
export const STOP_LOSS_BYOK_OUTPUT_TOKENS = 30_000

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

/** The once-per-org-per-day page when the whole workspace has spent its DAILY model budget, which
 *  resets on its own at UTC midnight. The trial's TOTAL budget is the other scope, and it lands
 *  differently (ruling R27, `escalateTrialBudget` below): per ticket through `escalateTicket`, with
 *  `escalationCopy('trial_budget')` as the page, plus ONE billing notice per org, ever. */
const LLM_DAILY_CAP_COPY = {
  title: 'Daily AI budget reached',
  body: "Today's AI budget for this workspace is used up. Drafting starts again after midnight UTC.",
} as const

/** The org-level "subscribe" notice a trial gets ONCE when its total budget is spent — and the
 *  durable once-per-org gate behind the operator alert (ruling R27: the alert keys on the ORG,
 *  never the day). `kind: 'billing'`, like the report-usage pass's `billing:trial_ended` and
 *  `billing:allowance` notices, which say the same kind of thing. */
const TRIAL_BUDGET_NOTICE = {
  title: 'Trial AI budget reached',
  body: 'The AI budget for this trial is used up. Replies wait for you until you subscribe — subscribe to keep the agent drafting.',
} as const

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

/** One model attempt and WHICH provider served it — `fellBack` is per attempt, never per run
 *  (Phase 6 review 1, finding 2): the breakdown's provenance describes the attempt that landed. */
interface DraftAttempt {
  call: DraftCallResult
  fellBack: boolean
}

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
export const ticketDraftJob: RegisteredJobDefinition<TicketDraftPayload> = defineJob({
  name: JOB_NAMES.ticketDraft,
  schema: TicketDraftPayload,
  // policy: 'short' (QUEUE_OPTIONS) — NOT pg-boss's default `standard`, on which the `singletonKey`
  // `enqueue()` always sets is inert (fix wave W8 / final-A1 M3). Four producers re-enqueue the same
  // ticket (the api's redraft, the backstop sweep every minute, `send.execute`'s two hand-backs,
  // `ticket.triage`), and under `standard` a capped or levered org's tickets stacked up to 50
  // duplicate jobs a minute. `short` collapses duplicates only while the first is still `created`
  // — a job that has already started reading never swallows a newer event. expireInSeconds there is
  // `INVARIANTS.DRAFT_JOB_EXPIRE_SECONDS`.
  handler: async () => {
    throw new Error('ticket.draft: this definition has no bound deps — register it through registerTicketDraft(boss, deps)')
  },
})

export interface TicketDraftDeps {
  db: Db
  /** Phase 6: the ONE way this job gets a model. Every call resolves the agent's own configuration
   *  — Managed AI or the tenant's own key — and a refusal lands `provider_unavailable`. */
  providers: ProviderResolver
  retriever: Retriever
  logger: pino.Logger
  /** index.ts wires this to `enqueueNotifyDispatch`. */
  enqueueNotify: (orgId: string, notificationId: string) => Promise<void>
  /** Self re-enqueue for `org_busy` (startAfter +30 s) and the backstop; index.ts wires `enqueueTicketDraft`. */
  enqueueDraft: (orgId: string, ticketId: string, opts?: { startAfter?: Date }) => Promise<void>
  /** The auto landing's queued send, due when the agent's hold window elapses; index.ts wires
   *  `enqueueSendExecute`. Best-effort — the backstop sweep's due-send arm (d) is the net. */
  enqueueSend: (orgId: string, sendId: string, opts: { startAfter: Date }) => Promise<void>
  /** Phase 7: the deployment-wide ceiling on concurrent MANAGED model calls (plan deviation 13).
   *  Omitted is `noAdmission` — no admission control, which is also what `MANAGED_DRAFT_SLOTS=0`
   *  buys; `agent-role.ts` always passes a real one. A refused slot NEVER fails a draft. */
  admission?: AdmissionPool
  now?: () => Date
  /** Test seam: the watchdog budget for the WHOLE run (default `INVARIANTS.DRAFT_WATCHDOG_SECONDS`). */
  watchdogMs?: number
}

export async function registerTicketDraft(boss: PgBoss, deps: TicketDraftDeps): Promise<void> {
  const wired: RegisteredJobDefinition<TicketDraftPayload> = {
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
  /** The auto-send hold window, in minutes (default 2) — how long an owner has to pull a reply back. */
  autoSendDelayMin: agents.autoSendDelayMin,
}
type AgentRow = { [K in keyof typeof AGENT_COLUMNS]: (typeof agents.$inferSelect)[K] }

interface PreClaim {
  agent: AgentRow | null
  /** The org's `org_settings` rows AND its plan's defaults, loaded ONCE for the whole run — every
   *  `resolveSetting` below reads this object, and so does the locked gate. */
  sources: SettingSources
  /** Phase 7: the workspace's plan, state and allowance — `decide()`'s `subscriptionActive`. */
  billing: BillingStateView
  /** MANAGED-model conversations this billing period (`ai_handled_conversations_managed`). A BYOK
   *  reply never counts here, so it can never exhaust the allowance. */
  managedUsed: number
  caps: UnlockedCaps
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

    const sources = await loadSettingSources(tx, [
      'autonomy.daily_draft_cap', 'autonomy.daily_llm_usd_cap',
      'autonomy.daily_auto_send_cap', 'notifications.push_auto_sends',
    ], now)

    // Phase 7: the two billing facts `decide()` now takes as facts rather than literals. Read here,
    // in the pre-claim transaction, so the model call is never what discovers them. The billing
    // view is the ONE `loadSettingSources` already read (ruling R27) — never a second read of the
    // row, which could disagree with the caps resolved from the first.
    const billing = sources.billing
    const managedUsed = await countManagedConversations(tx, billing.period)

    return {
      agent: agent ?? null, sources, billing, managedUsed,
      caps: await readCapsUnlocked(tx, { orgId, ticketId, settings: sources, now }),
    }
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
 * The org-wide DAILY budget. The ticket is left completely untouched — no stamp, no status change —
 * so it is selectable again after UTC midnight; the owner gets ONE page per org per day, keyed on
 * the day, with an empty payload (there is no one ticket to deep-link to).
 */
async function notifyOrgCapped(deps: TicketDraftDeps, orgId: string, day: string): Promise<void> {
  const dedupeKey = `llm_cap:${orgId}:${day}`
  const notificationId = await withOrg(deps.db, orgId, async (tx) => {
    const [row] = await tx
      .insert(notifications)
      .values({ orgId, kind: 'escalation', title: LLM_DAILY_CAP_COPY.title, body: LLM_DAILY_CAP_COPY.body, dedupeKey, payload: {} })
      .onConflictDoNothing({ target: notifications.dedupeKey })
      .returning({ id: notifications.id })
    return row?.id
  })
  if (!notificationId) return
  // An operator has to see a workspace that has stopped drafting, and a `notifications` row only
  // reaches its owner. It rides the SAME dedupe the page does (once per org per day): a capped
  // workspace hits this path on every queued ticket, and an alert per refusal would bury the one
  // that mattered.
  alert(deps.logger, 'org_spend_capped', { orgId, scope: 'daily' })
  await deps.enqueueNotify(orgId, notificationId)
}

/**
 * The trial's TOTAL budget (ruling R27), which only a subscription clears — so unlike the daily cap
 * the ticket is NOT left `triaged` to be retried: it lands `needs_owner/trial_budget` through
 * `escalateTicket`, which stamps it out of the backstop sweep's selection (a refusal that left it
 * untouched re-enqueued it every minute — ~1,440 no-op jobs a day per stranded ticket) and pages
 * the owner once per ticket, like every other reason. The operator alert keys on the ORG, once:
 * its durable gate is the org-level billing notice (`llm_cap:trial:<org>`), inserted in the same
 * transaction — a capped trial hits this path on every new ticket, and an alert per ticket (or per
 * day, as before) would bury the one that mattered.
 */
async function escalateTrialBudget(
  deps: TicketDraftDeps, orgId: string, ticketId: string, day: string, now: Date, costMicros: number,
): Promise<void> {
  const landed = await withOrg(deps.db, orgId, async (tx) => {
    const { escalated, notificationId } = await escalateTicket(tx, {
      orgId, ticketId, fromStatus: 'triaged', reason: 'trial_budget', day, now,
      dedupeKey: `trial_budget:${ticketId}:${day}`, actor: DRAFT_ACTOR, auditAction: 'ticket.escalated',
      detail: { costMicros },
    })
    if (!escalated) return null
    const [notice] = await tx
      .insert(notifications)
      .values({ orgId, kind: 'billing', title: TRIAL_BUDGET_NOTICE.title, body: TRIAL_BUDGET_NOTICE.body, dedupeKey: `llm_cap:trial:${orgId}`, payload: {} })
      .onConflictDoNothing({ target: notifications.dedupeKey })
      .returning({ id: notifications.id })
    return { notificationId, noticeId: notice?.id }
  })
  if (!landed) return
  if (landed.noticeId) {
    alert(deps.logger, 'org_spend_capped', { orgId, scope: 'trial', ticketId })
    await deps.enqueueNotify(orgId, landed.noticeId)
  }
  if (landed.notificationId) await deps.enqueueNotify(orgId, landed.notificationId)
}

/** Which landing an org-cap refusal takes (both call sites below): the daily cap leaves the ticket
 *  untouched, the trial budget escalates it. */
async function landOrgCapped(
  deps: TicketDraftDeps, orgId: string, ticketId: string, day: string, now: Date, scope: SpendCapScope, costMicros: number,
): Promise<void> {
  if (scope === 'trial') await escalateTrialBudget(deps, orgId, ticketId, day, now, costMicros)
  else await notifyOrgCapped(deps, orgId, day)
}

/**
 * The unlocked mirror of the locked gate's branches 3, 4 and 4b, in the SAME order — a workspace
 * over both its daily cap and its trial budget must report `daily`, the one that clears by itself.
 * `null` means nothing is capped. The draft cap has no scope of its own: it lands on the same
 * `daily` page (it is a per-day ceiling), which is what Phase 3 did too. Branch 4b keys on the
 * derived billing STATE (`trialBudgetApplies`), never the plan — ruling R27.
 */
function orgCapReached(sources: SettingSources, caps: UnlockedCaps): SpendCapScope | null {
  const draftCap = resolveSetting('autonomy.daily_draft_cap', sources)
  const usdCap = resolveSetting('autonomy.daily_llm_usd_cap', sources)
  if (caps.orgDraftsToday >= draftCap || caps.orgCostMicrosToday >= usdCapToMicros(usdCap)) return 'daily'
  if (trialBudgetApplies(sources.billing) && caps.orgTrialCostMicros >= usdCapToMicros(PLANS.trial.llmUsdBudget)) return 'trial'
  return null
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
  /** The category policy's own threshold, in PERCENT; null falls back to `DEFAULT_AUTO_SEND_THRESHOLD`. */
  autoSendMinConfidence: number | null
  /** Today's `auto_sends` meter — the org's daily auto-send cap is measured against it. */
  autoSendsToday: number
  /** Every message on the thread, inbound and outbound: the `thread_too_long` blocker's input. */
  threadLength: number
  thread: ThreadMessage[]
  latestInboundBody: string
  dmarcPass: boolean | null
  priorDraft: { body: string; rejectReason: string | null } | null
  humanDecisionCount: number
  cacheAgentBlocks: boolean
  mailboxHealthy: boolean
  /** The `prompt` trace event's context-derived half; the knowledge half is added after retrieval. */
  promptEvent: { blocks: { id: string; chars: number }[]; effort: LlmEffort; cacheAgentBlocks: boolean; threadMessages: number }
}

async function loadContext(
  deps: TicketDraftDeps,
  orgId: string,
  ticket: ClaimedTicket,
  agent: AgentRow,
  now: Date,
  runId: string,
  effort: LlmEffort,
): Promise<DraftContext> {
  return withOrg(deps.db, orgId, async (tx) => {
    const shared = await loadSharedDraftContext(tx, orgId)

    let categoryMode: 'off' | 'review' | 'auto' = 'review'
    let autoSendMinConfidence: number | null = null
    if (ticket.categoryId) {
      const [policy] = await tx
        .select({ mode: agentCategoryPolicies.mode, autoSendMinConfidence: agentCategoryPolicies.autoSendMinConfidence })
        .from(agentCategoryPolicies)
        .where(and(eq(agentCategoryPolicies.agentId, agent.id), eq(agentCategoryPolicies.categoryId, ticket.categoryId)))
      if (policy) {
        categoryMode = policy.mode as 'off' | 'review' | 'auto'
        autoSendMinConfidence = policy.autoSendMinConfidence
      }
    }

    const [autoSends] = await tx
      .select({ value: usageCounters.value })
      .from(usageCounters)
      .where(and(eq(usageCounters.day, utcDayString(now)), eq(usageCounters.meter, SEND_METERS.autoSends)))

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

    // The prompt event's four CONTEXT-derived blocks; the fifth (knowledge) is built from retrieval,
    // which by the pinned order has not run yet — so the EVENT is written by the caller, after it.
    const blocks = [
      platformRulesBlock(),
      workspaceProfileBlock(shared.profile),
      personaBlock(personaFor(agent)),
      guidanceBlock({ workspaceGuidance: shared.workspaceGuidance, agentGuidance: agent.guidanceExtra }),
    ].filter((b) => b !== null)

    const ctx: DraftContext = {
      profile: shared.profile,
      workspaceGuidance: shared.workspaceGuidance,
      agentGuidance: agent.guidanceExtra,
      workspaceKillSwitch: shared.workspaceKillSwitch,
      agentEnabled: shared.agentEnabled,
      cats: shared.cats,
      categoryMode,
      autoSendMinConfidence,
      autoSendsToday: autoSends?.value ?? 0,
      threadLength: messageRows.length,
      thread,
      latestInboundBody: latestInbound?.bodyText ?? '',
      dmarcPass: latestInbound?.dmarcPass ?? null,
      priorDraft,
      humanDecisionCount,
      cacheAgentBlocks,
      mailboxHealthy: connection?.status === 'connected',
      promptEvent: {
        blocks: blocks.map((b) => ({ id: b.id, chars: b.text.length })),
        effort,
        cacheAgentBlocks,
        threadMessages: thread.length,
      },
    }

    return ctx
  })
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

  // --- Phase 6: WHICH model this run uses, resolved from the agent's own configuration. Before the
  // caps and before the claim on purpose: a workspace whose key is dead must not burn a cap slot, a
  // claim stamp or a run row to discover it. `resolve` only reads — the call happens far below.
  const resolved = await deps.providers.resolve(orgId, agent.id, 'draft')
  if (!resolved.ok) {
    await escalateProviderUnavailable(deps, orgId, ticketId, day, now, resolved.reason)
    return
  }
  const config = resolved.config

  // --- Rule 3: pre-claim cap checks. Plain SELECT counts already read above: no lock, no insert
  // and above all NO STAMP — a capped ticket must never be touched before it is refused, or the
  // claim's stuck branch would charge it a failure 20 minutes later for a run that never happened.
  if (pre.caps.ticketRunsToday >= INVARIANTS.AGENT_MAX_RUNS_PER_TICKET_PER_DAY) {
    await escalateRunCapped(deps, orgId, ticketId, day, now, pre.caps.ticketRunsToday)
    return
  }
  const preCapScope = orgCapReached(pre.sources, pre.caps)
  if (preCapScope !== null) {
    await landOrgCapped(deps, orgId, ticketId, day, now, preCapScope, pre.caps.orgTrialCostMicros)
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
      provider: config.provider, model: config.model,
      input: { redraft: isRedraft, feedbackChars: (ticket.ownerRedraftFeedback ?? '').length },
      settings: pre.sources, now,
    }))
  if (gate.outcome !== 'proceed') {
    if (gate.outcome === 'ticket_capped') {
      // A genuine race past the unlocked read. The claim's stamp is moot — the ticket is leaving
      // `triaged` entirely, and every claim predicate requires that status.
      await escalateRunCapped(deps, orgId, ticketId, day, now, gate.runsToday)
      return
    }
    // Every other refusal leaves the ticket exactly as if the claim had never run — except the
    // trial budget, which escalates it (the stamp is moot there too: the ticket leaves `triaged`).
    await withOrg(deps.db, orgId, (tx) => unwindClaimStamp(tx, ticketId, claim.stampedLastAgentRunAt, claim.priorLastAgentRunAt))
    if (gate.outcome === 'org_busy') {
      await deps.enqueueDraft(orgId, ticketId, { startAfter: new Date(now.getTime() + ORG_BUSY_RETRY_MS) })
      return
    }
    if (gate.outcome === 'org_spend_capped') await landOrgCapped(deps, orgId, ticketId, day, now, gate.scope, gate.costMicros)
    else await notifyOrgCapped(deps, orgId, day)
    return
  }
  const runId = gate.runId

  const usage = createUsageAccumulator()
  /** Built immediately before each landing opens its transaction, so `finishedAt` is a FRESH clock
   *  read: `agent_runs.finished_at` and `last_agent_finished_at` record when the run actually
   *  finished, not when it was claimed. Everything day- or claim-scoped still rides `now`. */
  const outcomeCtx = (): OutcomeContext => ({
    db: deps.db, orgId, ticketId, runId, agentId: agent.id, now, finishedAt: deps.now?.() ?? new Date(),
    day, threadSnapshotAt, usage: usage.totals(), logger: deps.logger,
  })

  /**
   * The failure path (rule 9): count the attempt, settle the run, trace the error. It deliberately
   * does NOT stamp `last_agent_finished_at` — a failed attempt must keep reading as "claimed but
   * never finished", which is exactly what stuck recovery looks for. Returns true at the ceiling,
   * where the ticket has been escalated and the job returns instead of retrying further.
   */
  const fail = async (code: string, detail: string, status: 'failed' | 'aborted'): Promise<boolean> => {
    // `recordFailure` stays on the claim-time `now` (its escalation is day-scoped); only the run
    // row's own `finished_at` wants the real finish instant.
    const finishedAt = deps.now?.() ?? new Date()
    const result = await withOrg(deps.db, orgId, async (tx) => {
      const recorded = await recordFailure(tx, { orgId, ticketId, code, detail, now, runId })
      const settled = await finishRun(tx, { runId, status, errorCode: code, errorMessage: detail.slice(0, 500), usage: usage.totals(), now: finishedAt })
      if (!settled) deps.logger.warn({ runId, ticketId }, 'ticket.draft: run was already settled by the backstop sweep')
      await appendRunEvent(tx, runId, 'error', { code, detail })
      return recorded
    })
    if (result.notificationId) await deps.enqueueNotify(orgId, result.notificationId)
    return result.agentFailureCount >= INVARIANTS.AGENT_FAILURE_ESCALATE_AT
  }

  // --- Rule 6: the run context, one read tx, ending in the `prompt` trace event.
  // A BYOK agent may pin its own effort (a small local model that reasons badly at `high`, say);
  // absent that, owner feedback still buys `high`. The guardrail retry below is always `high`.
  const firstEffort: LlmEffort = config.effort ?? (ownerFeedbackPending ? 'high' : 'medium')
  const ctx = await loadContext(deps, orgId, ticket, agent, now, runId, firstEffort)
  const categoryKey = ctx.cats.find((c) => c.id === ticket.categoryId)?.key ?? null

  // ONE watchdog for the whole run — the first call, retrieval, and the automatic redraft all share
  // this deadline, so a slow first attempt cannot buy a second full budget.
  const watchdog = withWatchdog(signal, deps.watchdogMs)

  // --- Rule 7: retrieval, OUTSIDE every transaction.
  // `retrieveDetailed` is duck-typed on purpose: the job's contract is `@aesa/agent`'s base
  // `Retriever`, and the `emptyRetriever` every pre-Phase-4 caller passes has no such method. When
  // it IS there (`@aesa/knowledge`'s real retriever), its extra provenance — which leg answered and
  // the knowledge version the chunks came from — is what `confidenceBreakdown.grounding` records.
  let knowledge: { chunks: RetrievedChunk[]; answers: RetrievedAnswer[] }
  let knowledgeMode: 'hybrid' | 'lexical' | null = null
  let knowledgeVersion: number | null = null

  /** The `prompt` trace event, once all FIVE blocks are known. It stays the run's FIRST event on
   *  every path — including the retrieval failure below, whose trace would otherwise open with an
   *  `error` event and no record of what the run was even built from. */
  const writePromptEvent = async (retrieved: number): Promise<void> => {
    await withOrg(deps.db, orgId, (tx) =>
      appendRunEvent(tx, runId, 'prompt', { ...ctx.promptEvent, knowledge: { retrieved, mode: knowledgeMode } }))
  }

  try {
    const input = { orgId, questions: ticket.triageQuestions, text: ctx.latestInboundBody, signal: watchdog }
    if ('retrieveDetailed' in deps.retriever) {
      const detailed = await (deps.retriever as DetailedRetriever).retrieveDetailed(input)
      knowledge = { chunks: detailed.chunks, answers: detailed.answers }
      knowledgeMode = detailed.mode
      knowledgeVersion = detailed.knowledgeVersion
    } else {
      knowledge = await deps.retriever.retrieve(input)
    }
  } catch (err) {
    await writePromptEvent(0)
    const aborted = watchdog.aborted
    if (await fail(aborted ? 'watchdog' : 'retrieval', errorToDetail(err), aborted ? 'aborted' : 'failed')) return
    throw err
  }

  await writePromptEvent(knowledge.chunks.length)

  const promptInput = (guardrailRetry: { codes: string[] } | null, effort: LlmEffort): DraftPromptInput => ({
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
    model: config.model,
  })

  /**
   * One model attempt plus its accounting: usage, cost and the `call` trace event.
   *
   * Phase 6's `fallback_to_managed` lives here: when the agent opted in AND the resolver produced a
   * managed provider beside the tenant's own, ONE of the three `FALLBACK_CODES` buys a single retry
   * on Managed AI (billable to the platform allowance — the spec's "opt-in billable"). It is
   * deliberately not a loop and not a second budget: the same watchdog governs both calls, an
   * already-aborted run never retries, and a fallback that fails propagates like any other failure.
   */
  let pricingWarned = false
  /** A fallback was ATTEMPTED — so the error the attempt-1 catch below sees may be the MANAGED
   *  provider's, and must not be blamed on the tenant's credential. Run-scoped on purpose:
   *  only attempt 1's catch reads it, and only attempt 1 can have set it by then. */
  let triedFallback = false
  const callModel = async (attempt: number, guardrailRetry: { codes: string[] } | null, effort: LlmEffort): Promise<DraftAttempt> => {
    const meta: ChatMeta = { orgId, agentId: agent.id, runId, role: 'draft', idempotencyKey: `draft:${runId}:${attempt}` }
    let call: DraftCallResult
    // PER ATTEMPT, never run-scoped: attempt 1 can fall back and attempt 2 (the guardrail redraft)
    // still succeed on the tenant's own provider, and the breakdown's provenance has to describe the
    // attempt whose body was actually stored.
    let fellBack = false
    // Phase 7's admission slot, around the MODEL CALL alone — never around the trace writes below,
    // which take a second pool client of their own. A managed call waits for a slot; a BYOK call
    // bypasses the pool entirely (its budget is the per-credential limiter). `null` means no slot
    // freed in time, and the run PROCEEDS: an alert, never a lost draft (drafting/admission.ts).
    const admission = deps.admission ?? noAdmission
    const slot = config.mode === 'managed' ? await admission.acquire(watchdog) : null
    if (config.mode === 'managed' && slot === null) {
      alert(deps.logger, 'admission_slot_timeout', { orgId, runId, attempt })
    }
    try {
      call = await runDraftCall(resolved.provider, promptInput(guardrailRetry, effort), meta, watchdog)
    } catch (err) {
      // The credential is killed HERE, where the error is known to be the PRIMARY's — and before the
      // fallback is even considered. A fallback that succeeds never reaches the attempt-1 catch, so
      // gating the kill on `!triedFallback` down there meant an opted-in agent's key was rejected on
      // every draft, forever, and the owner was never told (review B-I2). What the fallback DOES
      // change is the ticket: a draft that landed from Managed AI is not `provider_unavailable`.
      // `killCredential` is guarded on `health_status <> 'dead'` and day-deduped, so attempt 2
      // calling it again writes nothing and pages nobody.
      if (err instanceof LlmError && err.code === 'auth' && config.mode === 'byok') {
        await killCredential(deps, orgId, config, err.message, now)
      }
      if (resolved.fallback && err instanceof LlmError && (FALLBACK_CODES as readonly string[]).includes(err.code) && !watchdog.aborted) {
        deps.logger.warn({ runId, code: err.code }, 'ticket.draft: the agent\'s own provider failed; falling back to Managed AI')
        await withOrg(deps.db, orgId, (tx) =>
          appendRunEvent(tx, runId, 'call', { attempt, fallback: true, from: config.provider, code: err.code }))
        triedFallback = true
        call = await runDraftCall(
          resolved.fallback,
          { ...promptInput(guardrailRetry, effort), model: MANAGED_MODELS.draft },
          // A DISTINCT idempotency key. `llm_calls.idempotency_key` is globally unique and
          // `withMetering`'s catch already wrote the primary's ERROR row under this attempt's key,
          // so reusing it would have the sink's ON CONFLICT DO NOTHING silently drop the managed
          // row — the fallback's spend invisible to the org's daily cap and every cost screen.
          { ...meta, idempotencyKey: `${meta.idempotencyKey}:fallback`, mode: 'managed', credentialId: undefined },
          watchdog,
        )
        fellBack = true
      } else throw err
    } finally {
      await slot?.release()
    }
    const pricing = findPricing(call.result.model)
    // A model with no seeded pricing row costs 0 here, which silently disables BOTH the stop-loss
    // and this run's contribution to the org's daily spend cap — say so out loud, once per run.
    if (!pricing && !pricingWarned) {
      pricingWarned = true
      deps.logger.warn({ runId, provider: config.provider, model: call.result.model }, 'ticket.draft: no pricing for model; cost recorded as 0')
    }
    // Priced at the TTL of the wrapper that actually SERVED this call: a fallback ran on the managed
    // stack (`'1h'`), everything else on whatever the agent's own mode implies.
    const costMicros = pricing ? computeCostMicros(call.result.usage, pricing, cacheTtlFor(fellBack ? 'managed' : config.mode)) : 0
    usage.add(call.result.usage, costMicros)
    await withOrg(deps.db, orgId, (tx) =>
      appendRunEvent(tx, runId, 'call', {
        attempt, finish: call.result.finish, parseStrategy: call.result.parseStrategy,
        model: call.result.model, latencyMs: call.result.latencyMs, costMicros, usage: call.result.usage,
      }))
    return { call, fellBack }
  }

  // --- Rule 8: model call #1.
  let firstAttempt: DraftAttempt
  try {
    firstAttempt = await callModel(1, null, firstEffort)
  } catch (err) {
    // Rule 9. The watchdog check comes FIRST: a timeout surfaces as a transient provider error, and
    // `llm_transient` would hide the real cause.
    const aborted = watchdog.aborted

    // Phase 6: a tenant key the provider REJECTED is not a transient failure — retrying it spends
    // the ticket's remaining attempts on a key that will keep saying no. The credential went `dead`
    // in `callModel`'s catch (guarded: a probe that got there first wins) with one `provider_health`
    // page; here the TICKET lands `provider_unavailable` rather than `agent_failed`, and only when
    // no fallback answered. The job does not rethrow: there is nothing for pg-boss to retry.
    if (!aborted && err instanceof LlmError && err.code === 'auth' && config.mode === 'byok' && !triedFallback) {
      // The credential is already dead: `callModel`'s own catch killed it the moment the PRIMARY
      // rejected the key, whether or not a fallback then ran. What is left here is the ticket, and
      // only when no fallback landed a draft for it.
      // `fail` returning true means the failure ceiling already escalated the ticket (`agent_failed`
      // — an owner-facing landing this must not clobber); otherwise this reason is the better one.
      const alreadyEscalated = await fail('llm_auth', errorToDetail(err), 'failed')
      if (!alreadyEscalated) await escalateProviderUnavailable(deps, orgId, ticketId, day, now, 'llm_auth')
      return
    }

    const code = aborted ? 'watchdog' : err instanceof LlmError ? `llm_${err.code}` : 'llm_unknown'
    if (await fail(code, errorToDetail(err), aborted ? 'aborted' : 'failed')) return
    throw err
  }

  const first = firstAttempt.call
  /** The attempt whose body is the one being stored — attempt 2 only when its decision replaces
   *  attempt 1's below. This is what `confidence_breakdown`'s provider/modelId/mode describe. */
  let landedFallback = firstAttempt.fellBack

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
      // Both halves of the spec's stop-loss, and both skip the redraft the same way: managed spend
      // in micro-dollars, BYOK in output tokens (which a provider always reports, priced or not).
      const totals = usage.totals()
      const stopLoss = totals.costMicros >= STOP_LOSS_MICROS
        || (config.mode === 'byok' && totals.outputTokens >= STOP_LOSS_BYOK_OUTPUT_TOKENS)
      if (stopLoss || watchdog.aborted) {
        deps.logger.warn({ runId, ticketId, stopLoss }, 'ticket.draft: skipping the automatic redraft')
      } else {
        const codes = guardrail.findings.filter((f) => f.severity === 'fail').map((f) => f.code)
        let second: DraftAttempt | null = null
        try {
          second = await callModel(2, { codes }, 'high')
        } catch (err) {
          // A failed redraft is not a failed run: the first attempt's body still goes to the owner
          // with its findings, which is the same end state a second failing attempt would produce —
          // so no `recordFailure`, and the landing below is unchanged. It still has to be VISIBLE,
          // or the run settles `succeeded` with no trace that attempt 2 ever happened. (Usage the
          // throwing call may already have burned is not recoverable — the provider only reports it
          // on a returned result.)
          const aborted = watchdog.aborted
          const code = aborted ? 'watchdog' : err instanceof LlmError ? `llm_${err.code}` : 'llm_unknown'
          await withOrg(deps.db, orgId, (tx) => appendRunEvent(tx, runId, 'error', { attempt: 2, code, message: errorToDetail(err) }))
          deps.logger.warn({ runId, ticketId, code }, 'ticket.draft: the automatic redraft failed')
        }
        if (second?.call.decision) {
          const next = second.call.decision
          decision = next
          // The stored body is now attempt 2's, so the provenance is attempt 2's too.
          landedFallback = second.fellBack
          guardrail = next.outcome === 'reply'
            ? await screen(deps, orgId, runId, 2, next, ctx, agent, ticket.language, knowledge)
            : null
        }
      }
    }
  }

  // --- Rules 13/14's shared inputs. They are computed HERE, before `decide()`, because the evidence
  // score is one of its inputs now — everything below is pure, and the non-reply outcomes simply
  // have no citations, no memory and no threshold. `computeEvidence` (drafting/evidence.ts) is the
  // ONE implementation; `agent.sandbox` reads the same one so the number the owner sees on a "Try
  // it" run is the number this gate would actually have used. The tier is the resolved model's.
  const replyDecision = decision.outcome === 'reply' ? decision : null
  const ev = computeEvidence({ knowledge, reply: replyDecision, tier: config.tier })
  const { retrievedChunkIds, retrievedAnswerIds, citedChunkIds, usedAnswerIds, memoryConflictIds } = ev
  const evidence = ev.evidence
  // The bar the evidence has to clear, as a fraction. Only an `auto` category has one at all —
  // `decide()` reads a null threshold as `below_threshold`, which is the safe direction.
  const threshold =
    replyDecision && ctx.categoryMode === 'auto' ? (ctx.autoSendMinConfidence ?? DEFAULT_AUTO_SEND_THRESHOLD) / 100 : null

  // --- Phase 7's two billing FACTS (plan deviations 6 and 7), computed once and used by both
  // `decide()` and the breakdown below. `allowanceExhausted` reads the RESOLVED model's mode: a
  // BYOK agent is never exhausted (it is the owner's own spend), and under `automatic` overage a
  // standard workspace simply accrues metered units instead of stopping.
  const allowanceExhausted = isAllowanceExhausted({
    mode: config.mode,
    plan: pre.billing.plan,
    overageMode: pre.billing.overageMode,
    used: pre.managedUsed,
    allowance: pre.billing.allowance,
  })

  // --- Rule 14: the autonomy decision, then the landing.
  const verdict = decide({
    platformKillSwitch: false, // rule 1 already returned if the lever were on
    workspaceKillSwitch: ctx.workspaceKillSwitch,
    agentEnabled: ctx.agentEnabled,
    agentActive: agent.status === 'active',
    subscriptionActive: pre.billing.active,
    tripwire: false, // a tripwired ticket is never `triaged`, so a draft run can never see one
    outcome: decision.outcome,
    ownerFeedbackPending,
    guardrail: guardrail ? { ok: guardrail.ok, warningCount: guardrail.warningCount } : { ok: true, warningCount: 0 },
    dmarcPass: ctx.dmarcPass,
    categoryMode: ctx.categoryMode,
    isRedraft,
    memoryConflict: memoryConflictIds.length > 0,
    unresolvedQuestions: replyDecision !== null && replyDecision.unresolvedQuestions.length > 0,
    threadTooLong: ctx.threadLength > THREAD_MAX_MESSAGES_FOR_AUTO,
    humanDecisionCount: ctx.humanDecisionCount,
    evidence,
    threshold,
    hasAttachments: ticket.hasAttachments,
    allowanceExhausted,
    autoSendCapReached: ctx.autoSendsToday >= resolveSetting('autonomy.daily_auto_send_cap', pre.sources),
    mailboxHealthy: ctx.mailboxHealthy,
  })
  await withOrg(deps.db, orgId, (tx) =>
    appendRunEvent(tx, runId, 'decision', {
      outcome: decision.outcome, action: verdict.action, reason: verdict.reason, quiet: verdict.quiet === true,
      guardrailOk: guardrail?.ok ?? null, warningCount: guardrail?.warningCount ?? null,
      evidence, threshold,
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

  // `send` is the auto landing (Phase 5): the draft is stored already approved beside a `queued`
  // send due when the agent's hold window elapses. `escalate` is `guardrail_failed` or
  // `category_off`; everything else lands in the review queue.
  const landing: DraftLanding =
    verdict.action === 'send'
      ? {
          kind: 'auto',
          decisionReason: verdict.reason,
          delayMin: agent.autoSendDelayMin,
          sendAfter: new Date((deps.now?.() ?? new Date()).getTime() + agent.autoSendDelayMin * 60_000),
          pushAutoSends: resolveSetting('notifications.push_auto_sends', pre.sources),
        }
      : verdict.action === 'escalate'
        ? {
            kind: 'escalate',
            reason: verdict.reason === 'category_off' ? 'category_off' : 'guardrail_failed',
            decisionReason: verdict.reason,
            quiet: verdict.quiet === true,
          }
        : { kind: 'review', decisionReason: verdict.reason }

  try {
    const { notificationId, sendId } = await applyDraftOutcome(outcomeCtx(), landing, {
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
          memoryConflict: memoryConflictIds.length > 0,
          unresolvedQuestions: decision.unresolvedQuestions.length > 0,
          threadTooLong: ctx.threadLength > THREAD_MAX_MESSAGES_FOR_AUTO,
          autoSendCap: ctx.autoSendsToday >= resolveSetting('autonomy.daily_auto_send_cap', pre.sources),
          // Phase 7. The allowance is recorded with the numbers it was judged on, not just a
          // boolean: "why did this not auto-send?" is answerable from the draft alone.
          allowance: {
            used: pre.managedUsed, allowance: pre.billing.allowance,
            mode: pre.billing.overageMode, exhausted: allowanceExhausted,
          },
          subscription: pre.billing.state,
        },
        // The CAPPED model term — what the evidence score was actually built from (Phase 6). The
        // model's own uncapped number is `modelRaw` beside it, and `drafts.confidence` above.
        model: ev.modelCapped,
        modelRaw: ev.modelRaw,
        modelCap: QUALITY_CAPS[config.tier],
        tier: config.tier,
        // WHICH model produced this body. A fallback ran on Managed AI, so it must not be recorded
        // as the tenant's own provider — `stats.rollup`'s model-generation window reads these.
        provider: landedFallback ? 'anthropic' : config.provider,
        modelId: landedFallback ? MANAGED_MODELS.draft : config.model,
        mode: landedFallback ? 'managed' : config.mode,
        modelGeneration: config.modelGeneration,
        // The best USED answer and what it scored — the owner's "why did it auto-send?" answer.
        memory: ev.memory,
        grounding: {
          // The best VALIDATED citation's retrieval score — an id the model invented was already
          // filtered out above, so it can never raise this. Null when nothing was cited at all.
          score: ev.groundingScore,
          mode: knowledgeMode,
          knowledgeVersion,
          retrieved: retrievedChunkIds.length,
          cited: citedChunkIds.length,
        },
        // `max(memory, grounding) × model` — the number the auto gate compared against `threshold`
        // (deviation 1: `drafts.confidence` still means the model's own self-assessment).
        evidence,
        threshold,
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
    // The draft, the send row and the ticket flip are COMMITTED by here, so a queue hiccup must not
    // take the run down with it — and the backstop sweep's due-send arm (d), which selects on
    // `outbound_sends` alone, re-enqueues an auto-send whose job never landed.
    if (sendId !== undefined && landing.kind === 'auto') {
      try {
        await deps.enqueueSend(orgId, sendId, { startAfter: landing.sendAfter })
      } catch (err) {
        deps.logger.warn(
          { orgId, ticketId, sendId, error: err instanceof Error ? err.message : String(err) },
          'ticket.draft: enqueueing the auto-send failed; the backstop due-send sweep will pick it up',
        )
      }
    }
    if (notificationId) await deps.enqueueNotify(orgId, notificationId)
  } catch (err) {
    if (!(err instanceof LostRaceError)) throw err
    // Someone moved the ticket while the model call was in flight. The draft is dropped on the
    // floor — nothing is anchored to it — but the run still finished, so it is finalized.
    await recordLostRace(outcomeCtx(), err.auditAction)
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
  // The SAME construction `send.execute`'s third pass uses — see `drafting/policy.ts` for why the
  // two gates must never screen against different policies.
  const policy = buildReplyPolicy({
    workspace: {
      allowedUrlHosts: ctx.profile.allowedUrlHosts,
      allowedEmailDomains: ctx.profile.allowedEmailDomains,
      contactPhone: ctx.profile.contactPhone,
      contactUrls: ctx.profile.contactUrls,
      locale: ctx.profile.locale,
    },
    agent,
    workspaceGuidance: ctx.workspaceGuidance,
    agentGuidance: ctx.agentGuidance,
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
