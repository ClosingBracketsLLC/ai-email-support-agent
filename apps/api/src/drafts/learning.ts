/**
 * The learning writes every owner correction shares (Phase 5): the strike on the answers a rejected or
 * flagged draft relied on, the guidance line a reject-with-reason appends, and the inline demotion check.
 * Every function here runs INSIDE the caller's transaction at the FOURTH lock position — after
 * `outbound_sends`, `drafts` and `tickets` (CLAUDE.md, Lock order) — and never opens one of its own.
 * Split out of service.ts in Phase 7 (named in the Phase 4, 5 and 6 reviews); nothing was reworded.
 */
import { and, eq, inArray, ne, sql } from 'drizzle-orm'
import { OPERATING_GUIDANCE_MAX } from '@aesa/contracts'
import { DEMOTION_RULES, MEMORY_STRIKES_TO_RETIRE, evaluateDemotion } from '@aesa/core'
import {
  agentCategoryPolicies, audit, categories, demoteCategory, isUuid, readDemotionSignals, resolvedAnswers, workspaces,
  type AuditActor, type OrgTx,
} from '@aesa/db'

/**
 * The inline demotion check: after a correction the owner just made (a reject, a flag, or an edited
 * approve of a draft they had pulled back), re-read the spec's four demotion signals for that
 * (agent, category) and take Autopilot off it if any of them now fires.
 *
 * It runs in the SAME transaction as the correction, so the row this call just wrote is one of the
 * signals it counts — "two rejects in 7 days" demotes ON the second reject, not a day later when the
 * nightly backstop next looks. `demoteCategory` owns the guarded `auto → review` write, the audit
 * row and the deduped notification; zero rows there (a concurrent demotion, or the owner switching
 * the category themselves) simply returns no notification.
 *
 * Only a category actually on `auto` can be demoted — a `review`/`off` one has nothing to lose — and
 * a draft with no agent or no category has no policy row to read at all.
 */
export async function maybeDemote(
  tx: OrgTx,
  p: { orgId: string; agentId: string | null; categoryId: string | null; now: Date; day: string; actor: AuditActor },
): Promise<string | undefined> {
  if (!p.agentId || !p.categoryId) return undefined
  const [policy] = await tx.select({ mode: agentCategoryPolicies.mode, label: categories.label })
    .from(agentCategoryPolicies)
    .innerJoin(categories, eq(categories.id, agentCategoryPolicies.categoryId))
    .where(and(eq(agentCategoryPolicies.agentId, p.agentId), eq(agentCategoryPolicies.categoryId, p.categoryId)))
  if (!policy || policy.mode !== 'auto') return undefined

  const reason = evaluateDemotion(await readDemotionSignals(tx, {
    orgId: p.orgId, agentId: p.agentId, categoryId: p.categoryId, now: p.now, windows: DEMOTION_RULES,
  }))
  if (!reason) return undefined

  const { notificationId } = await demoteCategory(tx, {
    orgId: p.orgId, agentId: p.agentId, categoryId: p.categoryId, categoryLabel: policy.label,
    reason, now: p.now, day: p.day, actor: p.actor,
  })
  return notificationId
}

/**
 * A reply the owner rejected or flagged used remembered answers: each of them takes a strike, and a
 * second strike retires it (`MEMORY_STRIKES_TO_RETIRE`). Only `active` and `needs_review` answers can
 * be struck — a `candidate` is not in evidence yet (the flag path retires it outright) and a
 * `retired` one is already gone.
 *
 * `used_answer_ids` is a text[] the worker fills from what retrieval actually returned, so its
 * entries are answer ids; the uuid filter is belt-and-braces against a malformed entry turning a
 * button into a 500 (`invalid input syntax for type uuid`).
 */
export async function strikeUsedAnswers(tx: OrgTx, orgId: string, usedAnswerIds: string[]): Promise<void> {
  const ids = usedAnswerIds.filter((id) => isUuid(id))
  if (ids.length === 0) return

  const struck = await tx.update(resolvedAnswers)
    .set({ strikes: sql`${resolvedAnswers.strikes} + 1` })
    .where(and(
      eq(resolvedAnswers.orgId, orgId), inArray(resolvedAnswers.id, ids),
      inArray(resolvedAnswers.status, ['active', 'needs_review']),
    ))
    .returning({ id: resolvedAnswers.id, strikes: resolvedAnswers.strikes })

  const spent = struck.filter((row) => row.strikes >= MEMORY_STRIKES_TO_RETIRE).map((row) => row.id)
  if (spent.length === 0) return
  await tx.update(resolvedAnswers)
    .set({ status: 'retired', retiredReason: 'strikes' })
    .where(and(eq(resolvedAnswers.orgId, orgId), inArray(resolvedAnswers.id, spent), ne(resolvedAnswers.status, 'retired')))
}

/**
 * A reject-with-reason's "add this to the guidance" checkbox: append the owner's reason as one more
 * `- <rule>` line in the workspace's operating guidance, which every guardrail gate then screens
 * against (spec §Learning loop). Past `OPERATING_GUIDANCE_MAX` nothing is appended — the rejection
 * still stands, it just did not become a rule. (The guidance editor is where the owner makes room.)
 *
 * `FOR UPDATE`: this is a read-modify-write of ONE text column, and two rejections (or a reject
 * racing `workspace.acceptSuggestion`) that both read the pre-append value would each write their
 * own `current + rule` — the second silently erasing the first owner's rule. The workspace row is
 * the LAST position in the global lock order (service.ts's header), so taking it here stays inside it.
 *
 * Extracted (not a pure move, unlike `maybeDemote`/`strikeUsedAnswers`): this was inline in
 * `rejectDraft`'s `learn` closure; the SQL and the audit call are unchanged, only now a named function.
 */
export async function appendGuidanceLine(
  tx: OrgTx, orgId: string, rule: string,
  ctx: { draftId: string; actor: AuditActor; ip?: string | null; userAgent?: string | null },
): Promise<'appended' | 'full'> {
  const [workspace] = await tx.select({ operatingGuidance: workspaces.operatingGuidance })
    .from(workspaces).where(eq(workspaces.orgId, orgId)).limit(1).for('update')
  const current = workspace?.operatingGuidance ?? ''
  const next = `${current.trimEnd()}${current.trim() ? '\n' : ''}- ${rule}`
  if (next.length > OPERATING_GUIDANCE_MAX) return 'full'
  await tx.update(workspaces).set({ operatingGuidance: next }).where(eq(workspaces.orgId, orgId))
  await audit(tx, {
    actor: ctx.actor, action: 'workspace.guidance.append', entityType: 'workspace', entityId: orgId,
    // Owner-authored free text is logged as a LENGTH, never as the text (CLAUDE.md).
    detail: { length: next.length, draftId: ctx.draftId }, ip: ctx.ip, userAgent: ctx.userAgent,
  })
  return 'appended'
}
