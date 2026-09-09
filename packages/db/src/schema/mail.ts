import { sql } from 'drizzle-orm'
import { check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { bytea, createdAt, id, orgId, tenantPolicies, updatedAt } from './helpers.ts'
import { user } from './auth.ts'

// The check constraints below spell the same literals as @aesa/contracts' MAIL_PROVIDERS / CONNECTION_STATUSES
// (drizzle-kit inlines sql`` parameters into DDL only partially, so building them from the arrays would change
// the snapshot — see workspaces.ts). Keep both in sync by hand.
export { MAIL_PROVIDERS, CONNECTION_STATUSES } from '@aesa/contracts'

/** One row per OAuth attempt; consumed by the callback, claimed by the app (spec: connect flow claim step). */
export const oauthFlows = pgTable('oauth_flows', {
  id: id(),
  orgId: orgId(),
  userId: uuid('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  provider: text('provider').notNull(),                       // 'gmail' | 'microsoft' (checked)
  nonceHash: text('nonce_hash').notNull(),
  pkceCiphertext: bytea('pkce_ciphertext').notNull(),         // AES-GCM under the api's flow key (HKDF of BETTER_AUTH_SECRET)
  platform: text('platform').notNull(),                       // 'native' | 'web'
  status: text('status').notNull().default('pending'),        // pending | consumed | failed
  failureReason: text('failure_reason'),                      // e.g. 'admin_consent_required'
  connectionId: uuid('connection_id'),                        // set by the callback on success
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: createdAt(),
}, (t) => [
  check('oauth_flows_provider_check', sql`${t.provider} IN ('gmail','microsoft')`),
  check('oauth_flows_platform_check', sql`${t.platform} IN ('native','web')`),
  check('oauth_flows_status_check', sql`${t.status} IN ('pending','consumed','failed')`),
  uniqueIndex('oauth_flows_nonce_hash_uidx').on(t.nonceHash),
  index('oauth_flows_org_idx').on(t.orgId, t.createdAt),
  ...tenantPolicies(t.orgId, 'oauth_flows'),
])

export const mailboxConnections = pgTable('mailbox_connections', {
  id: id(),
  orgId: orgId(),
  provider: text('provider').notNull(),
  providerAccountId: text('provider_account_id').notNull(),
  emailAddress: text('email_address').notNull(),              // lowercased addr-spec
  status: text('status').notNull().default('pending_claim'),  // pending_claim | connected | reauth_required | disabled
  cursor: jsonb('cursor'),                                    // gmail: { historyId: string } · graph: { deltaTokens: Record<folder,string> }
  resyncState: jsonb('resync_state'),                         // in-progress bounded resync bookmark
  pushSubscriptionId: text('push_subscription_id'),
  pushExpiresAt: timestamp('push_expires_at', { withTimezone: true }),
  pushClientStateHash: text('push_client_state_hash'),
  lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
  lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
  consecutiveFailures: integer('consecutive_failures').notNull().default(0),
  backoffUntil: timestamp('backoff_until', { withTimezone: true }),
  pollLeaseUntil: timestamp('poll_lease_until', { withTimezone: true }),  // the real per-connection mutex
  connectedByUserId: uuid('connected_by_user_id').notNull().references(() => user.id),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  check('mailbox_connections_provider_check', sql`${t.provider} IN ('gmail','microsoft')`),
  check('mailbox_connections_status_check', sql`${t.status} IN ('pending_claim','connected','reauth_required','disabled')`),
  index('mailbox_connections_org_idx').on(t.orgId, t.status),
  // the partial unique lives in the custom migration (0006) — drizzle can express it, but the
  // WHERE-clause snapshot churn across drizzle-kit versions is not worth it; SQL is stable:
  ...tenantPolicies(t.orgId, 'mailbox_connections'),
])

/** Token columns are platform-role-only: aesa_app may INSERT (the api's sealed write) and nothing else (migration 0006). */
export const mailboxCredentials = pgTable('mailbox_credentials', {
  connectionId: uuid('connection_id').primaryKey().references(() => mailboxConnections.id, { onDelete: 'cascade' }),
  orgId: orgId(),
  refreshTokenCiphertext: bytea('refresh_token_ciphertext').notNull(),
  accessTokenCiphertext: bytea('access_token_ciphertext'),
  accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
  refreshTokenHash: text('refresh_token_hash'),               // set once the worker opens the sealed box
  refreshLockUntil: timestamp('refresh_lock_until', { withTimezone: true }),
  encryption: text('encryption').notNull(),                   // 'sealed' (api wrote it) | 'dek' (worker re-wrapped)
  dataKeyVersion: integer('data_key_version'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  check('mailbox_credentials_encryption_check', sql`${t.encryption} IN ('sealed','dek')`),
  index('mailbox_credentials_org_idx').on(t.orgId),
  ...tenantPolicies(t.orgId, 'mailbox_credentials'),
])

export const gmailAccessRequests = pgTable('gmail_access_requests', {
  id: id(),
  orgId: orgId(),
  email: text('email').notNull(),
  requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
  grantedAt: timestamp('granted_at', { withTimezone: true }),
}, (t) => [
  uniqueIndex('gmail_access_requests_org_email_uidx').on(t.orgId, t.email),
  ...tenantPolicies(t.orgId, 'gmail_access_requests'),
])
