import { TRPCError } from '@trpc/server'
import { APIError } from 'better-auth/api'
import { and, asc, count, desc, eq, inArray, sql } from 'drizzle-orm'
import {
  CreateWorkspaceInput, SetAgentEnabledInput, UpdateGuidanceInput, deriveAllowedHosts, isOnboardingStep, nextOnboardingStep, slugify,
  UpdateProfileInput, type OnboardingStep, type Tone,
} from '@aesa/contracts'
import { agents, audit, drafts, tickets, workspaces } from '@aesa/db'
import type { Auth } from '../../auth.ts'
import { mapAuthError } from '../auth-errors.ts'
import { authedProcedure, managerProcedure, orgProcedure, router } from '../init.ts'

/** The "live" draft statuses — the same set `drafts_live_per_ticket_uidx` (migration 0011) enforces
 * one-per-ticket over. `goLiveStatus`'s `firstDraft` is the newest of these, org-wide. */
const LIVE_DRAFT_STATUSES = ['pending', 'approved', 'held', 'sending'] as const

// Intl.supportedValuesOf('timeZone') omits 'UTC' itself (ECMA-402 treats it as a legacy alias, not a
// canonical named identifier), even though it is a real, commonly-sent IANA zone — add it back explicitly.
const SUPPORTED_TIMEZONES = new Set([...Intl.supportedValuesOf('timeZone'), 'UTC'])

type WorkspaceRow = typeof workspaces.$inferSelect

export interface WorkspaceView {
  orgId: string; businessName: string; websiteUrl: string | null; description: string | null; tone: Tone
  timezone: string; locale: string; contactPhone: string | null; contactUrls: string[]; allowedUrlHosts: string[]
  operatingGuidance: string; agentEnabled: boolean; agentEnabledAt: Date | null; onboardingStep: OnboardingStep; createdAt: Date
}

/** The client-facing shape. Never the box key, never the kill switch internals. */
export function toWorkspaceView(w: WorkspaceRow): WorkspaceView {
  return {
    orgId: w.orgId, businessName: w.businessName, websiteUrl: w.websiteUrl, description: w.description, tone: w.tone as Tone,
    timezone: w.timezone, locale: w.locale, contactPhone: w.contactPhone, contactUrls: w.contactUrls, allowedUrlHosts: w.allowedUrlHosts,
    operatingGuidance: w.operatingGuidance, agentEnabled: w.agentEnabled, agentEnabledAt: w.agentEnabledAt,
    onboardingStep: isOnboardingStep(w.onboardingStep) ? w.onboardingStep : 'profile', createdAt: w.createdAt,
  }
}

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
    const updated = await ctx.deps.api.withOrg(ctx.orgId, async (tx) => {
      const [current] = await tx.select({ onboardingStep: workspaces.onboardingStep }).from(workspaces).where(eq(workspaces.orgId, ctx.orgId))
      if (!current) throw new TRPCError({ code: 'NOT_FOUND', message: 'workspace not created yet' })
      const onboardingStep = input.enabled && current.onboardingStep === 'go_live' ? 'done' : current.onboardingStep

      const patch: Record<string, unknown> = { agentEnabled: input.enabled, onboardingStep }
      if (input.enabled) patch.agentEnabledAt = sql`COALESCE(${workspaces.agentEnabledAt}, now())`

      const [row] = await tx.update(workspaces).set(patch).where(eq(workspaces.orgId, ctx.orgId)).returning()
      await audit(tx, {
        actor: ctx.actor, action: input.enabled ? 'workspace.agent_enabled' : 'workspace.agent_disabled',
        entityType: 'workspace', entityId: ctx.orgId, detail: { onboardingStep }, ip: ctx.ip, userAgent: ctx.userAgent,
      })
      return row!
    })
    return { ...toWorkspaceView(updated), role: ctx.member.role }
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
})
