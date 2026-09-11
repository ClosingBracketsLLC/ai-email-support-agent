import { and, count, eq, gt, gte, inArray, isNotNull, sql } from 'drizzle-orm'
import type { DemotionReason } from '@aesa/contracts'
import { audit, type AuditActor } from './audit.ts'
import { agentCategoryPolicies, drafts, notifications } from './schema/index.ts'
import type { OrgTx } from './tenant.ts'

/** The statuses a decided draft can be in on its way to (or after) send — `activity.ts` uses the same set. */
const DECIDED_SEND_STATUSES = ['approved', 'sending', 'sent', 'held'] as const

export interface DemotionSignals {
  rejectionsInWindow: number
  flagsInWindow: number
  heldThenChanged: boolean
  decisions: { unchanged: number; edited: number }
}

export interface DemotionWindows { rejectionWindowDays: number; flagWindowDays: number; decisionWindowDays: number }

/** The cold-start lock's count: HUMAN decisions only (an auto-send has `decided_by` NULL). */
export async function countHumanDecisions(tx: OrgTx, agentId: string, categoryId: string): Promise<number> {
  const [row] = await tx.select({ value: count() }).from(drafts)
    .where(and(eq(drafts.agentId, agentId), eq(drafts.categoryId, categoryId), isNotNull(drafts.decidedBy)))
  return row?.value ?? 0
}

export async function readDemotionSignals(
  tx: OrgTx, p: { agentId: string; categoryId: string; now: Date; windows: DemotionWindows },
): Promise<DemotionSignals> {
  const daysAgo = (n: number) => new Date(p.now.getTime() - n * 86_400_000)
  const scope = and(eq(drafts.agentId, p.agentId), eq(drafts.categoryId, p.categoryId))
  const [rejections] = await tx.select({ value: count() }).from(drafts)
    .where(and(scope, eq(drafts.status, 'rejected'), gte(drafts.decidedAt, daysAgo(p.windows.rejectionWindowDays))))
  const [flags] = await tx.select({ value: count() }).from(drafts)
    .where(and(scope, gte(drafts.flaggedAt, daysAgo(p.windows.flagWindowDays))))
  const [held] = await tx.select({ value: count() }).from(drafts)
    .where(and(
      scope, isNotNull(drafts.autoHeldAt), gte(drafts.decidedAt, daysAgo(p.windows.rejectionWindowDays)),
      inArray(drafts.decisionSource, ['app', 'email']),
      sql`(${drafts.status} = 'rejected' OR COALESCE(${drafts.editDistanceRatio}, 0) > 0)`,
    ))
  const human = and(scope, inArray(drafts.decisionSource, ['app', 'email']), gte(drafts.decidedAt, daysAgo(p.windows.decisionWindowDays)), inArray(drafts.status, [...DECIDED_SEND_STATUSES]))
  const [unchanged] = await tx.select({ value: count() }).from(drafts).where(and(human, eq(drafts.editDistanceRatio, 0)))
  const [edited] = await tx.select({ value: count() }).from(drafts).where(and(human, gt(drafts.editDistanceRatio, 0)))
  return {
    rejectionsInWindow: rejections?.value ?? 0,
    flagsInWindow: flags?.value ?? 0,
    heldThenChanged: (held?.value ?? 0) > 0,
    decisions: { unchanged: unchanged?.value ?? 0, edited: edited?.value ?? 0 },
  }
}

const DEMOTION_COPY: Record<DemotionReason, string> = {
  rejections: 'Two drafts were rejected in the last 7 days.',
  flags: 'Two auto-sent replies were flagged as "should not have sent".',
  hold_then_edit: 'An auto-send was held and then changed.',
  edit_rate: 'More than 30% of recent drafts needed edits.',
}

