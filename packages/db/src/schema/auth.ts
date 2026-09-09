import { boolean, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'

const ts = (name: string) => timestamp(name, { withTimezone: true })
const authId = () => uuid('id').primaryKey().defaultRandom()   // generateId: false → Postgres mints the id

/**
 * Better Auth's tables. NOT tenant tables (RLS_EXEMPT in test/rls.test.ts by ruling): the api reaches them
 * only through Better Auth's adapter on the aesa_app handle, and migration 0002's default privileges give
 * aesa_app full DML. Ids are uuid (advanced.database.generateId: false) so workspaces.org_id can reference
 * organization.id and audit actors read `user:<uuid>`.
 */
export const user = pgTable('user', {
  id: authId(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
})

export const session = pgTable('session', {
  id: authId(),
  expiresAt: ts('expires_at').notNull(),
  token: text('token').notNull().unique(),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  userId: uuid('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  /** Set by the organization plugin (setActive / createOrganization). tRPC derives orgId from it. */
  activeOrganizationId: uuid('active_organization_id'),
}, (t) => [index('session_user_id_idx').on(t.userId)])

export const account = pgTable('account', {
  id: authId(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: uuid('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: ts('access_token_expires_at'),
  refreshTokenExpiresAt: ts('refresh_token_expires_at'),
  scope: text('scope'),
  password: text('password'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => [index('account_user_id_idx').on(t.userId)])

export const verification = pgTable('verification', {
  id: authId(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: ts('expires_at').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => [index('verification_identifier_idx').on(t.identifier)])

export const organization = pgTable('organization', {
  id: authId(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  logo: text('logo'),
  createdAt: ts('created_at').notNull().defaultNow(),
  metadata: text('metadata'),
}, (t) => [uniqueIndex('organization_slug_uidx').on(t.slug)])

export const member = pgTable('member', {
  id: authId(),
  organizationId: uuid('organization_id').notNull().references(() => organization.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  role: text('role').notNull().default('member'),
  createdAt: ts('created_at').notNull().defaultNow(),
}, (t) => [index('member_organization_id_idx').on(t.organizationId), index('member_user_id_idx').on(t.userId)])

export const invitation = pgTable('invitation', {
  id: authId(),
  organizationId: uuid('organization_id').notNull().references(() => organization.id, { onDelete: 'cascade' }),
  email: text('email').notNull(),
  role: text('role'),
  status: text('status').notNull().default('pending'),
  expiresAt: ts('expires_at').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
  inviterId: uuid('inviter_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
}, (t) => [index('invitation_organization_id_idx').on(t.organizationId), index('invitation_email_idx').on(t.email)])

/** What `drizzleAdapter(db, { provider: 'pg', schema: authSchema })` receives — keys are Better Auth model names. */
export const authSchema = { user, session, account, verification, organization, member, invitation } as const
/**
 * Feeds `RLS_EXEMPT` in `packages/db/test/rls.test.ts`: appending a table name here removes it from that
 * test's RLS invariant (row-level security enabled+forced, the two `tenantPolicies()` policies) with no
 * other signal that it happened. `member` and `invitation` are org-scoped data with no RLS net of their own —
 * they must only ever be reached through Better Auth's own API (never a raw query), which is what actually
 * enforces the org boundary for them (Phase 1 review, minor 12).
 */
export const AUTH_TABLES = ['user', 'session', 'account', 'verification', 'organization', 'member', 'invitation'] as const
