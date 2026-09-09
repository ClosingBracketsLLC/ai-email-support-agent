import { TRPCError } from '@trpc/server'
import { APIError } from 'better-auth/api'
import { eq } from 'drizzle-orm'
import { CreateWorkspaceInput, UpdateProfileInput, deriveAllowedHosts, isOnboardingStep, nextOnboardingStep, slugify, type OnboardingStep, type Tone } from '@aesa/contracts'
import { audit, workspaces } from '@aesa/db'
import type { Auth } from '../../auth.ts'
import { mapAuthError } from '../auth-errors.ts'
import { authedProcedure, managerProcedure, orgProcedure, router } from '../init.ts'

// Intl.supportedValuesOf('timeZone') omits 'UTC' itself (ECMA-402 treats it as a legacy alias, not a
// canonical named identifier), even though it is a real, commonly-sent IANA zone — add it back explicitly.
const SUPPORTED_TIMEZONES = new Set([...Intl.supportedValuesOf('timeZone'), 'UTC'])

type WorkspaceRow = typeof workspaces.$inferSelect

export interface WorkspaceView {
  orgId: string; businessName: string; websiteUrl: string | null; description: string | null; tone: Tone
  timezone: string; locale: string; contactPhone: string | null; contactUrls: string[]; allowedUrlHosts: string[]
  operatingGuidance: string; agentEnabled: boolean; onboardingStep: OnboardingStep; createdAt: Date
}

/** The client-facing shape. Never the box key, never the kill switch internals. */
export function toWorkspaceView(w: WorkspaceRow): WorkspaceView {
  return {
    orgId: w.orgId, businessName: w.businessName, websiteUrl: w.websiteUrl, description: w.description, tone: w.tone as Tone,
    timezone: w.timezone, locale: w.locale, contactPhone: w.contactPhone, contactUrls: w.contactUrls, allowedUrlHosts: w.allowedUrlHosts,
    operatingGuidance: w.operatingGuidance, agentEnabled: w.agentEnabled,
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
})