/** Guarded `auto → review`; zero rows means a concurrent demotion (or the owner) got there first. */
export async function demoteCategory(tx: OrgTx, p: {
  orgId: string; agentId: string; categoryId: string; categoryLabel: string; reason: DemotionReason; now: Date; day: string; actor: AuditActor
}): Promise<{ demoted: boolean; notificationId?: string }> {
  const rows = await tx.update(agentCategoryPolicies)
    .set({ mode: 'review', demotedAt: p.now, demotedReason: p.reason, suggestedAt: null, suggestedWouldSend: null, suggestedOf: null })
    .where(and(eq(agentCategoryPolicies.agentId, p.agentId), eq(agentCategoryPolicies.categoryId, p.categoryId), eq(agentCategoryPolicies.mode, 'auto')))
    .returning({ agentId: agentCategoryPolicies.agentId })
  if (rows.length === 0) return { demoted: false }
  await audit(tx, { actor: p.actor, action: 'autonomy.demoted', entityType: 'agent', entityId: p.agentId, detail: { categoryId: p.categoryId, reason: p.reason } })
  const [n] = await tx.insert(notifications).values({
    orgId: p.orgId, kind: 'demotion', title: `Autopilot paused for ${p.categoryLabel}`,
    body: `${DEMOTION_COPY[p.reason]} Replies in this category come to you for review again.`,
    dedupeKey: `demotion:${p.agentId}:${p.categoryId}:${p.day}`, payload: { agentId: p.agentId, categoryId: p.categoryId },
  }).onConflictDoNothing({ target: notifications.dedupeKey }).returning({ id: notifications.id })
  return n ? { demoted: true, notificationId: n.id } : { demoted: true }
}

/**
 * `auto: false` — record the suggestion on the policy row and page once per ISO week;
 * `auto: true` — the agent opted into auto-graduation: flip `review → auto` with the threshold.
 * Both guarded on `mode = 'review'`: a category the owner already switched (either way) is left alone.
 */
export async function graduateCategory(tx: OrgTx, p: {
  orgId: string; agentId: string; categoryId: string; categoryLabel: string; threshold: number; wouldSend: number; of: number
  now: Date; day: string; weekKey: string; actor: AuditActor; auto: boolean
}): Promise<{ changed: boolean; notificationId?: string }> {
  const patch = p.auto
    ? { mode: 'auto', autoSendMinConfidence: p.threshold, graduatedAt: p.now, suggestedAt: null, suggestedWouldSend: null, suggestedOf: null }
    : { suggestedAt: p.now, suggestedWouldSend: p.wouldSend, suggestedOf: p.of }
  const rows = await tx.update(agentCategoryPolicies).set(patch)
    .where(and(eq(agentCategoryPolicies.agentId, p.agentId), eq(agentCategoryPolicies.categoryId, p.categoryId), eq(agentCategoryPolicies.mode, 'review')))
    .returning({ agentId: agentCategoryPolicies.agentId })
  if (rows.length === 0) return { changed: false }
  await audit(tx, {
    actor: p.actor, action: p.auto ? 'autonomy.graduated' : 'autonomy.suggested', entityType: 'agent', entityId: p.agentId,
    detail: { categoryId: p.categoryId, threshold: p.threshold, wouldSend: p.wouldSend, of: p.of },
  })
  const evidence = `It would have auto-sent ${p.wouldSend} of your last ${p.of} unchanged approvals at ${p.threshold}%.`
  const [n] = await tx.insert(notifications).values({
    orgId: p.orgId, kind: 'graduation',
    title: p.auto ? `Autopilot is on for ${p.categoryLabel}` : `${p.categoryLabel} is ready for Autopilot`,
    body: p.auto ? `${evidence} You can pause it any time in Settings › Autopilot.` : `${evidence} Turn it on in Settings › Autopilot.`,
    dedupeKey: p.auto ? `graduation:${p.agentId}:${p.categoryId}:${p.day}` : `graduation_suggest:${p.agentId}:${p.categoryId}:${p.weekKey}`,
    payload: { agentId: p.agentId, categoryId: p.categoryId },
  }).onConflictDoNothing({ target: notifications.dedupeKey }).returning({ id: notifications.id })
  return n ? { changed: true, notificationId: n.id } : { changed: true }
}
