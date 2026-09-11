/**
 * `stats.rollup` (spec §Learning loop, mechanism 3): the nightly per-agent × category rollup and
 * the ONLY writer of `category_stats_daily`; the graduation suggestion / auto-graduation; the
 * demotion backstop (the api demotes inline at the triggering action — this catches drift); the
 * Monday sampling nudge. One `withPlatform` pass, one SAVEPOINT per org lent that org's identity,
 * every notification enqueued AFTER the commit (the `ticket.backstop-sweep` shape).
 *
 * Every read and write inside an org's SAVEPOINT is explicitly filtered on `orgId` — unlike
 * `withOrg`, `withOrgIdentity` does NOT set `app.org_id` or switch role (the whole pass already runs
 * as `aesa_platform`, RLS bypassed), so nothing here can lean on RLS the way an ordinary `withOrg`
 * caller does. An omitted `orgId` predicate would silently mix every tenant's drafts into one org's
 * daily counters — the one mistake this file cannot afford to make.
 */
import { and, asc, count, eq, gte, isNotNull, or, sql } from 'drizzle-orm'
import type PgBoss from 'pg-boss'
import type pino from 'pino'
import { AUTO_SENT_CONFIRM_DAYS, DEMOTION_RULES, evaluateDemotion, evaluateGraduation, GRADUATION_RULES } from '@aesa/core'
import { DEFAULT_AUTO_SEND_THRESHOLD } from '@aesa/contracts'
import {
  agentCategoryPolicies, agents, categories, categoryStatsDaily, demoteCategory, drafts, graduateCategory,
  notifications, readDemotionSignals, resolvedAnswers, withOrgIdentity, withPlatform,
  type AuditActor, type Db, type OrgTx,
} from '@aesa/db'
import { registerCron } from '@aesa/queue'
import { utcDayString, utcWeekString } from '../date-utils.ts'
import { errorMessage } from '../err-message.ts'
import { enqueueNotifyDispatch } from './notify-dispatch.ts'

/** Bound on how many orgs one nightly pass visits — a Phase 7 concern past this. */
export const ROLLUP_ORGS_PER_RUN = 500
/** The rollup's trailing window, for both the daily table and every graduation/demotion signal it feeds. */
export const ROLLUP_WINDOW_DAYS = 30
/** A category demoted this recently is not immediately re-suggested — the owner just saw why it stopped. */
export const GRADUATION_RESUGGEST_COOLDOWN_DAYS = 14

const ROLLUP_ACTOR: AuditActor = 'system:cron:stats.rollup'
/** Mirrors `activity.ts`'s (and `packages/db/src/autonomy.ts`'s) local const — a decided draft on
 *  its way to (or after) send, as opposed to `rejected`, `expired`, `superseded` or `failed`. */
const DECIDED_SEND_STATUSES = new Set(['approved', 'sending', 'sent', 'held'])
const HUMAN_SOURCES = new Set(['app', 'email'])

export interface StatsRollupDeps {
  db: Db
  logger: pino.Logger
  now?: () => Date
}

interface LoadedDraft {
  agentId: string
  categoryId: string
  createdAt: Date
  decidedAt: Date | null
  decisionSource: string | null
  editDistanceRatio: number | null
  status: string
  autoDecidedAt: Date | null
  autoHeldAt: Date | null
  flaggedAt: Date | null
  confidenceBreakdown: unknown
}

interface DailyCounts {
  agentId: string
  categoryId: string
  day: string
  drafted: number
  approvedUnchanged: number
  approvedEdited: number
  rejected: number
  autoSent: number
  autoSentConfirmed: number
  autoSentFlagged: number
  held: number
}

interface CategorySignals {
  unchanged: number
  edited: number
  rejected: number
  lastRejectionAt: Date | null
  /** Every unchanged human approval this pass loaded, in no particular order — sorted (newest
   *  first) only once graduation is actually evaluated for this (agent, category). */
  unchangedApprovals: { decidedAt: Date; evidence: number | null }[]
}

const dailyKey = (agentId: string, categoryId: string, day: string) => `${agentId}:${categoryId}:${day}`
const catKey = (agentId: string, categoryId: string) => `${agentId}:${categoryId}`

function extractEvidence(breakdown: unknown): number | null {
  if (!breakdown || typeof breakdown !== 'object') return null
  const v = (breakdown as { evidence?: unknown }).evidence
  return typeof v === 'number' ? v : null
}

/** Step (a): every draft this org authored whose created/decided/auto-decided timestamp falls in
 *  the trailing window, restricted to rows with both FKs set — an agent-less or category-less draft
 *  (never fully triaged) contributes to no cell. */
