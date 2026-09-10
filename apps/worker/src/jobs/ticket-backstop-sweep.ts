/**
 * `ticket.backstop-sweep` — the every-minute cross-org cron that catches everything the happy path
 * can silently drop: a draft run that never got claimed or got stuck mid-run, a ticket whose one
 * live draft vanished out from under it, and an approved send whose `send.execute` enqueue never
 * landed or whose claim expired without completing. ONE `withPlatform` pass covers the sub-sweeps
 * (a), (a2), (b), (c) and (d); every enqueue is collected during the pass and only sent AFTER it
 * commits, so a queue outage never rolls back the writes the pass already made durable — same
 * discipline as `mailbox-poll-sweep.ts`, which this file is modeled on line for line.
 *
 * (a2) is the mirror of (a)'s failure-ceiling exclusion: a `triaged` ticket AT the ceiling can be
 * drafted by nothing and is escalated by nothing, so this sweep pages the owner for it (fix wave W1
 * / final-A1 I1). The whole pass also reads the global kill lever once and skips (a) — and only (a)
 * — while it is on (fix wave W3 / final-E I3).
 *
 * (a)'s selection predicate is `claimTicket`'s own three-watermark gate (never run / new inbound /
 * stuck-and-unfinished), ported from doge-buddy's `selectAndEnqueueAgentRuns`
 * (apps/ops/src/support/agent-select.ts) and kept visibly parallel to `drafting/claim.ts` — a drift
 * between the two only ever produces a harmless no-op enqueue, since the claim's own row-locked
 * re-evaluation is the actual gate. It runs through `fairSelectSql` so one very-overdue org can
 * never crowd out every other org's stuck tickets in a single sweep.
 *
 * (c)'s orphan anchor and NOT EXISTS shape are ported from the same file's `escalateOrphans`, with
 * one deliberate divergence from its bulk `UPDATE ... WHERE id = ANY(...)`: this codebase's
 * `escalateTicket` also has to insert a deduped notification per row, so each candidate is
 * escalated in its OWN SAVEPOINT (`tx.transaction(...)`) rather than one set-based statement — a
 * single failing row (a bad dedupe key collision, a transient constraint) must never abort the
 * other candidates or the sub-sweeps around it. `deps.escalate` is a test-only seam (default
 * `escalateTicket`) that lets a test inject exactly one throwing row to prove that isolation without
 * a real trigger.
 */
import { and, asc, eq, gte, inArray, lt, notExists, or, sql } from 'drizzle-orm'
import type PgBoss from 'pg-boss'
import type pino from 'pino'
import { INVARIANTS } from '@aesa/core'
import {
  auditLog, drafts, escalateTicket, outboundSends, platformState, tickets, withOrgIdentity, withPlatform,
  type Db, type EscalateTicketParams, type OrgTx,
} from '@aesa/db'
import { fairSelectSql, registerCron } from '@aesa/queue'
import { utcDayString } from '../date-utils.ts'
import { STUCK_AFTER_MINUTES } from '../drafting/claim.ts'
import { markStuckRuns } from '../drafting/runs.ts'
import { errorMessage } from '../err-message.ts'
import { enqueueNotifyDispatch } from './notify-dispatch.ts'
import { enqueueSendExecute } from './send-execute.ts'
import { enqueueTicketDraft } from './ticket-draft.ts'

/** Per-sweep cap on (a)'s fair-select page — a bound, not a promise every eligible ticket is served
 *  in one pass; the next minute's sweep picks up whatever this one's cap left behind. */
export const SELECT_CAP_PER_CYCLE = 50

/** (c)'s idle window: an `awaiting_review` ticket with no live draft, quiet this long past its own
 *  anchor, is presumed orphaned — a run that flipped the ticket and then crashed before its draft
 *  ever committed. */
export const ORPHAN_AFTER_MINUTES = 15

/** Per-sweep cap on the escalation pages — bounded the same way (a) is. (a2) and (c) each get
 *  their OWN budget of this many rather than sharing one: they select disjoint ticket sets
 *  (`triaged` at the failure ceiling vs `awaiting_review` with no live draft), so a backlog of one
 *  must never starve the other out of the sweep. */
export const ESCALATIONS_CAP_PER_CYCLE = 10

/** (d)'s grace window: a send only counts as "due" once it has been overdue (or its claim expired)
 *  by at least this long, so a send that is merely a few seconds from its own `send_after`/claim
 *  horizon is left to the process that already owns it rather than double-picked by this sweep. */
export const DUE_SEND_GRACE_SECONDS = 60

