/**
 * `guidance.suggest` (spec §Product step 7 / Learning loop, mechanism 2): after an edited human
 * approval, one Haiku call turns the edit into a general operating-guidance rule — or null. Runs on
 * the `agent` role, under the SAME managed provider `ticket.draft`/`ticket.triage` share (the api's
 * `approveDraft` is the producer — it never runs on this role). Three short transactions with the
 * model call strictly between the cap check and the insert:
 *
 *   1. one READ tx: the platform kill lever (checked FIRST, same as every other model-calling job —
 *      ticket-draft.ts's `loadPreClaim`, agent-sandbox.ts's preload, send-execute.ts's claim), then
 *      the draft, the workspace, the agent's guidance and the category label. Skips (never reaches
 *      the model) on the lever being on, a null `finalBody`, a non-human `decisionSource`, a
 *      cosmetic edit (`editDistanceRatio < COSMETIC_RATIO_MIN`), or a suggestion already on record
 *      for this draft — a `short`-queue redelivery must never call the model twice for the same edit.
 *   2. one CAP tx: `pg_advisory_xact_lock` on the org, then a fail-closed compare against
 *      `guidance.daily_suggest_cap` — over cap returns `'capped'` and bumps nothing, under cap bumps
 *      the meter BEFORE the call, same "the spend row is written before the model call" rule
 *      `drafting/caps.ts` uses.
 *   3. the model call, OUTSIDE any transaction (CLAUDE.md Transactions).
 *   4. one INSERT tx: a null suggestion, or an exact duplicate of a pending/accepted one, inserts
 *      nothing; otherwise one `pending` row and an audit entry recording lengths only.
 */
import { and, eq, sql } from 'drizzle-orm'
import type PgBoss from 'pg-boss'
import type pino from 'pino'
import { z } from 'zod'
import { runGuidanceSuggestCall } from '@aesa/agent'
import { resolveSetting } from '@aesa/core'
import {
  agents, audit, bumpMeter, categories, drafts, GUIDANCE_METERS, guidanceSuggestions, orgSettings,
  platformState, usageCounters, withOrg, workspaces, type Db,
} from '@aesa/db'
import type { LlmProvider } from '@aesa/llm'
import { defineJob, JOB_NAMES, registerJob, type RegisteredJobDefinition } from '@aesa/queue'
import { utcDayString } from '../date-utils.ts'
import type { ProviderResolver } from '../provider-resolver.ts'

export const GuidanceSuggestPayload = z.object({ orgId: z.string(), draftId: z.string() })
export type GuidanceSuggestPayload = z.infer<typeof GuidanceSuggestPayload>

export const guidanceSuggestJob: RegisteredJobDefinition<GuidanceSuggestPayload> = defineJob({
  name: JOB_NAMES.guidanceSuggest, schema: GuidanceSuggestPayload,
  // retryLimit 1 (QUEUE_OPTIONS): a redelivery re-reads the same draft and the sourceDraftId gate in
  // step 1 makes a successful first attempt's retry a no-op anyway; there is no transient-failure
  // budget worth spending an extra Haiku call on.
  handler: async () => { throw new Error('guidance.suggest: register it through registerGuidanceSuggest(boss, deps)') },
})

/** `providers` is Phase 6's per-tenant resolver: Task 6 moves the model call onto it and drops
 *  `provider`; until then it rides alongside, wired but unread. */
export interface GuidanceSuggestDeps { db: Db; provider: LlmProvider; providers: ProviderResolver; logger: pino.Logger; now?: () => Date }
const ACTOR = `system:${JOB_NAMES.guidanceSuggest}` as const
/** Below this edit-distance ratio, an edit is tone/wording/punctuation only — never worth a model call. */
const COSMETIC_RATIO_MIN = 0.05

export async function registerGuidanceSuggest(boss: PgBoss, deps: GuidanceSuggestDeps): Promise<void> {
  await registerJob(boss, { ...guidanceSuggestJob, handler: async (ctx) => { await runGuidanceSuggest(deps, ctx.data, ctx.signal) } })
}

interface Loaded {
  agentId: string | null
  categoryId: string | null
  original: string
  edited: string
  categoryLabel: string | null
  workspaceGuidance: string
  agentGuidance: string
  businessName: string
}