async function loadDraftsForRollup(org: OrgTx, orgId: string, cutoff: Date): Promise<LoadedDraft[]> {
  const rows = await org.select({
    agentId: drafts.agentId, categoryId: drafts.categoryId, createdAt: drafts.createdAt, decidedAt: drafts.decidedAt,
    decisionSource: drafts.decisionSource, editDistanceRatio: drafts.editDistanceRatio, status: drafts.status,
    autoDecidedAt: drafts.autoDecidedAt, autoHeldAt: drafts.autoHeldAt, flaggedAt: drafts.flaggedAt,
    confidenceBreakdown: drafts.confidenceBreakdown,
  }).from(drafts).where(and(
    eq(drafts.orgId, orgId), isNotNull(drafts.agentId), isNotNull(drafts.categoryId),
    or(gte(drafts.createdAt, cutoff), gte(drafts.decidedAt, cutoff), gte(drafts.autoDecidedAt, cutoff)),
  ))
  return rows.map((r) => ({ ...r, agentId: r.agentId as string, categoryId: r.categoryId as string }))
}

/** Step (b): the pass's day-keyed counters, plus the per-(agent, category) signals the graduation
 *  check reads — built in the same sweep over the rows so neither needs a second pass. */
function aggregateDrafts(rows: LoadedDraft[], now: Date, cutoff: Date): { daily: Map<string, DailyCounts>; signals: Map<string, CategorySignals> } {
  const daily = new Map<string, DailyCounts>()
  const signals = new Map<string, CategorySignals>()
  const confirmCutoff = new Date(now.getTime() - AUTO_SENT_CONFIRM_DAYS * 86_400_000)

  const bump = (agentId: string, categoryId: string, day: string, field: keyof Omit<DailyCounts, 'agentId' | 'categoryId' | 'day'>) => {
    const key = dailyKey(agentId, categoryId, day)
    let row = daily.get(key)
    if (!row) {
      row = { agentId, categoryId, day, drafted: 0, approvedUnchanged: 0, approvedEdited: 0, rejected: 0, autoSent: 0, autoSentConfirmed: 0, autoSentFlagged: 0, held: 0 }
      daily.set(key, row)
    }
    row[field] += 1
  }

  const sigFor = (agentId: string, categoryId: string): CategorySignals => {
    const key = catKey(agentId, categoryId)
    let s = signals.get(key)
    if (!s) {
      s = { unchanged: 0, edited: 0, rejected: 0, lastRejectionAt: null, unchangedApprovals: [] }
      signals.set(key, s)
    }
    return s
  }

  for (const row of rows) {
    const { agentId, categoryId } = row
    bump(agentId, categoryId, utcDayString(row.createdAt), 'drafted')

    if (row.decisionSource && HUMAN_SOURCES.has(row.decisionSource) && row.decidedAt && row.decidedAt >= cutoff) {
      const day = utcDayString(row.decidedAt)
      const ratio = row.editDistanceRatio ?? 0
      const decided = DECIDED_SEND_STATUSES.has(row.status)
      if (decided && ratio === 0) {
        bump(agentId, categoryId, day, 'approvedUnchanged')
        const s = sigFor(agentId, categoryId)
        s.unchanged += 1
        s.unchangedApprovals.push({ decidedAt: row.decidedAt, evidence: extractEvidence(row.confidenceBreakdown) })
      } else if (decided && ratio > 0) {
        bump(agentId, categoryId, day, 'approvedEdited')
        sigFor(agentId, categoryId).edited += 1
      } else if (row.status === 'rejected') {
        bump(agentId, categoryId, day, 'rejected')
        const s = sigFor(agentId, categoryId)
        s.rejected += 1
        if (!s.lastRejectionAt || row.decidedAt > s.lastRejectionAt) s.lastRejectionAt = row.decidedAt
      }
    }

    if (row.autoDecidedAt && row.autoDecidedAt >= cutoff) {
      const day = utcDayString(row.autoDecidedAt)
      const autoSent = row.status === 'sent' && row.decisionSource === 'auto'
      if (autoSent) bump(agentId, categoryId, day, 'autoSent')
      if (row.flaggedAt !== null) bump(agentId, categoryId, day, 'autoSentFlagged')
      if (autoSent && row.flaggedAt === null && row.autoHeldAt === null && row.autoDecidedAt <= confirmCutoff) {
        bump(agentId, categoryId, day, 'autoSentConfirmed')
      }
      // The hold event lands on ITS OWN day — the day the owner pulled it back, not the day it was
      // auto-decided — so it reads as "held on <date>" rather than backdated to the send.
      if (row.autoHeldAt !== null) bump(agentId, categoryId, utcDayString(row.autoHeldAt), 'held')
    }
  }

  return { daily, signals }
}