/** Draft statuses that count as "still live" for (c)'s orphan check — a ticket with one of these
 *  has SOMETHING outstanding and is not orphaned regardless of age. */
const LIVE_DRAFT_STATUSES = ['pending', 'approved', 'held', 'sending'] as const

const SWEEP_ACTOR = 'system:cron:ticket.backstop-sweep' as const

export interface TicketBackstopDeps {
  db: Db
  logger: pino.Logger
  now?: () => Date
  /** Test-only seam: overrides the real `escalateTicket` call inside (c)'s per-row SAVEPOINT, so a
   *  test can inject exactly one throwing row and prove it never aborts the others. Production
   *  never sets this. */
  escalate?: (tx: OrgTx, p: EscalateTicketParams) => Promise<{ escalated: boolean; notificationId?: string }>
}

type PendingKind = 'draft' | 'send' | 'notify'
interface PendingEnqueue {
  kind: PendingKind
  orgId: string
  entityId: string
}

/**
 * `fairSelectSql` returns `{text, values}` shaped for a raw `pg` client — this repo's ESLint gate
 * forbids importing `pg`/`drizzle-orm/node-postgres` outside `packages/db`, `apps/*\/src/index.ts`,
 * tests and scripts, so a job file must run it through the `PlatformTx` handle instead. Its `text`
 * carries exactly one `$1` (the LIMIT), so it can be spliced into a drizzle `sql` template with
 * `sql.raw()` around the trusted, code-authored fragments and the limit interpolated normally
 * (drizzle binds it as its own parameter) — same SQL, run through the ORM. Duplicated from
 * `mailbox-poll-sweep.ts` rather than shared: this task's brief scopes the change to these two job
 * files plus `index.ts`'s registrations, nothing else.
 */
function fairSelectQuery(p: Parameters<typeof fairSelectSql>[0]) {
  const { text, values } = fairSelectSql(p)
  const marker = '$1'
  const idx = text.indexOf(marker)
  if (idx === -1 || values.length !== 1) throw new Error('fairSelectQuery: expected fairSelectSql to produce exactly one $1 placeholder')
  const before = text.slice(0, idx)
  const after = text.slice(idx + marker.length)
  return sql`${sql.raw(before)}${values[0]}${sql.raw(after)}`
}

