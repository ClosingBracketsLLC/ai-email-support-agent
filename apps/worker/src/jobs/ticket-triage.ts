/**
 * The `ticket.triage` job (Phase 2 slice — spec §Triage). Ports three things from doge-buddy's
 * `apps/ops/src/support/triage.ts`, adapted from its per-cycle loop over many tickets to this
 * codebase's one-job-per-ticket shape:
 *
 *  - The fail-closed spend guard's write-BEFORE-the-call ordering (a crash mid-call still counts
 *    the spend — over-counting a call that never billed is the safe direction).
 *  - Every status write guarded on the status the ticket was SELECTED with (`WHERE id = $ AND
 *    status = $selected`, `.returning()`; zero rows means a concurrent owner action already moved
 *    the ticket, and this job backs off silently rather than clobbering it).
 *  - The once-per-UTC-day cap-warning discipline, here expressed as a `notifications` row keyed by
 *    `triage_cap:${ticketId}:${utcDay}` so a second cap hit on the same ticket the same day is a
 *    silent no-op rather than a second page.
 *
 * `@aesa/agent` (the prompt + the one model call) has no database dependency; this file owns every
 * read and write, and the model call itself always runs OUTSIDE a `withOrg` transaction — a
 * transaction must never span network I/O (the app role's 5 s idle-in-transaction timeout would
 * turn a slow model call into a killed connection).
 */
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import type PgBoss from 'pg-boss'
import type pino from 'pino'
import { z } from 'zod'
import {
  createUsageAccumulator, runTriageCallDetailed, TRIAGE_BODY_COUNT, TRIAGE_MAX_BODY_CHARS,
  type TriageCallResult, type UsageTotals,
} from '@aesa/agent'
import { MANAGED_MODELS, type TriageVerdict } from '@aesa/contracts'
import { resolveSetting, type SettingKey } from '@aesa/core'
import {
  agentRuns, audit, categories, escalationDedupeKey, insertEscalationNotification, messages, orgSettings,
  tickets, usageCounters, withOrg, workspaces, type Db, type OrgTx,
} from '@aesa/db'
import { computeCostMicros, findPricing, LlmError, type ChatMeta } from '@aesa/llm'
import { defineJob, registerJob, JOB_NAMES, type RegisteredJobDefinition } from '@aesa/queue'
import { appendRunEvent, finishRun } from '../drafting/runs.ts'
import { cacheTtlFor, FALLBACK_CODES, type ProviderResolver } from '../provider-resolver.ts'

/** The usage_counters meter this job's spend guard reads and writes. */
const TRIAGE_METER = 'triage_calls'
/** Ported from doge-buddy: escalate once a ticket has burned this many failed/unparseable attempts. */
const TRIAGE_FAILURE_ESCALATE_AT = 2

export const TicketTriagePayload = z.object({ orgId: z.string(), ticketId: z.string() })
export type TicketTriagePayload = z.infer<typeof TicketTriagePayload>

/**
 * The importable definition: other jobs (Task 15's mailbox sync) `enqueue()` against this — which
 * only ever reads `.name`/`.schema` — never against a handler bound to no deps. The handler here is
 * an intentionally-unreachable placeholder; `registerTicketTriage` below builds the real, deps-bound
 * definition and registers THAT.
 */
export const ticketTriageJob: RegisteredJobDefinition<TicketTriagePayload> = defineJob({
  name: JOB_NAMES.ticketTriage,
  schema: TicketTriagePayload,
  handler: async () => {
    throw new Error('ticket.triage: this definition has no bound deps — register it through registerTicketTriage(boss, deps)')
  },
})

export interface TicketTriageDeps {
  db: Db
  /** Phase 6: the ONE way this job gets a model. A ticket with no agent yet (routing has not run)
   *  resolves the workspace default, which is Managed AI unless an owner configured otherwise. */
  providers: ProviderResolver
  logger: pino.Logger
  /** index.ts wires this to `enqueueNotifyDispatch` (`notify-dispatch.ts`, Task 16). */
  enqueueNotify: (orgId: string, notificationId: string) => Promise<void>
  /**
   * Phase 3 hand-off: a ticket that lands on `triaged` is drafting work. Called AFTER the verdict
   * transaction commits (and only when the guarded write actually landed), so the draft job can
   * never read a ticket the verdict has not been written for yet. Optional so Phase 2's own tests
   * and any caller that only wants triage keep working.
   */
  enqueueDraft?: (orgId: string, ticketId: string) => Promise<void>
  now?: () => Date
}