async function load(db: Db, orgId: string, draftId: string): Promise<Loaded | null> {
  return withOrg(db, orgId, async (tx) => {
    // The platform kill lever is a policy no-op, checked first, same as ticket-draft.ts's
    // loadPreClaim and agent-sandbox.ts's preload: no call, no cap bump, no row.
    const [lever] = await tx.select({ value: platformState.value }).from(platformState).where(eq(platformState.key, 'killswitch.global'))
    if (lever?.value === true) return null

    const [d] = await tx.select({
      agentId: drafts.agentId, categoryId: drafts.categoryId, body: drafts.body, finalBody: drafts.finalBody,
      editDistanceRatio: drafts.editDistanceRatio, decisionSource: drafts.decisionSource,
    }).from(drafts).where(eq(drafts.id, draftId))
    if (!d || d.finalBody === null) return null
    if (d.decisionSource !== 'app' && d.decisionSource !== 'email') return null
    if ((d.editDistanceRatio ?? 0) < COSMETIC_RATIO_MIN) return null

    const [existing] = await tx.select({ id: guidanceSuggestions.id }).from(guidanceSuggestions)
      .where(and(eq(guidanceSuggestions.orgId, orgId), eq(guidanceSuggestions.sourceDraftId, draftId))).limit(1)
    if (existing) return null

    const [workspace] = await tx.select({ operatingGuidance: workspaces.operatingGuidance, businessName: workspaces.businessName })
      .from(workspaces).where(eq(workspaces.orgId, orgId))
    if (!workspace) return null

    const [agent] = d.agentId
      ? await tx.select({ guidanceExtra: agents.guidanceExtra }).from(agents).where(eq(agents.id, d.agentId))
      : []
    const [category] = d.categoryId
      ? await tx.select({ label: categories.label }).from(categories).where(eq(categories.id, d.categoryId))
      : []

    return {
      agentId: d.agentId, categoryId: d.categoryId, original: d.body, edited: d.finalBody,
      categoryLabel: category?.label ?? null, workspaceGuidance: workspace.operatingGuidance,
      agentGuidance: agent?.guidanceExtra ?? '', businessName: workspace.businessName,
    }
  })
}

/** Fail-closed: the lock, the compare, and the bump all happen in the SAME transaction as
 *  `drafting/caps.ts`'s draft gate — the spend row lands before the call it authorizes, so a
 *  process that dies mid-call still counts. Returns `true` when the org is AT or OVER cap. */
async function gateAndBumpCap(db: Db, orgId: string, day: string): Promise<boolean> {
  return withOrg(db, orgId, async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`guidance-gate:${orgId}`}))`)
    const [counter] = await tx.select({ value: usageCounters.value }).from(usageCounters)
      .where(and(eq(usageCounters.orgId, orgId), eq(usageCounters.day, day), eq(usageCounters.meter, GUIDANCE_METERS.suggestCalls)))
    const [settingRow] = await tx.select({ value: orgSettings.value }).from(orgSettings)
      .where(and(eq(orgSettings.orgId, orgId), eq(orgSettings.key, 'guidance.daily_suggest_cap')))
    const cap = resolveSetting('guidance.daily_suggest_cap', {
      org: settingRow ? { 'guidance.daily_suggest_cap': settingRow.value } : {},
    })
    if ((counter?.value ?? 0) >= cap) return true
    await bumpMeter(tx, orgId, day, GUIDANCE_METERS.suggestCalls, 1)
    return false
  })
}

export async function runGuidanceSuggest(
  deps: GuidanceSuggestDeps, payload: GuidanceSuggestPayload, signal: AbortSignal,
): Promise<'suggested' | 'none' | 'skipped' | 'capped'> {
  const { orgId, draftId } = payload
  const now = deps.now?.() ?? new Date()
  const day = utcDayString(now)

  const loaded = await load(deps.db, orgId, draftId)
  if (!loaded) return 'skipped'

  if (await gateAndBumpCap(deps.db, orgId, day)) return 'capped'

  // ── the model call, outside every transaction ──
  const result = await runGuidanceSuggestCall(
    deps.provider,
    {
      original: loaded.original, edited: loaded.edited, categoryLabel: loaded.categoryLabel,
      workspaceGuidance: loaded.workspaceGuidance, agentGuidance: loaded.agentGuidance, businessName: loaded.businessName,
    },
    { orgId, agentId: loaded.agentId ?? undefined, role: 'guidance_suggest', idempotencyKey: `guidance:${draftId}` },
    signal,
  )
  if (result.suggestion === null) return 'none'
  const text = result.suggestion

  return withOrg(deps.db, orgId, async (tx) => {
    const [dup] = await tx.select({ id: guidanceSuggestions.id }).from(guidanceSuggestions)
      .where(and(
        eq(guidanceSuggestions.orgId, orgId), eq(guidanceSuggestions.text, text),
        sql`${guidanceSuggestions.status} IN ('pending', 'accepted')`,
      )).limit(1)
    if (dup) return 'none'

    const [inserted] = await tx.insert(guidanceSuggestions).values({
      orgId, agentId: loaded.agentId, categoryId: loaded.categoryId, sourceDraftId: draftId,
      text, rationale: result.rationale, status: 'pending',
    }).returning({ id: guidanceSuggestions.id })

    await audit(tx, {
      actor: ACTOR, action: 'guidance.suggested', entityType: 'draft', entityId: draftId,
      detail: { suggestionId: inserted!.id, textChars: text.length, rationaleChars: result.rationale.length },
    })
    return 'suggested'
  })
}
