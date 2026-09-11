/**
 * `sweeps.daily` — the once-a-day cron that expires unreviewed drafts and prunes two append-only
 * tables that would otherwise grow forever. Modeled on `mailbox-poll-sweep.ts`'s style (one
 * `withPlatform` pass, `pending[]` enqueues drained AFTER commit) and ported from doge-buddy's
 * `jobs/proposal-expire-sweep.ts`, adapted to this codebase's multi-tenant `audit_log` (every row
 * needs an explicit `org_id`, unlike doge-buddy's single-tenant one) and to `escalateTicket` (a
 * ported expiry sweep also has to notify the owner, which the reference version never did).
 *
 * (a)'s bulk expiry is the ONE sanctioned bulk writer on `drafts` besides supersede: it is TWO
 * guarded `UPDATE`s (one per source status), never a pre-`SELECT` followed by a blind bulk write —
 * that ordering is deliberate. A pre-`SELECT` would let a concurrent owner approval land between
 * the read and the write; guarding each `UPDATE`'s own `WHERE status = '<pending|held>'` and
 * trusting only what it actually `RETURNING`s means a row a concurrent writer already moved is
 * simply not in the returned set — no stale audit row claiming an expiry that never happened.
 * Decided rows (`sent`, `rejected`, `superseded`, `failed`) are excluded outright: "decided rows
 * never expire."
 *
 * Only the `pending`-sourced rows call `escalateTicket` — a `held` draft already has an approved
 * send on hold behind a kill lever (`send.execute`'s `landHeld`), and paging the owner again for
 * its expiry would be noise on top of the page that already went out when it was first held.
 */
import { and, eq, lt } from 'drizzle-orm'
import type PgBoss from 'pg-boss'
import type pino from 'pino'
import {
  agentRunEvents, auditLog, draftActionTokens, drafts, escalateTicket, withOrgIdentity, withPlatform,
  type Db, type EscalateTicketParams, type OrgTx,
} from '@aesa/db'
import { registerCron } from '@aesa/queue'
import { utcDayString } from '../date-utils.ts'
import { errorMessage } from '../err-message.ts'
import { enqueueNotifyDispatch } from './notify-dispatch.ts'

/** How long `agent_run_events` traces are kept; `agent_runs` rows themselves are never pruned. */
export const RUN_EVENT_RETENTION_DAYS = 30

/** How long a `draft_action_tokens` row is kept PAST its own `expires_at` (not from creation) —
 *  a consumed or unconsumed token is harmless once expired; this just caps table growth. */
export const ACTION_TOKEN_RETENTION_DAYS = 7

const SWEEP_ACTOR = 'system:cron:sweeps.daily' as const

export interface SweepsDailyDeps {
  db: Db
  logger: pino.Logger
  now?: () => Date
  /** Test-only seam: overrides the real `escalateTicket` call inside (a)'s per-row SAVEPOINT — see
   *  `ticket-backstop-sweep.ts`'s identical seam for why. Production never sets this. */
  escalate?: (tx: OrgTx, p: EscalateTicketParams) => Promise<{ escalated: boolean; notificationId?: string }>
}

interface ExpiredDraftRow {
  id: string
  orgId: string
  ticketId: string
}