/** Step (c): one batched upsert — a full replace of every counter on the (agent, category, day) it
 *  recomputed. A day this pass never loaded a row for (outside the trailing window, or belonging to
 *  another agent/category) is never touched, so older history simply stays as it was. */
async function upsertDailyStats(org: OrgTx, orgId: string, daily: Map<string, DailyCounts>): Promise<number> {
  const values = [...daily.values()]
  if (values.length === 0) return 0
  await org.insert(categoryStatsDaily).values(values.map((r) => ({
    orgId, agentId: r.agentId, categoryId: r.categoryId, day: r.day,
    drafted: r.drafted, approvedUnchanged: r.approvedUnchanged, approvedEdited: r.approvedEdited, rejected: r.rejected,
    autoSent: r.autoSent, autoSentConfirmed: r.autoSentConfirmed, autoSentFlagged: r.autoSentFlagged, held: r.held,
  }))).onConflictDoUpdate({
    target: [categoryStatsDaily.agentId, categoryStatsDaily.categoryId, categoryStatsDaily.day],
    set: {
      drafted: sql`excluded.drafted`, approvedUnchanged: sql`excluded.approved_unchanged`, approvedEdited: sql`excluded.approved_edited`,
      rejected: sql`excluded.rejected`, autoSent: sql`excluded.auto_sent`, autoSentConfirmed: sql`excluded.auto_sent_confirmed`,
      autoSentFlagged: sql`excluded.auto_sent_flagged`, held: sql`excluded.held`,
    },
  })
  return values.length
}

interface PendingNotify { orgId: string; entityId: string }

interface PolicyRow {
  agentId: string
  categoryId: string
  mode: string
  demotedAt: Date | null
  autoGraduate: boolean
  categoryLabel: string
}

/** Step (d)'s source rows: the org's policies joined to their (active) agent and category. A policy
 *  whose agent is paused/disconnected is left alone entirely — neither suggested nor demoted. */
async function loadPolicies(org: OrgTx, orgId: string): Promise<PolicyRow[]> {
  return org.select({
    agentId: agentCategoryPolicies.agentId, categoryId: agentCategoryPolicies.categoryId, mode: agentCategoryPolicies.mode,
    demotedAt: agentCategoryPolicies.demotedAt, autoGraduate: agents.autoGraduate, categoryLabel: categories.label,
  }).from(agentCategoryPolicies)
    .innerJoin(agents, eq(agents.id, agentCategoryPolicies.agentId))
    .innerJoin(categories, eq(categories.id, agentCategoryPolicies.categoryId))
    .where(and(eq(agentCategoryPolicies.orgId, orgId), eq(agents.status, 'active')))
}

/** Step (d): a `review` category is checked for graduation, an `auto` category for demotion — `off`
 *  falls through both and is left untouched, same as an owner who never opted in at all. */
async function evaluatePolicies(
  org: OrgTx, orgId: string, policies: PolicyRow[], signals: Map<string, CategorySignals>, now: Date, day: string,
): Promise<{ suggested: number; graduated: number; demoted: number; pending: PendingNotify[] }> {
  const weekKey = utcWeekString(now)
  const pending: PendingNotify[] = []
  let suggested = 0
  let graduated = 0
  let demoted = 0

  for (const policy of policies) {
    if (policy.mode === 'review') {
      const cooldownCutoff = new Date(now.getTime() - GRADUATION_RESUGGEST_COOLDOWN_DAYS * 86_400_000)
      const fresh = policy.demotedAt === null || policy.demotedAt < cooldownCutoff
      if (!fresh) continue

      const s = signals.get(catKey(policy.agentId, policy.categoryId))
      const daysSinceLastRejection = s?.lastRejectionAt ? Math.floor((now.getTime() - s.lastRejectionAt.getTime()) / 86_400_000) : null
      const eligible = evaluateGraduation({ unchanged: s?.unchanged ?? 0, edited: s?.edited ?? 0, rejected: s?.rejected ?? 0, daysSinceLastRejection })
      if (!eligible) continue

      const sample = [...(s?.unchangedApprovals ?? [])].sort((a, b) => b.decidedAt.getTime() - a.decidedAt.getTime()).slice(0, GRADUATION_RULES.sampleSize)
      const wouldSend = sample.filter((a) => (a.evidence ?? 0) >= DEFAULT_AUTO_SEND_THRESHOLD / 100).length
      const result = await graduateCategory(org, {
        orgId, agentId: policy.agentId, categoryId: policy.categoryId, categoryLabel: policy.categoryLabel,
        threshold: DEFAULT_AUTO_SEND_THRESHOLD, wouldSend, of: sample.length, now, day, weekKey,
        actor: ROLLUP_ACTOR, auto: policy.autoGraduate,
      })
      if (result.changed) {
        if (policy.autoGraduate) graduated += 1
        else suggested += 1
      }
      if (result.notificationId) pending.push({ orgId, entityId: result.notificationId })
    } else if (policy.mode === 'auto') {
      const demotionSignals = await readDemotionSignals(org, { agentId: policy.agentId, categoryId: policy.categoryId, now, windows: DEMOTION_RULES })
      const reason = evaluateDemotion(demotionSignals)
      if (!reason) continue
      const result = await demoteCategory(org, {
        orgId, agentId: policy.agentId, categoryId: policy.categoryId, categoryLabel: policy.categoryLabel, reason, now, day, actor: ROLLUP_ACTOR,
      })
      if (result.demoted) demoted += 1
      if (result.notificationId) pending.push({ orgId, entityId: result.notificationId })
    }
  }

  return { suggested, graduated, demoted, pending }
}

