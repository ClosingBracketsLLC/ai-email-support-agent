/**
 * The `agent.sandbox` job: the owner's "Try it" run. It pushes a hand-typed question through the
 * REAL draft pipeline — the six-layer prompt, the model call, the guardrails, `decide()` — exactly
 * as `ticket.draft` would for a real thread, but against a SYNTHETIC one-message thread and a
 * ticket stub built from the run's own `input`, never a real ticket or draft row. `decide()` here
 * is purely informational: its verdict rides on `agent_runs.output` for the owner to read, and is
 * never acted on.
 *
 * The api (a later task) inserts the `agent_runs` row itself — kind `sandbox`, status `running`,
 * `input: { subject, question }` — under the sandbox cap, then enqueues `{ orgId, runId }`. This
 * job only ever reads that row; it never claims one, never re-checks a cap, and never writes a
 * `tickets` or `drafts` row.
 *
 * **Every database touch is a short `withOrg` transaction, and the model call and the retrieval
 * call happen OUTSIDE every one of them** — same discipline as `ticket.draft` (see that file's
 * header). `retryLimit: 0`: unlike `ticket.draft`, this job never rethrows on a model or watchdog
 * failure — a failed run IS the answer the owner sees, so every failure path ends in `finishRun`
 * and a plain `return`.
 */
import { and, count, eq, isNotNull } from 'drizzle-orm'
import type PgBoss from 'pg-boss'
import type pino from 'pino'
import { z } from 'zod'
import {
  createUsageAccumulator, guidanceBlock, personaBlock, platformRulesBlock, runDraftCall,
  withWatchdog, workspaceProfileBlock,
  type DraftCallResult, type DraftDecision, type DraftPromptInput, type RetrievedAnswer,
  type RetrievedChunk, type Retriever, type ThreadMessage, type UsageTotals,
} from '@aesa/agent'
import { DEFAULT_AUTO_SEND_THRESHOLD, type DecisionAction, type DecisionReason } from '@aesa/contracts'
import {
  collectGroundedNumbers, decide, evidenceScore, memoryScore, validateReplyBody,
  type GuardrailFinding, type GuardrailResult,
} from '@aesa/core'
import { agentCategoryPolicies, agentRuns, agents, drafts, mailboxConnections, platformState, withOrg, type Db } from '@aesa/db'
import { computeCostMicros, findPricing, LlmError, type ChatMeta, type LlmProvider } from '@aesa/llm'
import { defineJob, JOB_NAMES, registerJob, type RegisteredJobDefinition } from '@aesa/queue'
import { loadSharedDraftContext, type SharedDraftContext } from '../drafting/context.ts'
import { errorMessage } from '../err-message.ts'
import { buildReplyPolicy, personaFor } from '../drafting/policy.ts'
import { appendRunEvent, finishRun } from '../drafting/runs.ts'
import type { ProviderResolver } from '../provider-resolver.ts'

export const AgentSandboxPayload = z.object({ orgId: z.string(), runId: z.string() })
export type AgentSandboxPayload = z.infer<typeof AgentSandboxPayload>

/** The importable definition: the api's `enqueue()` (Task 18) only ever reads `.name`/`.schema`. */
export const agentSandboxJob: RegisteredJobDefinition<AgentSandboxPayload> = defineJob({
  name: JOB_NAMES.agentSandbox,
  schema: AgentSandboxPayload,
  // policy: 'short' (QUEUE_OPTIONS), so the `singletonKey` on `${orgId}:${runId}` actually collapses
  // a double-tap of "Try it" while the first job is still `created` (fix wave W8: it is inert on
  // `standard`).
  handler: async () => {
    throw new Error('agent.sandbox: this definition has no bound deps — register it through registerAgentSandbox(boss, deps)')
  },
})

export interface AgentSandboxDeps {
  db: Db
  provider: LlmProvider
  /** Phase 6: the per-tenant provider resolver. Task 6 moves this job's model call onto it and drops
   *  `provider` above; until then it rides alongside, wired but unread. */
  providers: ProviderResolver
  retriever: Retriever
  logger: pino.Logger
  now?: () => Date
  /** Test seam: the watchdog budget for the whole run (default `INVARIANTS.DRAFT_WATCHDOG_SECONDS`). */
  watchdogMs?: number
}