export async function runSweepsDaily(
  boss: PgBoss,
  deps: SweepsDailyDeps,
): Promise<{ expiredDrafts: number; eventsDeleted: number; tokensDeleted: number }> {
  const now = deps.now?.() ?? new Date()
  const day = utcDayString(now)
  const escalate = deps.escalate ?? escalateTicket
  const pendingNotify: { orgId: string; entityId: string }[] = []
  let expiredDrafts = 0
  let eventsDeleted = 0
  let tokensDeleted = 0

  await withPlatform(deps.db, 'cron:sweeps.daily', async (tx) => {
    // (a) draft expiry — two guarded bulk UPDATEs (see file header for why not one pre-SELECT).
    const pendingExpired: ExpiredDraftRow[] = await tx
      .update(drafts)
      .set({ status: 'expired' })
      .where(and(eq(drafts.status, 'pending'), lt(drafts.expiresAt, now)))
      .returning({ id: drafts.id, orgId: drafts.orgId, ticketId: drafts.ticketId })
    const heldExpired: ExpiredDraftRow[] = await tx
      .update(drafts)
      .set({ status: 'expired' })
      .where(and(eq(drafts.status, 'held'), lt(drafts.expiresAt, now)))
      .returning({ id: drafts.id, orgId: drafts.orgId, ticketId: drafts.ticketId })
    const allExpired = [...pendingExpired, ...heldExpired]
    expiredDrafts = allExpired.length

    if (allExpired.length > 0) {
      await tx.insert(auditLog).values(
        allExpired.map((d) => ({
          orgId: d.orgId, actor: SWEEP_ACTOR, action: 'draft.expired', entityType: 'draft', entityId: d.id, detail: { via: 'sweep' },
        })),
      )
    }

    // Only a draft that expired FROM `pending` (never one that expired from `held`, already on
    // hold behind a kill lever the owner was already paged about) checks whether its ticket is
    // still `awaiting_review` and, if so, escalates it — each candidate its own SAVEPOINT so one
    // failure can never abort the rest of the batch.
    for (const d of pendingExpired) {
      try {
        await tx.transaction(async (tx2) => {
          const orgTx = withOrgIdentity(tx2, d.orgId)
          const { notificationId } = await escalate(orgTx, {
            orgId: d.orgId, ticketId: d.ticketId, fromStatus: 'awaiting_review', reason: 'draft_expired',
            day, now, dedupeKey: `draft_expired:${d.ticketId}:${day}`, draftId: d.id, actor: SWEEP_ACTOR, auditAction: 'ticket.escalated',
          })
          if (notificationId) pendingNotify.push({ orgId: d.orgId, entityId: notificationId })
        })
      } catch (err) {
        deps.logger.warn({ draftId: d.id, ticketId: d.ticketId, error: errorMessage(err) }, 'sweeps_daily_draft_expiry_escalation_failed')
      }
    }

    // (b) agent_run_events retention — the run rows themselves are never pruned.
    const eventCutoff = new Date(now.getTime() - RUN_EVENT_RETENTION_DAYS * 24 * 60 * 60_000)
    const deletedEvents = await tx.delete(agentRunEvents).where(lt(agentRunEvents.createdAt, eventCutoff)).returning({ id: agentRunEvents.id })
    eventsDeleted = deletedEvents.length

    // (c) draft_action_tokens retention — kept past their OWN expiry, not from creation.
    const tokenCutoff = new Date(now.getTime() - ACTION_TOKEN_RETENTION_DAYS * 24 * 60 * 60_000)
    const deletedTokens = await tx.delete(draftActionTokens).where(lt(draftActionTokens.expiresAt, tokenCutoff)).returning({ id: draftActionTokens.id })
    tokensDeleted = deletedTokens.length
  })

  for (const item of pendingNotify) {
    try {
      await enqueueNotifyDispatch(boss, item.orgId, item.entityId)
    } catch (err) {
      deps.logger.warn({ notificationId: item.entityId, error: errorMessage(err) }, 'sweeps_daily_notify_enqueue_failed')
    }
  }

  return { expiredDrafts, eventsDeleted, tokensDeleted }
}

export async function registerSweepsDaily(boss: PgBoss, deps: SweepsDailyDeps): Promise<void> {
  await registerCron(
    boss,
    'sweeps.daily',
    '30 3 * * *',
    async () => {
      await runSweepsDaily(boss, deps)
    },
    { policy: 'singleton', singletonKey: 'sweeps.daily', retryLimit: 0, expireInSeconds: 600 },
  )
}
