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
import { runTriageCall, TRIAGE_BODY_COUNT, TRIAGE_MAX_BODY_CHARS } from '@aesa/agent'
import { type NeedsOwnerReason, type TriageVerdict } from '@aesa/contracts'
import { resolveSetting, type SettingKey } from '@aesa/core'
import {
  audit, categories, messages, notifications, orgSettings, tickets, usageCounters, withOrg, workspaces,
  type Db, type OrgTx,
} from '@aesa/db'
import type { LlmProvider } from '@aesa/llm'
import { defineJob, registerJob, JOB_NAMES, type JobDefinition } from '@aesa/queue'

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
export const ticketTriageJob: JobDefinition<TicketTriagePayload> = defineJob({
  name: JOB_NAMES.ticketTriage,
  schema: TicketTriagePayload,
  queue: { expireInSeconds: 120, retryLimit: 2, retryBackoff: true },
  handler: async () => {
    throw new Error('ticket.triage: this definition has no bound deps — register it through registerTicketTriage(boss, deps)')
  },
})

export interface TicketTriageDeps {
  db: Db
  provider: LlmProvider
  logger: pino.Logger
  /** Task 16 wires the real `notify.dispatch` enqueue; until then the worker's own wiring logs it. */
  enqueueNotify: (orgId: string, notificationId: string) => Promise<void>
  now?: () => Date
}

export async function registerTicketTriage(boss: PgBoss, deps: TicketTriageDeps): Promise<void> {
  const wired: JobDefinition<TicketTriagePayload> = {
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

function escalationCopy(reason: NeedsOwnerReason): { title: string; body: string } {
  switch (reason) {
    case 'triage_flags':
      return { title: 'Ticket flagged for review', body: 'A message on this ticket was flagged during triage and needs your attention.' }
    case 'sentiment_angry':
      return { title: 'Angry customer', body: "This ticket's latest message reads as angry and needs your attention." }
    case 'triage_failed':
      return { title: 'Triage failed twice', body: 'This ticket could not be triaged automatically and needs your attention.' }
    case 'triage_cap':
      return { title: 'Daily triage limit reached', body: "This ticket is waiting because today's triage limit was reached." }
    default:
      return { title: 'Needs your attention', body: 'This ticket needs your attention.' }
  }
}

/**
 * Day-scoped, not lifetime-scoped (controller ruling, fix review): `escalation:${ticketId}` alone
 * would mean the FIRST escalation ever notified for this ticket permanently wins the unique index —
 * a ticket that gets resolved and later re-escalates (a second `triage_failed`, a fresh angry
 * follow-up after a reopen, …) would then insert nothing and page nobody. Scoping by UTC day makes
 * the dedupe "at most one push per ticket per day", same pattern the cap path already uses, while
 * `escalation_notified_at` (cleared on every transition INTO `needs_owner`) stays the authoritative
 * "has this escalation episode been notified" stamp — this key only governs the notification row.
 */
function escalationDedupeKey(ticketId: string, day: string): string {
  return `escalation:${ticketId}:${day}`
}

/** `ON CONFLICT (dedupe_key) DO NOTHING` — a second escalation for the same dedupe key (e.g. the
 * same ticket capped twice in one UTC day) is a silent no-op: no duplicate row, no second page. */
async function insertEscalationNotification(
  tx: OrgTx, orgId: string, ticketId: string, dedupeKey: string, reason: NeedsOwnerReason,
): Promise<string | undefined> {
  const { title, body } = escalationCopy(reason)
  const [row] = await tx
    .insert(notifications)
    .values({ orgId, kind: 'escalation', title, body, dedupeKey, payload: { ticketId } })
    .onConflictDoNothing({ target: notifications.dedupeKey })
    .returning({ id: notifications.id })
  return row?.id
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

  // Rule 4: fail-closed spend guard, in its OWN tx, BEFORE the call. Written before the call runs:
  // a crash mid-call still counts the spend — over-counting a call that never billed is the safe
  // direction (ported comment, doge-buddy triage.ts).
  const capped = await withOrg(deps.db, orgId, async (tx) => {
    const [row] = await tx
      .select({ value: usageCounters.value })
      .from(usageCounters)
      .where(and(eq(usageCounters.day, day), eq(usageCounters.meter, TRIAGE_METER)))
    const current = row?.value ?? 0
    if (current >= cap) return true
    await tx
      .insert(usageCounters)
      .values({ orgId, day, meter: TRIAGE_METER, value: 1 })
      .onConflictDoUpdate({ target: [usageCounters.orgId, usageCounters.day, usageCounters.meter], set: { value: sql`${usageCounters.value} + 1` } })
    return false
  })

  if (capped) {
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

  // Rule 6/7: the model call. Always OUTSIDE a withOrg tx — never spans network I/O.
  let verdict: TriageVerdict
  try {
    verdict = await runTriageCall(
      deps.provider,
      { subject: ticket.subject, bodies, categoryKeys: cats.map((c) => c.key), businessName },
      { orgId, role: 'triage', idempotencyKey: `ticket-triage:${ticketId}` },
      signal,
    )
  } catch (err) {
    // Rule 7: failure path. Below the threshold, increment and rethrow so pg-boss retries
    // (retryLimit 2, backoff); at the threshold, escalate instead of retrying further.
    const failures = ticket.triageFailureCount + 1
    if (failures < TRIAGE_FAILURE_ESCALATE_AT) {
      await withOrg(deps.db, orgId, (tx) => guardedWrite(tx, ticketId, ticket.status, { triageFailureCount: failures }))
      throw err
    }
    const notificationId = await withOrg(deps.db, orgId, async (tx) => {
      const written = await guardedWrite(tx, ticketId, ticket.status, {
        status: 'needs_owner', needsOwnerReason: 'triage_failed', triageFailureCount: failures, escalationNotifiedAt: null,
      })
      if (!written) return undefined
      return insertEscalationNotification(tx, orgId, ticketId, escalationDedupeKey(ticketId, day), 'triage_failed')
    })
    if (notificationId) await deps.enqueueNotify(orgId, notificationId)
    return
  }

  // Rule 6: apply the verdict under the pinned precedence, in one final guarded tx.
  const outcome = computeOutcome(verdict)
  const categoryId = resolveCategoryId(cats, verdict.categoryKey)

  const notificationId = await withOrg(deps.db, orgId, async (tx) => {
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
    if (!written) return undefined

    let notifId: string | undefined
    if (outcome.status === 'needs_owner') {
      notifId = await insertEscalationNotification(tx, orgId, ticketId, escalationDedupeKey(ticketId, day), outcome.reason)
    }
    await audit(tx, {
      actor: 'system:ticket.triage', action: 'ticket.triaged', entityType: 'ticket', entityId: ticketId,
      detail: { categoryKey: verdict.categoryKey, sentiment: verdict.sentiment, outcome: outcome.status },
    })
    return notifId
  })
  if (notificationId) await deps.enqueueNotify(orgId, notificationId)
}