export interface SandboxOutput {
  outcome: 'reply' | 'escalate' | 'no_reply'
  /** The ONLY place a customer-facing body lives on `agent_runs.output` — acceptable because the
   *  "customer" here is the owner's own question. `body` is the model's raw candidate; `normalizedBody`
   *  is what the guardrails screened (NFKC + format-char strip) — null for every outcome but `reply`. */
  body: string | null
  normalizedBody: string | null
  guardrail: { ok: boolean; findings: GuardrailFinding[] } | null
  confidence: number | null
  /** `max(memory, grounding) × model` — the number a REAL draft's auto gate would compare against
   *  the category's threshold. Null for every outcome but `reply` (deviation 12: informational). */
  evidence: number | null
  /** `decide()`'s verdict — informational only; a sandbox run never acts on it. */
  decision: DecisionAction
  decisionReason: DecisionReason
  /** The model's own escalate/no_reply reason, or `'content_filtered'` for a provider refusal. Null for `reply`. */
  reason: string | null
  rationale: string
  unresolvedQuestions: string[]
  usage: UsageTotals
}

export async function registerAgentSandbox(boss: PgBoss, deps: AgentSandboxDeps): Promise<void> {
  const wired: RegisteredJobDefinition<AgentSandboxPayload> = {
    ...agentSandboxJob,
    handler: async (ctx) => {
      await runAgentSandbox(deps, ctx.data, ctx.signal)
    },
  }
  await registerJob(boss, wired)
}

/** Carries a specific `errorCode` out of `loadPreload`'s defensive invariant checks, so the
 *  top-level catch in `runAgentSandbox` can record something more useful than the generic
 *  `internal` fallback for a case that is really "this run has no agent to try". */
class SandboxLoadError extends Error {
  constructor(message: string, readonly code: string) {
    super(message)
    this.name = 'SandboxLoadError'
  }
}

