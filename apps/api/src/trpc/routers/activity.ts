/**
 * `activity.summary` — Task 18's Activity v1. Every count below is over `withOrg` (org-scoped both by
 * RLS and by an explicit `orgId` predicate, the repo's usual belt-and-braces). Every count except
 * `recent` is windowed to `cutoff = now − days`; `recent` is simply the last 20 actually-sent replies,
 * unwindowed — a "what just happened" feed, not another report row. `autoSent` is the literal `0`:
 * autonomy's `auto` mode is unreachable until Phase 5, so nothing can ever have been auto-sent yet.
 */
import { and, count, desc, eq, gte, inArray, isNotNull, ne, sum } from 'drizzle-orm'
import { ActivitySummaryInput } from '@aesa/contracts'
import { agents, auditLog, drafts, LLM_METERS, outboundSends, SEND_METERS, tickets, usageCounters } from '@aesa/db'
import { orgProcedure, router } from '../init.ts'

/** The statuses a decided draft (`decisionSource IS NOT NULL`) can be in on its way to (or after) send —
 * `approvedUnchanged`/`approvedEdited` split this set on `editDistanceRatio = 0`. */
const DECIDED_SEND_STATUSES = ['approved', 'sending', 'sent', 'held'] as const

const utcDayString = (d: Date): string => d.toISOString().slice(0, 10)

export const activityRouter = router({
  summary: orgProcedure.input(ActivitySummaryInput).query(async ({ ctx, input }) => {
    const now = new Date()
    const cutoff = new Date(now.getTime() - input.days * 86_400_000)
    const cutoffDay = utcDayString(cutoff)
    const orgId = ctx.orgId

    return ctx.deps.api.withOrg(orgId, async (tx) => {
      const [draftedRow] = await tx.select({ value: count() }).from(drafts)
        .where(and(eq(drafts.orgId, orgId), gte(drafts.createdAt, cutoff)))

      const [approvedUnchangedRow] = await tx.select({ value: count() }).from(drafts).where(and(
        eq(drafts.orgId, orgId), gte(drafts.decidedAt, cutoff), isNotNull(drafts.decisionSource),
        inArray(drafts.status, DECIDED_SEND_STATUSES), eq(drafts.editDistanceRatio, 0),
      ))
      const [approvedEditedRow] = await tx.select({ value: count() }).from(drafts).where(and(
        eq(drafts.orgId, orgId), gte(drafts.decidedAt, cutoff), isNotNull(drafts.decisionSource),
        inArray(drafts.status, DECIDED_SEND_STATUSES), ne(drafts.editDistanceRatio, 0),
      ))

      const [rejectedRow] = await tx.select({ value: count() }).from(drafts)
        .where(and(eq(drafts.orgId, orgId), gte(drafts.decidedAt, cutoff), eq(drafts.status, 'rejected')))

      const [sentRow] = await tx.select({ value: count() }).from(outboundSends)
        .where(and(eq(outboundSends.orgId, orgId), gte(outboundSends.sentAt, cutoff)))

      const [escalatedRow] = await tx.select({ value: count() }).from(auditLog)
        .where(and(eq(auditLog.orgId, orgId), eq(auditLog.action, 'ticket.escalated'), gte(auditLog.createdAt, cutoff)))

      const [costRow] = await tx.select({ total: sum(usageCounters.value) }).from(usageCounters)
        .where(and(eq(usageCounters.orgId, orgId), eq(usageCounters.meter, LLM_METERS.costMicros), gte(usageCounters.day, cutoffDay)))
      const [aiHandledRow] = await tx.select({ total: sum(usageCounters.value) }).from(usageCounters)
        .where(and(eq(usageCounters.orgId, orgId), eq(usageCounters.meter, SEND_METERS.aiHandledConversations), gte(usageCounters.day, cutoffDay)))

      const recent = await tx.select({
        ticketId: outboundSends.ticketId, draftId: outboundSends.draftId, subject: tickets.subject,
        customerEmail: tickets.customerEmail, agentAddress: agents.address, sentAt: outboundSends.sentAt,
        decisionSource: drafts.decisionSource, editDistanceRatio: drafts.editDistanceRatio,
      })
        .from(outboundSends)
        .innerJoin(tickets, eq(tickets.id, outboundSends.ticketId))
        .innerJoin(drafts, eq(drafts.id, outboundSends.draftId))
        .leftJoin(agents, eq(agents.id, outboundSends.agentId))
        .where(and(eq(outboundSends.orgId, orgId), isNotNull(outboundSends.sentAt)))
        .orderBy(desc(outboundSends.sentAt))
        .limit(20)

      return {
        days: input.days,
        drafted: draftedRow?.value ?? 0,
        approvedUnchanged: approvedUnchangedRow?.value ?? 0,
        approvedEdited: approvedEditedRow?.value ?? 0,
        rejected: rejectedRow?.value ?? 0,
        sent: sentRow?.value ?? 0,
        escalated: escalatedRow?.value ?? 0,
        autoSent: 0 as const,
        costMicros: Number(costRow?.total ?? 0),
        aiHandledConversations: Number(aiHandledRow?.total ?? 0),
        recent,
      }
    })
  }),
})
