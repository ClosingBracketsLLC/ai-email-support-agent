import { TRPCError } from '@trpc/server'
import { APIError } from 'better-auth/api'
import { and, asc, count, desc, eq, inArray, sql } from 'drizzle-orm'
import type pino from 'pino'
import {
  CreateWorkspaceInput, OPERATING_GUIDANCE_MAX, RequestDeletionInput, SetAgentEnabledInput,
  SetKillSwitchInput, SetRetentionDaysInput, SuggestionIdInput, UpdateGuidanceInput, WORKSPACE_ERROR_MESSAGES,
  deriveAllowedHosts, isOnboardingStep, nextOnboardingStep, slugify,
  UpdateProfileInput, type ExportState, type OnboardingStep, type Tone,
} from '@aesa/contracts'
import { trialEndsAtFor } from '@aesa/core'
import { agents, audit, billingSubscriptions, categories, drafts, ensureBillingRow, guidanceSuggestions, tickets, workspaces, type AuditActor } from '@aesa/db'
import type { ObjectStore } from '@aesa/knowledge/storage'
import type { Auth } from '../../auth.ts'
import type { StripePort } from '../../billing/stripe.ts'
import type { ApiFacade, EnqueueFn } from '../../deps.ts'
import {
  cancelDeletion, exportStatus, purgeAfterFor, requestDeletion, requestExport, setKillSwitch, setRetentionDays,
  type LifecycleActor, type LifecycleDeps,
} from '../../workspace/lifecycle.ts'
import { mapAuthError } from '../auth-errors.ts'
import { authedProcedure, managerProcedure, orgProcedure, ownerProcedure, router } from '../init.ts'

/** The "live" draft statuses — the same set `drafts_live_per_ticket_uidx` (migration 0011) enforces
 * one-per-ticket over. `goLiveStatus`'s `firstDraft` is the newest of these, org-wide. */
const LIVE_DRAFT_STATUSES = ['pending', 'approved', 'held', 'sending'] as const

/** How many pending guidance suggestions the Knowledge screen shows at once. */
const GUIDANCE_SUGGESTIONS_LIMIT = 20

// Intl.supportedValuesOf('timeZone') omits 'UTC' itself (ECMA-402 treats it as a legacy alias, not a
// canonical named identifier), even though it is a real, commonly-sent IANA zone — add it back explicitly.
const SUPPORTED_TIMEZONES = new Set([...Intl.supportedValuesOf('timeZone'), 'UTC'])

type WorkspaceRow = typeof workspaces.$inferSelect

export interface WorkspaceView {
  orgId: string; businessName: string; websiteUrl: string | null; description: string | null; tone: Tone
  timezone: string; locale: string; contactPhone: string | null; contactUrls: string[]; allowedUrlHosts: string[]
  operatingGuidance: string; agentEnabled: boolean; agentEnabledAt: Date | null; onboardingStep: OnboardingStep; createdAt: Date
  /** Phase 7's lifecycle, all of it the OWNER's to see (Settings → Workspace renders every field;
   * `workspace.get` itself stays `orgProcedure`, because a teammate needs to know the agent is
   * stopped or the workspace is on its way out). `purgeAfter` is derived, never stored. */
  killSwitch: boolean; retentionDays: number
  deletionRequestedAt: Date | null; purgeAfter: Date | null
  exportState: ExportState; exportReadyAt: Date | null
}

/** The client-facing shape. Never the box key, never the customer-hash salt — and never
 * `export_key` either, which is an object-store path the owner reaches only through a presigned URL
 * (`workspace.exportStatus`). The KILL SWITCH is on the view since Phase 7: it is the owner's own
 * control, and a workspace that has stopped sending has to be able to say so. */