const AGENT_COLUMNS = {
  id: agents.id,
  connectionId: agents.connectionId,
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

const RunInput = z.object({ subject: z.string(), question: z.string() })

interface Preload {
  agent: AgentRow
  shared: SharedDraftContext
  input: z.infer<typeof RunInput>
  platformKillSwitch: boolean
  mailboxHealthy: boolean
}

/**
 * ONE read-only transaction: the run row (kind/status guard — every other case is a policy no-op
 * that writes nothing), its agent, the ticket-independent shared draft context, its connection's
 * health, and the platform kill lever. Returns null for "this job has nothing to do".
 */
async function loadPreload(db: Db, orgId: string, runId: string): Promise<Preload | null> {
  return withOrg(db, orgId, async (tx) => {
    const [run] = await tx
      .select({ status: agentRuns.status, kind: agentRuns.kind, agentId: agentRuns.agentId, input: agentRuns.input })
      .from(agentRuns)
      .where(eq(agentRuns.id, runId))
    if (!run || run.status !== 'running' || run.kind !== 'sandbox') return null
    if (!run.agentId) throw new SandboxLoadError(`agent.sandbox: run ${runId} has no agent`, 'no_agent')

    const [agent] = await tx.select(AGENT_COLUMNS).from(agents).where(eq(agents.id, run.agentId))
    if (!agent) throw new SandboxLoadError(`agent.sandbox: run ${runId}'s agent ${run.agentId} is missing`, 'no_agent')

    const shared = await loadSharedDraftContext(tx, orgId)

    const [connection] = await tx
      .select({ status: mailboxConnections.status })
      .from(mailboxConnections)
      .where(eq(mailboxConnections.id, agent.connectionId))

    const [lever] = await tx.select({ value: platformState.value }).from(platformState).where(eq(platformState.key, 'killswitch.global'))

    return {
      agent,
      shared,
      input: RunInput.parse(run.input),
      platformKillSwitch: lever?.value === true,
      mailboxHealthy: connection?.status === 'connected',
    }
  })
}

/** The org's category matching the model's claimed key, falling back to `other` for anything it
 * invents — the same rule `ticket.draft`'s own `resolveCategory` applies. */
function resolveCategory(cats: { id: string; key: string; label: string }[], key: string): { id: string; label: string } | null {
  const match = cats.find((c) => c.key === key) ?? cats.find((c) => c.key === 'other')
  return match ? { id: match.id, label: match.label } : null
}

function errorToDetail(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * The same guardrail construction `ticket.draft`'s `screen()` uses — see `drafting/policy.ts` for
 * why every gate that touches a reply body must screen against the identical policy. Unlike
 * `ticket.draft`, there is never a second attempt: the sandbox's ONE model call either passes or
 * fails the screen, and either way the run reports what happened.
 */
async function screenSandboxReply(
  deps: AgentSandboxDeps,
  orgId: string,
  runId: string,
  decision: Extract<DraftDecision, { outcome: 'reply' }>,
  shared: SharedDraftContext,
  agent: AgentRow,
  knowledge: { chunks: RetrievedChunk[]; answers: RetrievedAnswer[] },
  threadBodies: string[],
): Promise<GuardrailResult> {
  const policy = buildReplyPolicy({
    workspace: {
      allowedUrlHosts: shared.profile.allowedUrlHosts,
      allowedEmailDomains: shared.profile.allowedEmailDomains,
      contactPhone: shared.profile.contactPhone,
      contactUrls: shared.profile.contactUrls,
      locale: shared.profile.locale,
    },
    agent,
    workspaceGuidance: shared.workspaceGuidance,
    agentGuidance: agent.guidanceExtra,
    // The sandbox's ticket stub carries no known language (spec's stub: `language: null`).
    expectedLanguage: null,
  })
  const groundedNumbers = collectGroundedNumbers([
    ...threadBodies,
    shared.profile.description ?? '',
    shared.workspaceGuidance,
    agent.guidanceExtra,
    ...knowledge.chunks.map((c) => c.content),
    ...knowledge.answers.map((a) => `${a.question}\n${a.answer}`),
  ])
  const result = validateReplyBody(decision.body, policy, { replyLanguage: decision.customerLanguage, groundedNumbers })
  await withOrg(deps.db, orgId, (tx) =>
    appendRunEvent(tx, runId, 'guardrail', {
      attempt: 1, ok: result.ok, warningCount: result.warningCount, codes: result.findings.map((f) => f.code),
    }))
  return result
}

const CUSTOMER_ADDRESS = 'customer@example.com'

/**
 * The never-throws contract's outer belt: `retryLimit: 0` means the ONLY way a failed run tells
 * its story is a `finishRun`/`error` event this job writes itself, so ANY exception that escapes
 * the run — a defensive invariant throw out of `loadPreload`, a DB error in the final `decide()` +
 * `finishRun` transaction, or even a failure inside `fail()`'s own write — is caught HERE, once,
 * rather than at each call site. Without this, that exception would propagate out of the pg-boss
 * handler and leave `agent_runs` stuck `running` until the backstop sweep's `markStuckRuns` gets to
 * it, long after the owner's "Try it" spinner has given up.
 */
export async function runAgentSandbox(deps: AgentSandboxDeps, payload: AgentSandboxPayload, signal: AbortSignal): Promise<void> {
  const { orgId, runId } = payload
  const usage = createUsageAccumulator()
  try {
    await runAgentSandboxUnsafe(deps, payload, signal, usage)
  } catch (err) {
    await recordUnexpectedFailure(deps, orgId, runId, usage, err)
  }
}

/**
 * Best-effort failure record for anything `runAgentSandboxUnsafe` let escape. `code` is the
 * specific `SandboxLoadError.code` when the escape came from `loadPreload`'s own invariant checks
 * (today, always `no_agent`), else the generic `internal` — either way `errorMessage` is the
 * caught error's own message, never anything built from the run's question text. If even this
 * write throws (the DB is genuinely unreachable), log and give up: the handler must resolve either
 * way, never rethrow a second time.
 */
async function recordUnexpectedFailure(
  deps: AgentSandboxDeps,
  orgId: string,
  runId: string,
  usage: ReturnType<typeof createUsageAccumulator>,
  err: unknown,
): Promise<void> {
  const code = err instanceof SandboxLoadError ? err.code : 'internal'
  const detail = errorToDetail(err)
  // `errorMessage(err)`, never `{ err }` (final-A1 M1): pino's default err serializer copies every
  // own enumerable property of the error, and node-postgres puts the WHOLE offending row on
  // `detail` ("Failing row contains (…)") — which on this path is most likely `agent_runs.output`,
  // i.e. a drafted body. No draft body may reach a log line.
  deps.logger.error({ runId, orgId, error: errorMessage(err) }, 'agent.sandbox: run failed unexpectedly')
  try {
    const finishedAt = deps.now?.() ?? new Date()
    await withOrg(deps.db, orgId, async (tx) => {
      const settled = await finishRun(tx, { runId, status: 'failed', errorCode: code, errorMessage: detail.slice(0, 500), usage: usage.totals(), now: finishedAt })
      if (!settled) deps.logger.warn({ runId }, 'agent.sandbox: run was already settled')
      await appendRunEvent(tx, runId, 'error', { code, detail })
    })
  } catch (recordErr) {
    deps.logger.error({ runId, orgId, error: errorMessage(recordErr) }, 'agent.sandbox: failed to record the run failure itself; giving up')
  }
}

async function runAgentSandboxUnsafe(
  deps: AgentSandboxDeps,
  payload: AgentSandboxPayload,
  signal: AbortSignal,
  usage: ReturnType<typeof createUsageAccumulator>,
): Promise<void> {
  const { orgId, runId } = payload
  const now = deps.now?.() ?? new Date()

  const pre = await loadPreload(deps.db, orgId, runId)
  if (pre === null) return
  const { agent, shared, input } = pre

  // The synthetic one-message thread and ticket stub the spec pins: a "Try it" run has no real
  // thread, so it builds the smallest one the draft prompt can consume.
  const thread: ThreadMessage[] = [{ direction: 'inbound', at: now, from: CUSTOMER_ADDRESS, body: input.question }]

  const blocks = [
    platformRulesBlock(),
    workspaceProfileBlock(shared.profile),
    personaBlock(personaFor(agent)),
    guidanceBlock({ workspaceGuidance: shared.workspaceGuidance, agentGuidance: agent.guidanceExtra }),
  ].filter((b) => b !== null)
  await withOrg(deps.db, orgId, (tx) =>
    appendRunEvent(tx, runId, 'prompt', {
      blocks: blocks.map((b) => ({ id: b.id, chars: b.text.length })),
      effort: 'medium',
      cacheAgentBlocks: false,
      threadMessages: thread.length,
    }))

  /** Settles the run as a failure and traces it. Never throws — `retryLimit: 0` means a failed run
   *  IS the answer the owner sees, so there is nothing for pg-boss to retry. */
  const fail = async (code: string, detail: string, status: 'failed' | 'aborted'): Promise<void> => {
    const finishedAt = deps.now?.() ?? new Date()
    await withOrg(deps.db, orgId, async (tx) => {
      const settled = await finishRun(tx, { runId, status, errorCode: code, errorMessage: detail.slice(0, 500), usage: usage.totals(), now: finishedAt })
      if (!settled) deps.logger.warn({ runId }, 'agent.sandbox: run was already settled')
      await appendRunEvent(tx, runId, 'error', { code, detail })
    })
  }

  const watchdog = withWatchdog(signal, deps.watchdogMs)

  // Retrieval, OUTSIDE every transaction. Empty in Phase 3.
  let knowledge: { chunks: RetrievedChunk[]; answers: RetrievedAnswer[] }
  try {
    knowledge = await deps.retriever.retrieve({ orgId, questions: [], text: input.question, signal: watchdog })
  } catch (err) {
    const aborted = watchdog.aborted
    await fail(aborted ? 'watchdog' : 'retrieval', errorToDetail(err), aborted ? 'aborted' : 'failed')
    return
  }

  const promptInput: DraftPromptInput = {
    ticket: { subject: input.subject, categoryKey: null, sentiment: null, language: null, triageQuestions: [], dmarcPass: true },
    thread,
    priorDraft: null,
    ownerFeedback: null,
    guardrailRetry: null,
    categoryKeys: shared.cats.map((c) => c.key),
    profile: shared.profile,
    persona: personaFor(agent),
    guidance: { workspaceGuidance: shared.workspaceGuidance, agentGuidance: agent.guidanceExtra },
    knowledge,
    cacheAgentBlocks: false,
    effort: 'medium',
  }

  // ONE model call — no automatic redraft: the sandbox's job is to show the owner what the REAL
  // pipeline would do on the first attempt, guardrail failure and all.
  const meta: ChatMeta = { orgId, agentId: agent.id, runId, role: 'draft', idempotencyKey: `sandbox:${runId}:1` }
  let call: DraftCallResult
  try {
    call = await runDraftCall(deps.provider, promptInput, meta, watchdog)
  } catch (err) {
    const aborted = watchdog.aborted
    const code = aborted ? 'watchdog' : err instanceof LlmError ? `llm_${err.code}` : 'llm_unknown'
    await fail(code, errorToDetail(err), aborted ? 'aborted' : 'failed')
    return
  }
  const pricing = findPricing(call.result.model)
  if (!pricing) {
    deps.logger.warn({ runId, provider: deps.provider.kind, model: call.result.model }, 'agent.sandbox: no pricing for model; cost recorded as 0')
  }
  const costMicros = pricing ? computeCostMicros(call.result.usage, pricing, '1h') : 0
  usage.add(call.result.usage, costMicros)
  await withOrg(deps.db, orgId, (tx) =>
    appendRunEvent(tx, runId, 'call', {
      attempt: 1, finish: call.result.finish, parseStrategy: call.result.parseStrategy,
      model: call.result.model, latencyMs: call.result.latencyMs, costMicros, usage: call.result.usage,
    }))

  // An unparsable envelope: the structured-output ladder has already spent its rungs.
  if (call.decision === null && call.result.finish !== 'refusal') {
    const detail = `finish ${call.result.finish}, parse strategy ${call.result.parseStrategy}`
    await fail('unparsable', detail, 'failed')
    return
  }

  // A refusal is `content_filtered`: with no body there is nothing to review, so it reads as an
  // escalation the same way `ticket.draft` treats one.
  const contentFiltered = call.decision === null
  const decision: DraftDecision = call.decision ?? { outcome: 'escalate', reason: 'other', rationale: 'the model declined to answer this thread' }

  // Rule 13's screen, its OWN short transaction (never nested inside another) — same discipline as
  // `ticket.draft`'s `screen()`, called between the model call and the decide()+finish step below.
  const guardrail: GuardrailResult | null =
    decision.outcome === 'reply'
      ? await screenSandboxReply(deps, orgId, runId, decision, shared, agent, knowledge, thread.map((m) => m.body))
      : null

  // Parity with `ticket.draft`'s evidence maths (deviation 12), computed on the SAME inputs: the
  // answers the model actually used, banded by cosine and scaled by human approvals. A sandbox run
  // never acts on any of it — it exists so the owner sees the number a real draft would be judged on.
  const replyDecision = decision.outcome === 'reply' ? decision : null
  const retrievedChunkIds = knowledge.chunks.map((c) => c.id)
  const retrievedAnswerIds = knowledge.answers.map((a) => a.id)
  const citedChunkIds = replyDecision ? replyDecision.citedChunkIds.filter((id) => retrievedChunkIds.includes(id)) : []
  const usedAnswerIds = replyDecision ? replyDecision.usedAnswerIds.filter((id) => retrievedAnswerIds.includes(id)) : []
  const memoryConflictIds = replyDecision
    ? replyDecision.memoryConflictIds.filter((id) => retrievedChunkIds.includes(id) || retrievedAnswerIds.includes(id))
    : []
  const citedScores = knowledge.chunks.filter((c) => citedChunkIds.includes(c.id)).map((c) => c.score)
  const groundingScore = citedScores.length > 0 ? Math.max(...citedScores) : null
  const memoryBest = knowledge.answers
    .filter((a) => usedAnswerIds.includes(a.id))
    .reduce<number | null>((best, a) => {
      const score = memoryScore(a.score, a.approvals)
      return best === null || score > best ? score : best
    }, null)
  const evidence = replyDecision
    ? evidenceScore({ memory: memoryBest ?? 0, grounding: groundingScore, model: replyDecision.confidence })
    : null

  const finishedAt = deps.now?.() ?? new Date()
  await withOrg(deps.db, orgId, async (tx) => {
    let categoryMode: 'off' | 'review' | 'auto' = 'review'
    let autoSendMinConfidence: number | null = null
    let humanDecisionCount = 0

    if (decision.outcome === 'reply') {
      const category = resolveCategory(shared.cats, decision.categoryKey)
      if (category) {
        const [policy] = await tx
          .select({ mode: agentCategoryPolicies.mode, autoSendMinConfidence: agentCategoryPolicies.autoSendMinConfidence })
          .from(agentCategoryPolicies)
          .where(and(eq(agentCategoryPolicies.agentId, agent.id), eq(agentCategoryPolicies.categoryId, category.id)))
        if (policy) {
          categoryMode = policy.mode as 'off' | 'review' | 'auto'
          autoSendMinConfidence = policy.autoSendMinConfidence
        }

        const [decided] = await tx
          .select({ value: count() })
          .from(drafts)
          .where(and(eq(drafts.agentId, agent.id), eq(drafts.categoryId, category.id), isNotNull(drafts.decidedBy)))
        humanDecisionCount = decided?.value ?? 0
      }
    }
    const threshold =
      replyDecision && categoryMode === 'auto' ? (autoSendMinConfidence ?? DEFAULT_AUTO_SEND_THRESHOLD) / 100 : null

    const verdict = decide({
      platformKillSwitch: pre.platformKillSwitch,
      workspaceKillSwitch: shared.workspaceKillSwitch,
      agentEnabled: shared.agentEnabled,
      agentActive: agent.status === 'active',
      subscriptionActive: true,
      tripwire: false,
      outcome: decision.outcome,
      ownerFeedbackPending: false,
      guardrail: guardrail ? { ok: guardrail.ok, warningCount: guardrail.warningCount } : { ok: true, warningCount: 0 },
      dmarcPass: true,
      categoryMode,
      isRedraft: false,
      memoryConflict: memoryConflictIds.length > 0,
      unresolvedQuestions: replyDecision !== null && replyDecision.unresolvedQuestions.length > 0,
      // The sandbox's synthetic thread is one message, so this blocker can never fire here.
      threadTooLong: false,
      humanDecisionCount,
      evidence,
      threshold,
      hasAttachments: false,
      allowanceExhausted: false,
      // A "Try it" run never sends, so it never consumes — let alone exhausts — the daily cap.
      autoSendCapReached: false,
      mailboxHealthy: pre.mailboxHealthy,
    })

    await appendRunEvent(tx, runId, 'decision', {
      outcome: decision.outcome, action: verdict.action, reason: verdict.reason, quiet: verdict.quiet === true,
      guardrailOk: guardrail?.ok ?? null, warningCount: guardrail?.warningCount ?? null,
      evidence, threshold,
    })

    const output: SandboxOutput =
      decision.outcome === 'reply'
        ? {
            outcome: 'reply',
            body: decision.body,
            normalizedBody: guardrail!.normalizedBody,
            guardrail: { ok: guardrail!.ok, findings: guardrail!.findings },
            confidence: decision.confidence,
            evidence,
            decision: verdict.action,
            decisionReason: verdict.reason,
            reason: null,
            rationale: decision.rationale,
            unresolvedQuestions: decision.unresolvedQuestions,
            usage: usage.totals(),
          }
        : {
            outcome: decision.outcome,
            body: null,
            normalizedBody: null,
            guardrail: null,
            confidence: null,
            evidence: null,
            decision: verdict.action,
            decisionReason: verdict.reason,
            reason: contentFiltered ? 'content_filtered' : decision.reason,
            rationale: decision.rationale,
            unresolvedQuestions: [],
            usage: usage.totals(),
          }

    const settled = await finishRun(tx, { runId, status: 'succeeded', output, usage: usage.totals(), now: finishedAt })
    if (!settled) deps.logger.warn({ runId }, 'agent.sandbox: run was already settled')
  })
}