export async function registerTicketTriage(boss: PgBoss, deps: TicketTriageDeps): Promise<void> {
  const wired: RegisteredJobDefinition<TicketTriagePayload> = {
    ...ticketTriageJob,
    handler: async (ctx) => {
      await runTicketTriage(deps, ctx.data, ctx.signal)
    },
  }
  await registerJob(boss, wired)
}

// -- Selection (rule 1) --

interface SelectedTicket {
  id: string
  status: string
  /** Nullable: routing may not have picked an agent yet, and a null agent resolves the workspace default. */
  agentId: string | null
  subject: string | null
  isAutomated: boolean | null
  spamFlagged: boolean
  triageFailureCount: number
}

/**
 * `new`, or `triaged` with a genuinely new inbound since the last verdict, or `needs_owner` with
 * `needsOwnerReason: 'triage_cap'` — the ONE needs_owner reason this job may re-select (Task 15's
 * poll-sweep re-entry: `needs_owner -> new` is not a legal edge in `@aesa/core`'s `ticketTransitions`
 * matrix, so the sweep only enqueues; re-selecting the ticket here and landing the verdict through
 * `needs_owner -> triaged/resolved` — both legal — is what actually re-runs it). Every OTHER
 * needs_owner reason (the tripwire's queue, `triage_flags`, `sentiment_angry`, `triage_failed`) is
 * never selectable — an owner-facing escalation must never be silently re-triaged out from under them.
 */
function isSelectable(t: { status: string; needsOwnerReason: string | null; lastInboundAt: Date | null; lastTriagedAt: Date | null }): boolean {
  if (t.status === 'new') return true
  if (t.status === 'needs_owner') return t.needsOwnerReason === 'triage_cap'
  if (t.status !== 'triaged' || !t.lastInboundAt) return false
  return !t.lastTriagedAt || t.lastInboundAt > t.lastTriagedAt
}