export function toWorkspaceView(w: WorkspaceRow): WorkspaceView {
  return {
    orgId: w.orgId, businessName: w.businessName, websiteUrl: w.websiteUrl, description: w.description, tone: w.tone as Tone,
    timezone: w.timezone, locale: w.locale, contactPhone: w.contactPhone, contactUrls: w.contactUrls, allowedUrlHosts: w.allowedUrlHosts,
    operatingGuidance: w.operatingGuidance, agentEnabled: w.agentEnabled, agentEnabledAt: w.agentEnabledAt,
    onboardingStep: isOnboardingStep(w.onboardingStep) ? w.onboardingStep : 'profile', createdAt: w.createdAt,
    killSwitch: w.killSwitch, retentionDays: w.retentionDays,
    deletionRequestedAt: w.deletionRequestedAt,
    purgeAfter: w.deletionRequestedAt ? purgeAfterFor(w.deletionRequestedAt) : null,
    exportState: w.exportState as ExportState, exportReadyAt: w.exportReadyAt,
  }
}

/** The slice of the tRPC context `src/workspace/lifecycle.ts` needs — structural, so the real
 * context just satisfies it (the same shape `routers/billing.ts` and `routers/memory.ts` use). */
interface LifecycleContext {
  deps: { api: ApiFacade; enqueue: EnqueueFn; logger: pino.Logger; stripe: StripePort | null; store: ObjectStore }
  user: { id: string }
  actor: AuditActor
  ip: string
  userAgent: string | null
}

const lifecycleDeps = (ctx: LifecycleContext): LifecycleDeps => ({
  api: ctx.deps.api, enqueue: ctx.deps.enqueue, logger: ctx.deps.logger, stripe: ctx.deps.stripe, store: ctx.deps.store,
})
const lifecycleActor = (ctx: LifecycleContext): LifecycleActor =>
  ({ userId: ctx.user.id, actor: ctx.actor, ip: ctx.ip, userAgent: ctx.userAgent })

/** `confirm_mismatch` is the caller's own input being wrong — BAD_REQUEST. `deletion_pending`,
 * `not_pending` and `export_in_progress` are states of the workspace that a different action clears
 * (cancel the deletion; request one first; wait for the export) — PRECONDITION_FAILED.
 * `billing_cancel_failed` is Stripe being unreachable or refusing, which is a BAD_GATEWAY and the
 * one code the screen may offer a plain "try again" for. */
const precondition = (message: string): TRPCError => new TRPCError({ code: 'PRECONDITION_FAILED', message })

/** Better Auth owns the organization row; the slug is unique, so retry with a fresh suffix on collision. */
async function createOrganizationWithFreshSlug(auth: Auth, headers: Headers, name: string): Promise<{ id: string }> {
  const base = slugify(name)
  for (let attempt = 1; attempt <= 5; attempt++) {
    const slug = `${base}-${Math.random().toString(36).slice(2, 6)}`
    try {
      const org = await auth.api.createOrganization({ body: { name, slug }, headers })
      if (!org) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'organization was not created' })
      return { id: org.id }
    } catch (e) {
      // A collision on an earlier attempt retries with a fresh suffix; the 5th throws the friendly message
      // instead of Better Auth's raw APIError (Phase 1 review, minor 11 — this used to be unreachable dead
      // code after the loop, since every other path already threw).
      if (e instanceof APIError && /already exists|slug/i.test(e.message)) {
        if (attempt < 5) continue
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'could not allocate a workspace slug' })
      }
      throw e
    }
  }
  // Unreachable: every iteration above either returns or throws (the 5th collision throws inside the catch,
  // above) — TypeScript can't see that a bounded for-loop always exits early, so it still needs this.
  throw new Error('unreachable: createOrganizationWithFreshSlug fell through its retry loop')
}