/** Step (e): a Monday-morning nudge, once per ISO week, only when there is something to sample —
 *  `ON CONFLICT DO NOTHING` on the dedupe key is what makes "once per week" hold across reruns. */
async function maybeNudge(org: OrgTx, orgId: string, now: Date): Promise<PendingNotify | null> {
  if (now.getUTCDay() !== 1) return null
  const [row] = await org.select({ value: count() }).from(resolvedAnswers)
    .where(and(eq(resolvedAnswers.orgId, orgId), eq(resolvedAnswers.status, 'candidate')))
  const n = row?.value ?? 0
  if (n === 0) return null

  const [inserted] = await org.insert(notifications).values({
    orgId, kind: 'memory_sample', title: 'Auto-sent replies to check',
    body: `${n} auto-sent ${n === 1 ? 'reply is' : 'replies are'} waiting for a quick look in Settings › Learned answers.`,
    dedupeKey: `memory_sample:${orgId}:${utcWeekString(now)}`, payload: {},
  }).onConflictDoNothing({ target: notifications.dedupeKey }).returning({ id: notifications.id })
  return inserted ? { orgId, entityId: inserted.id } : null
}

export async function runStatsRollup(
  boss: PgBoss, deps: StatsRollupDeps,
): Promise<{ orgs: number; rows: number; suggested: number; graduated: number; demoted: number; nudged: number }> {
  const now = deps.now?.() ?? new Date()
  const day = utcDayString(now)
  const cutoff = new Date(now.getTime() - ROLLUP_WINDOW_DAYS * 86_400_000)
  const pending: PendingNotify[] = []
  let rows = 0
  let suggested = 0
  let graduated = 0
  let demoted = 0
  let nudged = 0

  const orgIds = await withPlatform(deps.db, 'cron:stats.rollup', async (tx) => {
    const orgRows = await tx.selectDistinct({ orgId: agentCategoryPolicies.orgId }).from(agentCategoryPolicies)
      .orderBy(asc(agentCategoryPolicies.orgId)).limit(ROLLUP_ORGS_PER_RUN)

    for (const { orgId } of orgRows) {
      try {
        await tx.transaction(async (tx2) => {
          const org = withOrgIdentity(tx2, orgId)
          const draftRows = await loadDraftsForRollup(org, orgId, cutoff)
          const { daily, signals } = aggregateDrafts(draftRows, now, cutoff)
          rows += await upsertDailyStats(org, orgId, daily)

          const policies = await loadPolicies(org, orgId)
          const evaluated = await evaluatePolicies(org, orgId, policies, signals, now, day)
          suggested += evaluated.suggested
          graduated += evaluated.graduated
          demoted += evaluated.demoted
          pending.push(...evaluated.pending)

          const nudge = await maybeNudge(org, orgId, now)
          if (nudge) {
            nudged += 1
            pending.push(nudge)
          }
        })
      } catch (err) {
        deps.logger.warn({ orgId, error: errorMessage(err) }, 'stats_rollup_org_failed')
      }
    }

    return orgRows.map((r) => r.orgId)
  })

  for (const item of pending) {
    try {
      await enqueueNotifyDispatch(boss, item.orgId, item.entityId)
    } catch (err) {
      deps.logger.warn({ notificationId: item.entityId, error: errorMessage(err) }, 'stats_rollup_notify_enqueue_failed')
    }
  }

  return { orgs: orgIds.length, rows, suggested, graduated, demoted, nudged }
}

export async function registerStatsRollup(boss: PgBoss, deps: StatsRollupDeps): Promise<void> {
  await registerCron(
    boss,
    'stats.rollup',
    '15 2 * * *',
    async () => {
      await runStatsRollup(boss, deps)
    },
    { policy: 'singleton', singletonKey: 'stats.rollup', retryLimit: 0, expireInSeconds: 1800 },
  )
}
