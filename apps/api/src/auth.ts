import { expo } from '@better-auth/expo'
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { APIError } from 'better-auth/api'
import { emailOTP, organization } from 'better-auth/plugins'
import { authSchema, type AuditEntry, type Db } from '@aesa/db'
import type pino from 'pino'
import type { ApiConfig } from './config.ts'
import { betterAuthLogger } from './logging.ts'
import { invitationMail, otpMail } from './mail/templates.ts'
import type { MailTransport } from './mail/transport.ts'

export interface AuthDeps {
  /** The app-role handle. Better Auth's tables are RLS-exempt; this is the only code that queries them directly. */
  db: Db
  config: ApiConfig
  mail: MailTransport
  logger: pino.Logger
  /** Writes an org-scoped audit row from a Better Auth hook (hooks run outside any request transaction). */
  audit: (orgId: string, entry: AuditEntry) => Promise<void>
}

/** team.invite builds an email subject from it (`${inviterName} invited you to ${orgName}`); Better Auth places no cap of its own (Phase 1 review, Important 2). */
const MAX_USER_NAME_LENGTH = 120

function rejectOversizedName(user: { name?: unknown }): void {
  if (typeof user.name === 'string' && user.name.length > MAX_USER_NAME_LENGTH) {
    throw new APIError('BAD_REQUEST', { message: 'name too long' })
  }
}

export function createAuth({ db, config, mail, logger, audit }: AuthDeps) {
  return betterAuth({
    appName: 'aesa',
    baseURL: config.appBaseUrl,
    basePath: '/api/auth',
    secret: config.betterAuthSecret.expose(),
    database: drizzleAdapter(db, { provider: 'pg', schema: authSchema }),
    // Routes Better Auth's own diagnostics (including a raw DrizzleQueryError the drizzle adapter doesn't catch)
    // through the shared pino logger instead of its default console.error/warn/log, which bypasses redaction.
    logger: betterAuthLogger(logger),
    advanced: {
      database: { generateId: false },   // Postgres mints uuid ids (packages/db/src/schema/auth.ts)
      // Better Auth defaults origin/CSRF checking OFF when NODE_ENV === 'test' (its own isTest(), unrelated to
      // ApiConfig.env). Force it on here so the checks this api relies on hold under vitest too.
      disableOriginCheck: false,
      // Rate-limit keying reads x-forwarded-for directly (independent of Fastify's own trustProxy, set in
      // server.ts). trustProxy === true: leave trustedProxies unset — Better Auth's documented default already
      // trusts a single-value header as-is. trustProxy is a list: pass it through so a known multi-hop chain
      // (CDN + load balancer, say) is walked past those hops to the real client IP. trustProxy === false: leave
      // unset too; loadConfig refuses AUTH_RATE_LIMIT=on with TRUST_PROXY unset in production, so the only way
      // here is dev/test, where Better Auth's own getIP() falls back to localhost.
      ...(Array.isArray(config.trustProxy) ? { ipAddress: { trustedProxies: config.trustProxy } } : {}),
      ...(config.crossSiteCookies ? { defaultCookieAttributes: { sameSite: 'none' as const, secure: true } } : {}),
    },
    databaseHooks: {
      user: {
        create: { before: async (user) => rejectOversizedName(user) },
        update: { before: async (user) => rejectOversizedName(user) },
      },
    },
    trustedOrigins: config.trustedOrigins,
    rateLimit: {
      enabled: config.authRateLimit,
      window: 60, max: 60,
      customRules: {
        '/email-otp/send-verification-otp': { window: 60, max: 3 },
        '/sign-in/email-otp': { window: 60, max: 10 },
      },
    },
    emailAndPassword: { enabled: false },
    socialProviders: {
      ...(config.google ? { google: { clientId: config.google.clientId, clientSecret: config.google.clientSecret.expose(), prompt: 'select_account' as const } } : {}),
      ...(config.microsoft ? {
        microsoft: {
          clientId: config.microsoft.clientId, clientSecret: config.microsoft.clientSecret.expose(), tenantId: 'common', prompt: 'select_account' as const,
          // Minimal scopes: the profile comes from the id token; User.Read is only needed for the avatar (deviation 3).
          disableDefaultScope: true, scope: ['openid', 'profile', 'email'], disableProfilePhoto: true,
        },
      } : {}),
    },
    plugins: [
      emailOTP({
        otpLength: 6, expiresIn: 600, allowedAttempts: 3, storeOTP: 'hashed',
        async sendVerificationOTP({ email, otp, type }) {
          if (type !== 'sign-in') return   // no password reset, no separate email verification in this product
          await mail.send(otpMail(email, otp))
        },
      }),
      organization({
        creatorRole: 'owner',
        // workspace.create (apps/api/src/trpc/routers/workspace.ts) is otherwise unbounded — a signed-in user
        // could call it as many times as they like (Phase 1 review, Important 2).
        organizationLimit: 5,
        disableOrganizationDeletion: true,   // deletion is a soft-delete + 30-day job (Phase 7)
        invitationExpiresIn: 48 * 60 * 60,
        cancelPendingInvitationsOnReInvite: true,
        async sendInvitationEmail(data) {
          await mail.send(invitationMail({ to: data.email, inviterName: data.inviter.user.name, orgName: data.organization.name, url: `${config.appWebOrigin}/invite/${data.id}` }))
        },
        organizationHooks: {
          // The accepting user is unambiguous here; invitations, role changes and removals are audited by the
          // tRPC team router (Task 7), which knows the acting user.
          async afterAcceptInvitation({ invitation, member, user, organization: org }) {
            await audit(org.id, { actor: `user:${user.id}`, action: 'team.join', entityType: 'member', entityId: member.id, detail: { invitationId: invitation.id, role: member.role } })
          },
        },
      }),
      expo(),
    ],
  })
}

export type Auth = ReturnType<typeof createAuth>