export const workspaceRouter = router({
  /** First sign-in: organization (Better Auth) + workspaces row. The caller becomes the owner and the org goes active. */
  create: authedProcedure.input(CreateWorkspaceInput).mutation(async ({ ctx, input }) => {
    if (!SUPPORTED_TIMEZONES.has(input.timezone)) throw new TRPCError({ code: 'BAD_REQUEST', message: 'unknown timezone' })
    let org: { id: string }
    try {
      org = await createOrganizationWithFreshSlug(ctx.deps.auth, ctx.headers, input.businessName)
    } catch (e) {
      // createOrganizationWithFreshSlug's own 5th-collision case already throws a friendly TRPCError —
      // pass it straight through. Anything else (organizationLimit's FORBIDDEN, chiefly) is a raw
      // Better Auth APIError that reached here untranslated (Phase 1 carry-over: it used to surface as a
      // masked generic 500).
      if (e instanceof TRPCError) throw e
      throw mapAuthError(e, 'could not create workspace')
    }
    await ctx.deps.api.withOrg(org.id, async (tx) => {
      await tx.insert(workspaces).values({ orgId: org.id, businessName: input.businessName, timezone: input.timezone })
      // Phase 7: every workspace owns a `billing_subscriptions` row from birth — on the trial plan,
      // with no trial CLOCK yet (`trial_ends_at` is stamped by `setAgentEnabled`, below). A missing
      // row already reads as a fresh trial through `readBillingState`, so this is not what makes
      // billing work; it is what makes the row that Stripe's webhook and the overage sweep UPDATE
      // exist before either of them needs it.
      await ensureBillingRow(tx)
      await audit(tx, { actor: ctx.actor, action: 'workspace.create', entityType: 'workspace', entityId: org.id, detail: { businessName: input.businessName }, ip: ctx.ip, userAgent: ctx.userAgent })
    })
    return { orgId: org.id }
  }),

  get: orgProcedure.query(async ({ ctx }) => {
    const [row] = await ctx.deps.api.withOrg(ctx.orgId, (tx) => tx.select().from(workspaces).where(eq(workspaces.orgId, ctx.orgId)))
    if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'workspace not created yet' })
    return { ...toWorkspaceView(row), role: ctx.member.role }
  }),

  updateProfile: managerProcedure.input(UpdateProfileInput).mutation(async ({ ctx, input }) => {
    const allowedUrlHosts = deriveAllowedHosts(input.websiteUrl, input.contactUrls)
    const updated = await ctx.deps.api.withOrg(ctx.orgId, async (tx) => {
      const [current] = await tx.select({ step: workspaces.onboardingStep }).from(workspaces).where(eq(workspaces.orgId, ctx.orgId))
      if (!current) throw new TRPCError({ code: 'NOT_FOUND', message: 'workspace not created yet' })
      const onboardingStep = current.step === 'profile' ? 'mailbox' : current.step
      const [row] = await tx.update(workspaces)
        .set({ websiteUrl: input.websiteUrl, description: input.description, tone: input.tone, contactPhone: input.contactPhone, contactUrls: input.contactUrls, allowedUrlHosts, onboardingStep })
        .where(eq(workspaces.orgId, ctx.orgId)).returning()
      await audit(tx, { actor: ctx.actor, action: 'workspace.profile.update', entityType: 'workspace', entityId: ctx.orgId, detail: { tone: input.tone, allowedUrlHosts, onboardingStep }, ip: ctx.ip, userAgent: ctx.userAgent })
      return row!
    })
    return toWorkspaceView(updated)
  }),

  /** The Knowledge screen's free-text "operating guidance" block — one of the four trusted texts
   * every guardrail gate (`@aesa/agent/policy`'s `buildReplyPolicy`) screens a reply against. The
   * audit row logs only its length, never the text (CLAUDE.md — owner-authored free text is
   * logged as a length, same rule `agents.ts`'s `auditValue` follows for persona/guidance text). */
  updateGuidance: managerProcedure.input(UpdateGuidanceInput).mutation(async ({ ctx, input }) => {
    const updated = await ctx.deps.api.withOrg(ctx.orgId, async (tx) => {
      const [row] = await tx.update(workspaces).set({ operatingGuidance: input.operatingGuidance }).where(eq(workspaces.orgId, ctx.orgId)).returning()
      if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'workspace not created yet' })
      await audit(tx, {
        actor: ctx.actor, action: 'workspace.guidance.update', entityType: 'workspace', entityId: ctx.orgId,
        detail: { length: input.operatingGuidance.length }, ip: ctx.ip, userAgent: ctx.userAgent,
      })
      return row
    })
    return toWorkspaceView(updated)
  }),

  /** "Continue" and "Skip for now" are the same call: the server owns the position, so it resumes on any device. */
  advanceOnboarding: managerProcedure.mutation(async ({ ctx }) =>
    ctx.deps.api.withOrg(ctx.orgId, async (tx) => {
      const [current] = await tx.select({ step: workspaces.onboardingStep }).from(workspaces).where(eq(workspaces.orgId, ctx.orgId))
      if (!current) throw new TRPCError({ code: 'NOT_FOUND', message: 'workspace not created yet' })
      const from: OnboardingStep = isOnboardingStep(current.step) ? current.step : 'profile'
      const to = nextOnboardingStep(from)
      if (to !== from) {
        await tx.update(workspaces).set({ onboardingStep: to }).where(eq(workspaces.orgId, ctx.orgId))
        await audit(tx, { actor: ctx.actor, action: 'workspace.onboarding.advance', entityType: 'workspace', entityId: ctx.orgId, detail: { from, to }, ip: ctx.ip, userAgent: ctx.userAgent })
      }
      return { from, to }
    }),
  ),

  /**
   * The master switch. Enabling completes the go-live onboarding step in the SAME write — the
   * go-live step's whole purpose is this switch, so there is no separate "advance" call for it
   * (unlike every other step). `agentEnabledAt` is COALESCEd: the workspace's first-ever enable
   * timestamp survives every later on/off flip.
   */
  setAgentEnabled: managerProcedure.input(SetAgentEnabledInput).mutation(async ({ ctx, input }) => {
    const now = new Date()
    const updated = await ctx.deps.api.withOrg(ctx.orgId, async (tx) => {
      const [current] = await tx
        .select({ onboardingStep: workspaces.onboardingStep, deletionRequestedAt: workspaces.deletionRequestedAt })
        .from(workspaces).where(eq(workspaces.orgId, ctx.orgId))
      if (!current) throw new TRPCError({ code: 'NOT_FOUND', message: 'workspace not created yet' })
      // A workspace on its way out stays off (fix wave): `requestDeletion` switched the agent off
      // for the whole grace period, and an admin turning managed drafting back on meanwhile would
      // spend against a workspace that is about to be erased. `cancelDeletion` lifts this.
      if (input.enabled && current.deletionRequestedAt !== null) {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: WORKSPACE_ERROR_MESSAGES.deletion_pending })
      }
      const onboardingStep = input.enabled && current.onboardingStep === 'go_live' ? 'done' : current.onboardingStep

      const patch: Record<string, unknown> = { agentEnabled: input.enabled, onboardingStep }
      if (input.enabled) patch.agentEnabledAt = sql`COALESCE(${workspaces.agentEnabledAt}, ${now}::timestamptz)`

      const [row] = await tx.update(workspaces).set(patch).where(eq(workspaces.orgId, ctx.orgId)).returning()

      // Phase 7: enabling the agent is what starts the trial CLOCK — the same COALESCE idiom as
      // `agentEnabledAt` above and for the same reason: the workspace's first-ever enable is the
      // trial's start, and every later off/on flip leaves it alone (a trial cannot be restarted by
      // toggling the switch). `ensureBillingRow` first, so a workspace created before Phase 7 has a
      // row for the UPDATE to hit. `trialEndsAt` stays NULL until then, which `billingStateOf`
      // reads as "trialing, no expiry yet" — a workspace that never went live never runs out.
      //
      // The clock is `trialEndsAtFor(agent_enabled_at)` — the ONE formula (`@aesa/core`), computed
      // from the stamp the row now carries rather than from a second `now()`: migration 0025's
      // backfill and this write therefore agree to the millisecond, and a workspace whose first
      // enable predates the row (a NULL clock beside an old `agent_enabled_at`) gets the clock that
      // enable earned, never a fresh fourteen days.
      if (input.enabled) {
        await ensureBillingRow(tx)
        await tx.update(billingSubscriptions)
          .set({ trialEndsAt: sql`COALESCE(${billingSubscriptions.trialEndsAt}, ${trialEndsAtFor(row!.agentEnabledAt ?? now)}::timestamptz)` })
          .where(eq(billingSubscriptions.orgId, ctx.orgId))
      }

      await audit(tx, {
        actor: ctx.actor, action: input.enabled ? 'workspace.agent_enabled' : 'workspace.agent_disabled',
        entityType: 'workspace', entityId: ctx.orgId, detail: { onboardingStep }, ip: ctx.ip, userAgent: ctx.userAgent,
      })
      return row!
    })
    return { ...toWorkspaceView(updated), role: ctx.member.role }
  }),

  /**
   * Phase 5's "one tap turns this edit into a rule": the pending suggestions `guidance.suggest` wrote
   * after an edited approval, newest first. `orgProcedure` — reading them is every teammate's job;
   * accepting one is management, below.
   */
  guidanceSuggestions: orgProcedure.query(async ({ ctx }) => ({
    suggestions: await ctx.deps.api.withOrg(ctx.orgId, (tx) =>
      tx.select({
        id: guidanceSuggestions.id, text: guidanceSuggestions.text, rationale: guidanceSuggestions.rationale,
        categoryLabel: categories.label, agentAddress: agents.address, createdAt: guidanceSuggestions.createdAt,
      })
        .from(guidanceSuggestions)
        .leftJoin(categories, eq(categories.id, guidanceSuggestions.categoryId))
        .leftJoin(agents, eq(agents.id, guidanceSuggestions.agentId))
        .where(and(eq(guidanceSuggestions.orgId, ctx.orgId), eq(guidanceSuggestions.status, 'pending')))
        .orderBy(desc(guidanceSuggestions.createdAt), desc(guidanceSuggestions.id))
        .limit(GUIDANCE_SUGGESTIONS_LIMIT),
    ),
  })),

  /**
   * Accepting a suggestion appends it to the operating guidance — one of the four trusted texts every
   * guardrail gate screens a reply against — and spends the suggestion, in ONE transaction: the row is
   * locked and re-checked `pending`, so two taps (or two managers) can never append the same rule
   * twice. Past the 8,000-character cap nothing is appended, the suggestion stays pending, and the
   * owner is told `guidance_full` so they can make room in the guidance editor.
   *
   * The audit row logs a LENGTH, never the text (CLAUDE.md), exactly as `updateGuidance` does.
   */
  acceptSuggestion: managerProcedure.input(SuggestionIdInput).mutation(async ({ ctx, input }) => {
    await ctx.deps.api.withOrg(ctx.orgId, async (tx) => {
      const [suggestion] = await tx.select({ id: guidanceSuggestions.id, text: guidanceSuggestions.text, status: guidanceSuggestions.status })
        .from(guidanceSuggestions)
        .where(and(eq(guidanceSuggestions.orgId, ctx.orgId), eq(guidanceSuggestions.id, input.suggestionId)))
        .limit(1)
        .for('update')
      if (!suggestion) throw new TRPCError({ code: 'NOT_FOUND', message: 'suggestion not found' })
      if (suggestion.status !== 'pending') throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'already decided' })

      // `FOR UPDATE`: the append is a read-modify-write, and a concurrent accept (or `rejectDraft`'s
      // own "add this to your guidance") that read the same pre-append value would overwrite this
      // rule with its own. The workspace row is the LAST position in the global lock order and the
      // suggestion row above is not part of it, so taking it here inverts nothing.
      const [workspace] = await tx.select({ operatingGuidance: workspaces.operatingGuidance })
        .from(workspaces).where(eq(workspaces.orgId, ctx.orgId)).limit(1).for('update')
      if (!workspace) throw new TRPCError({ code: 'NOT_FOUND', message: 'workspace not created yet' })

      const current = workspace.operatingGuidance
      const next = `${current.trimEnd()}${current.trim() ? '\n' : ''}- ${suggestion.text.trim()}`
      if (next.length > OPERATING_GUIDANCE_MAX) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'guidance_full' })

      await tx.update(workspaces).set({ operatingGuidance: next }).where(eq(workspaces.orgId, ctx.orgId))
      await tx.update(guidanceSuggestions)
        .set({ status: 'accepted', decidedAt: new Date(), decidedBy: ctx.user.id })
        .where(and(eq(guidanceSuggestions.id, suggestion.id), eq(guidanceSuggestions.status, 'pending')))
      await audit(tx, {
        actor: ctx.actor, action: 'workspace.guidance.append', entityType: 'workspace', entityId: ctx.orgId,
        detail: { length: next.length, suggestionId: suggestion.id }, ip: ctx.ip, userAgent: ctx.userAgent,
      })
    })
    return { ok: true as const }
  }),

  /** "No thanks" — the suggestion is spent without touching the guidance. */
  dismissSuggestion: managerProcedure.input(SuggestionIdInput).mutation(async ({ ctx, input }) => {
    await ctx.deps.api.withOrg(ctx.orgId, async (tx) => {
      const dismissed = await tx.update(guidanceSuggestions)
        .set({ status: 'dismissed', decidedAt: new Date(), decidedBy: ctx.user.id })
        .where(and(
          eq(guidanceSuggestions.orgId, ctx.orgId), eq(guidanceSuggestions.id, input.suggestionId),
          eq(guidanceSuggestions.status, 'pending'),
        ))
        .returning({ id: guidanceSuggestions.id })
      if (dismissed.length === 0) {
        // Same two-code split as accept: a row that exists but is already decided is a precondition,
        // an id this workspace has never seen is a NOT_FOUND.
        const [exists] = await tx.select({ id: guidanceSuggestions.id }).from(guidanceSuggestions)
          .where(and(eq(guidanceSuggestions.orgId, ctx.orgId), eq(guidanceSuggestions.id, input.suggestionId)))
        if (!exists) throw new TRPCError({ code: 'NOT_FOUND', message: 'suggestion not found' })
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'already decided' })
      }
      await audit(tx, {
        actor: ctx.actor, action: 'workspace.guidance.dismissed', entityType: 'workspace', entityId: ctx.orgId,
        detail: { suggestionId: input.suggestionId }, ip: ctx.ip, userAgent: ctx.userAgent,
      })
    })
    return { ok: true as const }
  }),

  /** The go-live screen's poll target: whether the switch is on, the addresses it can flip live, and
   * whether the owner's own test email has produced a draft yet. */
  goLiveStatus: orgProcedure.query(async ({ ctx }) =>
    ctx.deps.api.withOrg(ctx.orgId, async (tx) => {
      const [ws] = await tx.select({ agentEnabled: workspaces.agentEnabled }).from(workspaces).where(eq(workspaces.orgId, ctx.orgId))
      if (!ws) throw new TRPCError({ code: 'NOT_FOUND', message: 'workspace not created yet' })

      const activeAgents = await tx.select({ address: agents.address }).from(agents)
        .where(and(eq(agents.orgId, ctx.orgId), eq(agents.status, 'active')))
        .orderBy(asc(agents.priority), asc(agents.createdAt))

      const [ticketsSeen] = await tx.select({ value: count() }).from(tickets).where(eq(tickets.orgId, ctx.orgId))

      const [firstDraft] = await tx.select({
        ticketId: drafts.ticketId, draftId: drafts.id, subject: tickets.subject, createdAt: drafts.createdAt,
      })
        .from(drafts)
        .innerJoin(tickets, eq(tickets.id, drafts.ticketId))
        .where(and(eq(drafts.orgId, ctx.orgId), inArray(drafts.status, LIVE_DRAFT_STATUSES)))
        .orderBy(desc(drafts.createdAt))
        .limit(1)

      return {
        agentEnabled: ws.agentEnabled,
        agentAddresses: activeAgents.map((a) => a.address),
        firstDraft: firstDraft ?? null,
        ticketsSeen: ticketsSeen?.value ?? 0,
      }
    }),
  ),

  // -----------------------------------------------------------------------------------------
  // Phase 7's lifecycle — thin wrappers over `src/workspace/lifecycle.ts`. Every MUTATION here is
  // `ownerProcedure`: an ADMIN manages the workspace (mailboxes, guidance, the agent switch), but
  // only the OWNER stops it dead, changes how long it keeps customer mail, exports it, or deletes
  // it. `exportStatus` alone is `orgProcedure` — whether the export finished is not a privileged
  // fact, and the bundle itself is behind a presigned URL that only that query ever mints.
  // -----------------------------------------------------------------------------------------

  /** "Stop sending, now" — the switch `send.execute`, `drafts.approve` and the review pages already
   * obey. Nothing downstream changes; this is only the owner's hand on it. */
  setKillSwitch: ownerProcedure.input(SetKillSwitchInput).mutation(({ ctx, input }) =>
    setKillSwitch(lifecycleDeps(ctx), ctx.orgId, input.on, lifecycleActor(ctx))),

  /** How long this workspace keeps message bodies; `retention.sweep` purges past it nightly. */
  setRetentionDays: ownerProcedure.input(SetRetentionDaysInput).mutation(({ ctx, input }) =>
    setRetentionDays(lifecycleDeps(ctx), ctx.orgId, input.retentionDays, lifecycleActor(ctx))),

  /** The one irreversible thing the app can start. `confirm` must be the business name EXACTLY, a
   * live Stripe subscription is cancelled BEFORE anything is written, and a failure there refuses
   * the deletion outright rather than scheduling a purge on a card that keeps being charged. */
  requestDeletion: ownerProcedure.input(RequestDeletionInput).mutation(async ({ ctx, input }) => {
    const res = await requestDeletion(lifecycleDeps(ctx), ctx.orgId, input.confirm, lifecycleActor(ctx))
    if (res.ok) return { purgeAfter: res.purgeAfter, subscriptionCancelled: res.subscriptionCancelled }
    switch (res.code) {
      case 'confirm_mismatch': throw new TRPCError({ code: 'BAD_REQUEST', message: WORKSPACE_ERROR_MESSAGES.confirm_mismatch })
      case 'deletion_pending': throw precondition(WORKSPACE_ERROR_MESSAGES.deletion_pending)
      case 'billing_cancel_failed': throw new TRPCError({ code: 'BAD_GATEWAY', message: WORKSPACE_ERROR_MESSAGES.billing_cancel_failed })
    }
  }),

  /** "Actually, keep it." Clears the stamps alone — the kill switch stays on, the agent stays off,
   * and a subscription Stripe ended when the deletion was requested stays ended. `needsResubscribe`
   * is what lets the screen point the owner at Billing; it is a STATE ("no active plan, one on
   * file"), deliberately not `requestDeletion`'s causal `subscriptionCancelled` (ruling R23). */
  cancelDeletion: ownerProcedure.mutation(async ({ ctx }) => {
    const res = await cancelDeletion(lifecycleDeps(ctx), ctx.orgId, lifecycleActor(ctx))
    if (res.ok) return { ok: true as const, needsResubscribe: res.needsResubscribe }
    switch (res.code) {
      case 'not_pending': throw precondition(WORKSPACE_ERROR_MESSAGES.not_pending)
    }
  }),

  /** Queues `workspace.export`. Refuses while one is still `queued` (ruling R16) — see the service's
   * own comment: moving `export_key` under a job in flight makes that job fail the owner's newest
   * request. */
  requestExport: ownerProcedure.mutation(async ({ ctx }) => {
    const res = await requestExport(lifecycleDeps(ctx), ctx.orgId, lifecycleActor(ctx))
    if (res.ok) return { exportId: res.exportId }
    switch (res.code) {
      case 'export_in_progress': throw precondition(WORKSPACE_ERROR_MESSAGES.export_in_progress)
    }
  }),

  /** The export screen's poll target — and the only way the bundle's bytes are ever reachable: a
   * presigned GET, valid for seven days, issued only once the worker has landed `ready`.
   * `orgProcedure` because knowing whether the export FINISHED is not a privileged fact — but the
   * bundle carries the complete audit log and the Stripe ids, so the service mints the URL for the
   * OWNER alone and hands every other member `url: null`. */
  exportStatus: orgProcedure.query(({ ctx }) => exportStatus(lifecycleDeps(ctx), ctx.orgId, ctx.member.role)),
})