export async function runTicketBackstopSweep(
  boss: PgBoss,
  deps: TicketBackstopDeps,
): Promise<{ draftsEnqueued: number; stuckRuns: number; orphans: number; sendsEnqueued: number; stranded: number }> {
  const now = deps.now?.() ?? new Date()
  const day = utcDayString(now)
  const escalate = deps.escalate ?? escalateTicket
  const pending: PendingEnqueue[] = []
  let stuckRuns = 0
  let orphans = 0
  let stranded = 0

  await withPlatform(deps.db, 'cron:ticket.backstop-sweep', async (tx) => {
    // The global kill lever, read ONCE for the whole pass (final-E I3). `ticket.draft` reads the
    // same key and returns having written NOTHING — no stamp, no status change — so with the lever
    // on every ticket (a) selects stays exactly selectable and the sweep enqueued up to
    // SELECT_CAP_PER_CYCLE jobs every minute until the lever came off. Only (a) is skipped: (b)'s
    // stuck-run reaper, (a2)'s and (c)'s owner escalations and (d)'s due-send re-enqueue are
    // RECOVERY, and the lever pauses the agent, not the owner's visibility into what is stuck.
    // ((d) self-terminates anyway: `send.execute` lands a levered row `held`, which (d) never
    // selects.)
    const [lever] = await tx.select({ value: platformState.value }).from(platformState).where(eq(platformState.key, 'killswitch.global'))
    const killswitch = lever?.value === true
    if (killswitch) deps.logger.info({}, 'ticket.backstop_sweep_draft_selection_skipped_killswitch')

    // (a) missed/stuck drafts — fairSelectSql over tickets, `claimTicket`'s own three-watermark
    // gate: never run, new inbound since the last run, or claimed STUCK_AFTER_MINUTES+ ago with no
    // finish stamp past that claim. `now` (not literal SQL `now()`) drives the stuck cutoff, so the
    // whole predicate moves with `deps.now` for deterministic tests.
    const stuckBefore = new Date(now.getTime() - STUCK_AFTER_MINUTES * 60_000)
    const stuckBeforeLiteral = `'${stuckBefore.toISOString()}'::timestamptz`
    if (!killswitch) {
      const dueQuery = fairSelectQuery({
        from: 'tickets',
        where: `
          status = 'triaged'
          AND agent_failure_count < ${INVARIANTS.AGENT_FAILURE_ESCALATE_AT}
          AND (
            last_agent_run_at IS NULL
            OR last_inbound_at > last_agent_run_at
            OR (last_agent_run_at < ${stuckBeforeLiteral} AND (last_agent_finished_at IS NULL OR last_agent_finished_at < last_agent_run_at))
          )
        `,
        orderBy: 'last_inbound_at ASC NULLS FIRST',
        limit: SELECT_CAP_PER_CYCLE,
      })
      const due = (await tx.execute<{ id: string; org_id: string }>(dueQuery)).rows
      for (const row of due) pending.push({ kind: 'draft', orgId: row.org_id, entityId: row.id })
    }

    // (a2) stranded at the ceiling — the mirror image of (a)'s `agent_failure_count <` clause
    // (final-A1 I1). A `triaged` ticket AT the ceiling is refused by `claimTicket` before its stuck
    // evaluation (so the claim's own ceiling escalation can never fire for it), excluded by (a),
    // and invisible to (c), which only looks at `awaiting_review` — a customer email nothing would
    // ever answer and nobody would ever hear about. `send.execute`'s hand-backs no longer create
    // the state, but this arm makes the invariant self-healing if a future writer reintroduces it.
    // Same SAVEPOINT-per-row isolation and `withOrgIdentity` lending as (c) below.
    const strandedCandidates = await tx
      .select({ id: tickets.id, orgId: tickets.orgId })
      .from(tickets)
      .where(and(eq(tickets.status, 'triaged'), gte(tickets.agentFailureCount, INVARIANTS.AGENT_FAILURE_ESCALATE_AT)))
      .orderBy(asc(tickets.updatedAt))
      .limit(ESCALATIONS_CAP_PER_CYCLE)

    for (const candidate of strandedCandidates) {
      try {
        await tx.transaction(async (tx2) => {
          const orgTx = withOrgIdentity(tx2, candidate.orgId)
          const { escalated, notificationId } = await escalate(orgTx, {
            orgId: candidate.orgId, ticketId: candidate.id, fromStatus: 'triaged', reason: 'agent_failed',
            // Reason-scoped, like (c)'s: a ticket that already paged today for something else must
            // still page for "the agent stopped trying".
            day, now, dedupeKey: `agent_failed:${candidate.id}:${day}`, actor: SWEEP_ACTOR, auditAction: 'ticket.escalated',
          })
          if (escalated) stranded += 1
          if (notificationId) pending.push({ kind: 'notify', orgId: candidate.orgId, entityId: notificationId })
        })
      } catch (err) {
        deps.logger.warn({ ticketId: candidate.id, error: errorMessage(err) }, 'ticket.backstop_sweep_stranded_escalation_failed')
      }
    }

    // (b) stuck runs — every `running` agent_runs row started long enough ago that its job's own
    // expiry (`DRAFT_JOB_EXPIRE_SECONDS`) has definitely passed, plus a margin, belongs to a process
    // that is gone. `markStuckRuns` only flips the row (it has no OrgTx to audit through); this
    // sweep owns the audit trail, one row per run, each in its own SAVEPOINT so one audit failure
    // can never take down the rest of the batch or the sub-sweeps around it.
    const runStuckBefore = new Date(now.getTime() - (INVARIANTS.DRAFT_JOB_EXPIRE_SECONDS + 60) * 1000)
    const stuck = await markStuckRuns(tx, runStuckBefore)
    for (const run of stuck) {
      try {
        await tx.transaction(async (tx2) => {
          await tx2.insert(auditLog).values({
            orgId: run.orgId, actor: SWEEP_ACTOR, action: 'agent_run.stuck', entityType: 'agent_run', entityId: run.id, detail: {},
          })
        })
        stuckRuns += 1
      } catch (err) {
        deps.logger.warn({ runId: run.id, error: errorMessage(err) }, 'ticket.backstop_sweep_stuck_run_audit_failed')
      }
    }

    // (c) orphans — an `awaiting_review` ticket with no live draft, idle past ORPHAN_AFTER_MINUTES
    // on its own anchor (the newest draft's `created_at`, else `last_agent_run_at`, else
    // `updated_at` — never `updated_at` alone, since a chasing customer bumps that column and must
    // not reset the very clock meant to catch a stuck ticket). Oldest anchor first, capped. Each
    // candidate is escalated in its own SAVEPOINT: `escalateTicket` needs an `OrgTx` to audit and
    // notify through, so the SAVEPOINT's own tx is lent that ticket's identity via
    // `withOrgIdentity` — RLS is already bypassed under `aesa_platform`, and every write inside is
    // keyed by `ticketId`, so the identity feeds only the audit row and the notification's `org_id`.
    const orphanBefore = new Date(now.getTime() - ORPHAN_AFTER_MINUTES * 60_000)
    const liveDraftExists = tx
      .select({ one: sql`1` })
      .from(drafts)
      .where(and(eq(drafts.ticketId, tickets.id), inArray(drafts.status, LIVE_DRAFT_STATUSES)))
    const orphanAnchor = sql`COALESCE(
      (SELECT max(${drafts.createdAt}) FROM ${drafts} WHERE ${drafts.ticketId} = ${tickets.id}),
      ${tickets.lastAgentRunAt},
      ${tickets.updatedAt}
    )`
    const orphanCandidates = await tx
      .select({ id: tickets.id, orgId: tickets.orgId })
      .from(tickets)
      .where(and(eq(tickets.status, 'awaiting_review'), notExists(liveDraftExists), sql`${orphanAnchor} < ${orphanBefore.toISOString()}::timestamptz`))
      .orderBy(sql`${orphanAnchor} ASC`)
      .limit(ESCALATIONS_CAP_PER_CYCLE)

    for (const candidate of orphanCandidates) {
      try {
        await tx.transaction(async (tx2) => {
          const orgTx = withOrgIdentity(tx2, candidate.orgId)
          const { escalated, notificationId } = await escalate(orgTx, {
            orgId: candidate.orgId, ticketId: candidate.id, fromStatus: 'awaiting_review', reason: 'orphaned',
            day, now, dedupeKey: `orphaned:${candidate.id}:${day}`, actor: SWEEP_ACTOR, auditAction: 'ticket.escalated',
          })
          if (escalated) orphans += 1
          if (notificationId) pending.push({ kind: 'notify', orgId: candidate.orgId, entityId: notificationId })
        })
      } catch (err) {
        deps.logger.warn({ ticketId: candidate.id, error: errorMessage(err) }, 'ticket.backstop_sweep_orphan_escalation_failed')
      }
    }

    // (d) due sends — a `queued` send overdue past its own `send_after` by more than the grace
    // window, or a `claimed` send whose claim horizon expired past the same grace window (a worker
    // that died mid-send leaves the row here; the expired-claim arm is what makes it reclaimable at
    // all — `send.execute`'s own claim predicate accepts either). Plain SELECT: no write here, the
    // enqueue itself is what makes the row claimable again.
    const dueSendBefore = new Date(now.getTime() - DUE_SEND_GRACE_SECONDS * 1000)
    const dueSends = await tx
      .select({ id: outboundSends.id, orgId: outboundSends.orgId })
      .from(outboundSends)
      .where(
        or(
          and(eq(outboundSends.status, 'queued'), lt(outboundSends.sendAfter, dueSendBefore)),
          and(eq(outboundSends.status, 'claimed'), lt(outboundSends.claimExpiresAt, dueSendBefore)),
        ),
      )
    for (const s of dueSends) pending.push({ kind: 'send', orgId: s.orgId, entityId: s.id })
  })

  let draftsEnqueued = 0
  let sendsEnqueued = 0
  for (const item of pending) {
    try {
      if (item.kind === 'draft') {
        await enqueueTicketDraft(boss, item.orgId, item.entityId)
        draftsEnqueued += 1
      } else if (item.kind === 'send') {
        await enqueueSendExecute(boss, item.orgId, item.entityId)
        sendsEnqueued += 1
      } else {
        await enqueueNotifyDispatch(boss, item.orgId, item.entityId)
      }
    } catch (err) {
      // A null from a singleton collision is fine — the job already exists. Only a thrown error
      // (a DB blip on pg-boss's own send) lands here, and one entity's failure must never stop the
      // rest of the batch: the un-enqueued entity is simply selectable again next cycle.
      deps.logger.warn({ kind: item.kind, entityId: item.entityId, error: errorMessage(err) }, 'ticket.backstop_sweep_enqueue_failed')
    }
  }

  return { draftsEnqueued, stuckRuns, orphans, sendsEnqueued, stranded }
}

export async function registerTicketBackstopSweep(boss: PgBoss, deps: TicketBackstopDeps): Promise<void> {
  await registerCron(
    boss,
    'ticket.backstop-sweep',
    '* * * * *',
    async () => {
      await runTicketBackstopSweep(boss, deps)
    },
    { policy: 'singleton', singletonKey: 'ticket.backstop-sweep', retryLimit: 0, expireInSeconds: 50 },
  )
}