function utcDayString(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function buildOrgSettings(rows: { key: string; value: unknown }[]): Partial<Record<SettingKey, unknown>> {
  const out: Partial<Record<SettingKey, unknown>> = {}
  for (const row of rows) out[row.key as SettingKey] = row.value
  return out
}

interface LoadedContext {
  ticket: SelectedTicket
  bodies: string[]
  categories: { id: string; key: string }[]
  businessName: string
  settings: Partial<Record<SettingKey, unknown>>
  callsToday: number
}

/** One read-only `withOrg` tx: the ticket (if selectable), its context, and today's spend so far. */
async function loadContext(db: Db, orgId: string, ticketId: string, day: string): Promise<LoadedContext | null> {
  return withOrg(db, orgId, async (tx) => {
    const [ticket] = await tx
      .select({
        id: tickets.id,
        status: tickets.status,
        agentId: tickets.agentId,
        subject: tickets.subject,
        isAutomated: tickets.isAutomated,
        spamFlagged: tickets.spamFlagged,
        triageFailureCount: tickets.triageFailureCount,
        needsOwnerReason: tickets.needsOwnerReason,
        lastInboundAt: tickets.lastInboundAt,
        lastTriagedAt: tickets.lastTriagedAt,
      })
      .from(tickets)
      .where(eq(tickets.id, ticketId))
    if (!ticket || !isSelectable(ticket)) return null

    const bodyRows = await tx
      .select({ bodyText: messages.bodyText })
      .from(messages)
      .where(and(eq(messages.ticketId, ticketId), eq(messages.direction, 'inbound')))
      .orderBy(desc(messages.sentAt))
      .limit(TRIAGE_BODY_COUNT)
    const bodies = bodyRows.reverse().map((r) => (r.bodyText ?? '').slice(0, TRIAGE_MAX_BODY_CHARS))

    const cats = await tx.select({ id: categories.id, key: categories.key }).from(categories)
    const [workspace] = await tx.select({ businessName: workspaces.businessName }).from(workspaces).where(eq(workspaces.orgId, orgId))
    const settingsRows = await tx
      .select({ key: orgSettings.key, value: orgSettings.value })
      .from(orgSettings)
      .where(inArray(orgSettings.key, ['triage.daily_cap', 'support.spam_shortcircuit.always']))
    const [counterRow] = await tx
      .select({ value: usageCounters.value })
      .from(usageCounters)
      .where(and(eq(usageCounters.day, day), eq(usageCounters.meter, TRIAGE_METER)))

    return {
      ticket: {
        id: ticket.id,
        status: ticket.status,
        agentId: ticket.agentId,
        subject: ticket.subject,
        isAutomated: ticket.isAutomated,
        spamFlagged: ticket.spamFlagged,
        triageFailureCount: ticket.triageFailureCount,
      },
      bodies,
      categories: cats,
      businessName: workspace?.businessName ?? '',
      settings: buildOrgSettings(settingsRows),
      callsToday: counterRow?.value ?? 0,
    }
  })
}

// -- Guarded writes --

type TicketPatch = Partial<typeof tickets.$inferInsert>

/** Every status write in this job goes through here: guarded on the status the ticket was
 * SELECTED with. Zero rows means a concurrent owner action already moved it — skip silently. */
async function guardedWrite(tx: OrgTx, ticketId: string, selectedStatus: string, patch: TicketPatch): Promise<boolean> {
  const rows = await tx
    .update(tickets)
    .set(patch)
    .where(and(eq(tickets.id, ticketId), eq(tickets.status, selectedStatus)))
    .returning({ id: tickets.id })
  return rows.length > 0
}

// -- Verdict precedence (rule 6) --

type Outcome = { status: 'resolved' } | { status: 'triaged' } | { status: 'needs_owner'; reason: 'triage_flags' | 'sentiment_angry' }

/**
 * Pinned precedence (spec, from 6A): a tripwire-owned ticket is never even selected (rule 1's
 * WHERE excludes `needs_owner`); spam or automated resolves outright; any escalation flag or angry
 * sentiment escalates; otherwise the ticket is simply triaged.
 */
function computeOutcome(verdict: TriageVerdict): Outcome {
  if (verdict.isSpam || verdict.isAutomated) return { status: 'resolved' }
  if (verdict.escalationFlags.length > 0) return { status: 'needs_owner', reason: 'triage_flags' }
  if (verdict.sentiment === 'angry') return { status: 'needs_owner', reason: 'sentiment_angry' }
  return { status: 'triaged' }
}

/** The org category matching the model's claimed key, falling back to `other` for anything the
 * model invents that isn't one of the keys it was actually given. */
function resolveCategoryId(cats: { id: string; key: string }[], categoryKey: string): string | null {
  const match = cats.find((c) => c.key === categoryKey) ?? cats.find((c) => c.key === 'other')
  return match?.id ?? null
}

/** `finishRun`, with this job's "already settled" warning spelled once. Guarded on `running`, so a
 *  backstop sweep that got there first simply wins. The clock is `deps.now` like every other read in
 *  this file, so a test that freezes time gets a deterministic `finished_at`. */
async function settleRun(
  tx: OrgTx, runId: string, status: 'succeeded' | 'failed', usage: { totals(): UsageTotals },
  deps: TicketTriageDeps, extra: { output?: unknown; errorCode?: string; errorMessage?: string },
): Promise<void> {
  const settled = await finishRun(tx, { runId, status, usage: usage.totals(), now: deps.now?.() ?? new Date(), ...extra })
  if (!settled) deps.logger.warn({ runId }, 'ticket.triage: run was already settled')
}

// -- The run function (pure w.r.t. pg-boss — this is what tests call directly) --

export async function runTicketTriage(deps: TicketTriageDeps, payload: TicketTriagePayload, signal: AbortSignal): Promise<void> {
  const { orgId, ticketId } = payload
  const now = deps.now?.() ?? new Date()
  const day = utcDayString(now)

  const loaded = await loadContext(deps.db, orgId, ticketId, day)
  if (!loaded) return // rule 1: not selectable — skip silently
  const { ticket, bodies, categories: cats, businessName, settings, callsToday } = loaded

  // Rule 2: automated short-circuit (pre-LLM) — sync already classified this at ingest.
  if (ticket.isAutomated === true) {
    await withOrg(deps.db, orgId, async (tx) => {
      // needsOwnerReason: null — same always-written hygiene as the rule-6 verdict write (fix
      // review Finding 1): a ticket reaching this short-circuit was selected as new/triaged, so it
      // should carry no reason, but must not leave a stale one behind from a prior needs_owner
      // episode that some other (future) mutation moved it out of without clearing the column.
      const written = await guardedWrite(tx, ticketId, ticket.status, { status: 'resolved', needsOwnerReason: null })
      if (!written) return
      await audit(tx, { actor: 'system:ticket.triage', action: 'ticket.auto_reply_dropped', entityType: 'ticket', entityId: ticketId, detail: {} })
    })
    return
  }

  const cap = resolveSetting('triage.daily_cap', { org: settings })
  const atCap = callsToday >= cap

  // Rule 3: spam short-circuit — never reaches the model, never spends a call.
  if (ticket.spamFlagged) {
    const always = resolveSetting('support.spam_shortcircuit.always', { org: settings })
    if (atCap || always) {
      await withOrg(deps.db, orgId, async (tx) => {
        // needsOwnerReason: null — see the rule-2 comment above; same reasoning applies here.
        const written = await guardedWrite(tx, ticketId, ticket.status, {
          status: 'resolved', isSpam: true, lastTriagedAt: now, triageFailureCount: 0, needsOwnerReason: null,
        })
        if (!written) return
        await audit(tx, { actor: 'system:ticket.triage', action: 'ticket.spam_shortcircuit', entityType: 'ticket', entityId: ticketId, detail: {} })
      })
      return
    }
  }

  // Phase 6: WHICH model triages this ticket. Resolved BEFORE the spend guard so a workspace whose
  // key is gone spends neither a triage call nor a cap slot to find out. A null `agentId` (routing
  // has not picked one yet) resolves the workspace default — Managed AI unless an owner said otherwise.
  const resolved = await deps.providers.resolve(orgId, ticket.agentId ?? null, 'triage')
  if (!resolved.ok) {
    // The FOURTH `needs_owner` landing in this job. The three above it predate `escalateTicket` and
    // pair their own guarded write with `insertEscalationNotification` inside one transaction,
    // because they also write the verdict columns; this one follows that LOCAL pattern rather than
    // introducing a second style into the same file (the draft job, which has no such coupling,
    // does go through `escalateTicket`). Dedupe key: the day-scoped default — one page per ticket
    // per UTC day is exactly right for "the provider is down".
    deps.logger.warn({ orgId, ticketId, refusal: resolved.reason }, 'ticket.triage: no model provider for this agent; escalating provider_unavailable')
    const notificationId = await withOrg(deps.db, orgId, async (tx) => {
      const written = await guardedWrite(tx, ticketId, ticket.status, {
        status: 'needs_owner', needsOwnerReason: 'provider_unavailable', escalationNotifiedAt: null,
      })
      if (!written) return undefined
      await audit(tx, {
        actor: 'system:ticket.triage', action: 'ticket.escalated', entityType: 'ticket', entityId: ticketId,
        detail: { reason: 'provider_unavailable', refusal: resolved.reason },
      })
      return insertEscalationNotification(tx, orgId, ticketId, escalationDedupeKey(ticketId, day), 'provider_unavailable')
    })
    if (notificationId) await deps.enqueueNotify(orgId, notificationId)
    return
  }
  const config = resolved.config

  // Rule 4: fail-closed spend guard, in its OWN tx, BEFORE the call. Written before the call runs:
  // a crash mid-call still counts the spend — over-counting a call that never billed is the safe
  // direction (ported comment, doge-buddy triage.ts). Phase 6 puts the `agent_runs` row in the SAME
  // transaction, for the same reason: it is the run's own spend record, written before the call it
  // authorizes, so a process that dies mid-call still leaves a trace of what it was doing.
  const gate = await withOrg(deps.db, orgId, async (tx) => {
    const [row] = await tx
      .select({ value: usageCounters.value })
      .from(usageCounters)
      .where(and(eq(usageCounters.day, day), eq(usageCounters.meter, TRIAGE_METER)))
    const current = row?.value ?? 0
    if (current >= cap) return { capped: true as const }
    await tx
      .insert(usageCounters)
      .values({ orgId, day, meter: TRIAGE_METER, value: 1 })
      .onConflictDoUpdate({ target: [usageCounters.orgId, usageCounters.day, usageCounters.meter], set: { value: sql`${usageCounters.value} + 1` } })
    const [run] = await tx
      .insert(agentRuns)
      .values({
        orgId, kind: 'triage', ticketId, agentId: ticket.agentId,
        provider: config.provider, model: config.model, status: 'running', input: {}, startedAt: now,
      })
      .returning({ id: agentRuns.id })
    return { capped: false as const, runId: run!.id }
  })

  if (gate.capped) {
    // Rule 5: cap path — once per UTC day per ticket (the notification's dedupe key), the job
    // otherwise returns cleanly; re-entry after midnight is Task 15's sweep, not this job's concern.
    const notificationId = await withOrg(deps.db, orgId, async (tx) => {
      const written = await guardedWrite(tx, ticketId, ticket.status, { status: 'needs_owner', needsOwnerReason: 'triage_cap', escalationNotifiedAt: null })
      if (!written) return undefined
      return insertEscalationNotification(tx, orgId, ticketId, `triage_cap:${ticketId}:${day}`, 'triage_cap')
    })
    if (notificationId) await deps.enqueueNotify(orgId, notificationId)
    return
  }

  const runId = gate.runId
  const usage = createUsageAccumulator()
  const meta: ChatMeta = {
    orgId, role: 'triage', runId, idempotencyKey: `ticket-triage:${ticketId}`,
    ...(ticket.agentId ? { agentId: ticket.agentId } : {}),
  }
  const input = { subject: ticket.subject, bodies, categoryKeys: cats.map((c) => c.key), businessName }

  // Rule 6/7: the model call. Always OUTSIDE a withOrg tx — never spans network I/O.
  // `fallback_to_managed` is the SAME policy `ticket.draft` applies (`FALLBACK_CODES`): one managed
  // retry when the agent opted in and a managed provider exists. Triage is cheap, so one retry is
  // the whole budget — anything past it is the ordinary failure path below.
  let call: TriageCallResult
  /** Set only by a fallback that RETURNED: the verdict transaction records it and restamps the run. */
  let fellBack: { from: string; code: string } | null = null
  try {
    try {
      call = await runTriageCallDetailed(resolved.provider, input, meta, signal, config.model)
    } catch (err) {
      if (resolved.fallback && err instanceof LlmError && (FALLBACK_CODES as readonly string[]).includes(err.code)) {
        deps.logger.warn({ runId, code: err.code }, 'ticket.triage: the agent\'s own provider failed; falling back to Managed AI')
        call = await runTriageCallDetailed(
          resolved.fallback,
          input,
          // A DISTINCT idempotency key: `llm_calls.idempotency_key` is globally unique and
          // `withMetering` already wrote the primary's ERROR row under this one, so reusing it would
          // have the sink drop the managed row and hide the fallback's spend entirely.
          { ...meta, idempotencyKey: `${meta.idempotencyKey}:fallback`, mode: 'managed', credentialId: undefined },
          signal,
          MANAGED_MODELS.triage,
        )
        fellBack = { from: config.provider, code: err.code }
      } else throw err
    }
  } catch (err) {
    // Rule 7: failure path. Below the threshold, increment and rethrow so pg-boss retries
    // (retryLimit 2, backoff); at the threshold, escalate instead of retrying further. Either way
    // the run row is settled here — a `running` row left behind would be swept as stuck.
    const failures = ticket.triageFailureCount + 1
    const code = err instanceof LlmError ? `llm_${err.code}` : 'triage_failed'
    const detail = err instanceof Error ? err.message : String(err)
    if (failures < TRIAGE_FAILURE_ESCALATE_AT) {
      await withOrg(deps.db, orgId, async (tx) => {
        await guardedWrite(tx, ticketId, ticket.status, { triageFailureCount: failures })
        await settleRun(tx, runId, 'failed', usage, deps, { errorCode: code, errorMessage: detail.slice(0, 500) })
      })
      throw err
    }
    const notificationId = await withOrg(deps.db, orgId, async (tx) => {
      const written = await guardedWrite(tx, ticketId, ticket.status, {
        status: 'needs_owner', needsOwnerReason: 'triage_failed', triageFailureCount: failures, escalationNotifiedAt: null,
      })
      // Settled unconditionally, and AFTER the ticket: the call happened whether or not the guarded
      // write landed, a `running` row left behind would be swept as stuck, and every landing in this
      // job takes `tickets` before `agent_runs` so two of them can never deadlock each other.
      await settleRun(tx, runId, 'failed', usage, deps, { errorCode: code, errorMessage: detail.slice(0, 500) })
      if (!written) return undefined
      return insertEscalationNotification(tx, orgId, ticketId, escalationDedupeKey(ticketId, day), 'triage_failed')
    })
    if (notificationId) await deps.enqueueNotify(orgId, notificationId)
    return
  }
  const verdict: TriageVerdict = call.verdict
  // Priced at the TTL of the wrapper that actually SERVED the call: `createByokProvider` meters at
  // `'5m'`, the managed stack (and therefore any fallback) at `'1h'`.
  const pricing = findPricing(call.result.model)
  if (!pricing) deps.logger.warn({ runId, provider: config.provider, model: call.result.model }, 'ticket.triage: no pricing for model; cost recorded as 0')
  usage.add(call.result.usage, pricing ? computeCostMicros(call.result.usage, pricing, cacheTtlFor(fellBack ? 'managed' : config.mode)) : 0)

  // Rule 6: apply the verdict under the pinned precedence, in one final guarded tx.
  const outcome = computeOutcome(verdict)
  const categoryId = resolveCategoryId(cats, verdict.categoryKey)

  const applied = await withOrg(deps.db, orgId, async (tx) => {
    const patch: TicketPatch = {
      status: outcome.status,
      categoryId,
      language: verdict.language,
      sentiment: verdict.sentiment,
      isSpam: verdict.isSpam,
      isAutomated: verdict.isAutomated,
      triageQuestions: verdict.questions,
      lastTriagedAt: now,
      triageFailureCount: 0,
      // Always written, never left alone (ported from doge-buddy's applyVerdict, which always sets
      // escalationReason to either the computed reason or null): a ticket reaching this write was
      // selected as `new`/`triaged` and so should carry no reason, but a future owner mutation that
      // moves a `needs_owner` ticket back without clearing it must not leave a stale one behind.
      needsOwnerReason: outcome.status === 'needs_owner' ? outcome.reason : null,
    }
    if (outcome.status === 'needs_owner') patch.escalationNotifiedAt = null

    const written = await guardedWrite(tx, ticketId, ticket.status, patch)
    // A fallback has to leave a trace, or the run row claims a verdict the tenant's model never
    // produced: one `call` event saying what failed, and the run's provider/model restamped to the
    // pair that actually answered. Guarded on `running` so a swept run is left alone.
    if (fellBack) {
      await appendRunEvent(tx, runId, 'call', { attempt: 1, fallback: true, from: fellBack.from, code: fellBack.code })
      await tx
        .update(agentRuns)
        .set({ provider: 'anthropic', model: MANAGED_MODELS.triage })
        .where(and(eq(agentRuns.id, runId), eq(agentRuns.status, 'running')))
    }
    // Settled unconditionally, and AFTER the ticket (see the failure branch's note): the call
    // happened and cost money whether or not a concurrent owner won the guarded write above.
    await settleRun(tx, runId, 'succeeded', usage, deps, { output: { outcome: outcome.status, categoryKey: verdict.categoryKey } })
    if (!written) return { written: false as const }

    let notifId: string | undefined
    if (outcome.status === 'needs_owner') {
      notifId = await insertEscalationNotification(tx, orgId, ticketId, escalationDedupeKey(ticketId, day), outcome.reason)
    }
    await audit(tx, {
      actor: 'system:ticket.triage', action: 'ticket.triaged', entityType: 'ticket', entityId: ticketId,
      detail: { categoryKey: verdict.categoryKey, sentiment: verdict.sentiment, outcome: outcome.status },
    })
    return notifId === undefined ? { written: true as const } : { written: true as const, notificationId: notifId }
  })
  if (applied.notificationId) await deps.enqueueNotify(orgId, applied.notificationId)
  // Post-commit hand-off to `ticket.draft` (Phase 3). Only on a verdict that actually landed on
  // `triaged`: a lost race wrote nothing, and every other outcome is either resolved or an owner's.
  if (applied.written && outcome.status === 'triaged') await deps.enqueueDraft?.(orgId, ticketId)
}
