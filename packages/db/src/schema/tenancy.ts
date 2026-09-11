import { sql } from 'drizzle-orm'
import {
  bigint, bigserial, boolean, check, date, index, inet, integer, jsonb, pgTable, primaryKey, text, timestamp, uuid,
} from 'drizzle-orm/pg-core'
import { organization } from './auth.ts'
import { bytea, createdAt, emptyTextArray, orgId, tenantPolicies, updatedAt } from './helpers.ts'

// The check constraints below spell the same literals: drizzle-kit inlines sql`` parameters into DDL only
// partially, so building them from the arrays would change the snapshot. Keep both in sync by hand.
export { ONBOARDING_STEPS, TONES } from '@aesa/contracts'

/** One row per organization: business identity, guardrail allowlists, guidance, switches. */
export const workspaces = pgTable('workspaces', {
  orgId: uuid('org_id').primaryKey().references(() => organization.id),   // Better Auth organization; deletion is disabled in the plugin
  businessName: text('business_name').notNull(),
  websiteUrl: text('website_url'),
  description: text('description'),
  tone: text('tone').notNull().default('friendly'),
  timezone: text('timezone').notNull(),
  locale: text('locale').notNull().default('en'),
  contactPhone: text('contact_phone'),
  contactUrls: text('contact_urls').array().notNull().default(emptyTextArray()),
  allowedUrlHosts: text('allowed_url_hosts').array().notNull().default(emptyTextArray()),
  allowedEmailDomains: text('allowed_email_domains').array().notNull().default(emptyTextArray()),
  tripwireExtraKeywords: text('tripwire_extra_keywords').array().notNull().default(emptyTextArray()),
  operatingGuidance: text('operating_guidance').notNull().default(''),
  agentEnabled: boolean('agent_enabled').notNull().default(false),
  agentEnabledAt: timestamp('agent_enabled_at', { withTimezone: true }),
  killSwitch: boolean('kill_switch').notNull().default(false),
  onboardingStep: text('onboarding_step').notNull().default('profile'),
  retentionDays: integer('retention_days').notNull().default(180),
  knowledgeVersion: integer('knowledge_version').notNull().default(0),
  /** X25519 public key the api seals new secrets to (Task 7); the private key lives in org_data_keys. */
  boxPublicKey: bytea('box_public_key'),
  /** Random 32 bytes minted lazily by `ensureCustomerHashSalt`; keys `resolved_answers.source_customer_hash`;
   * never returned by an API. */
  customerHashSalt: bytea('customer_hash_salt'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  check('workspaces_tone_check', sql`${t.tone} IN ('friendly','formal','concise')`),
  check('workspaces_onboarding_step_check', sql`${t.onboardingStep} IN ('profile','mailbox','knowledge','go_live','done')`),
  check('workspaces_retention_days_check', sql`${t.retentionDays} BETWEEN 30 AND 730`),
  ...tenantPolicies(t.orgId, 'workspaces'),
])

/** Per-org typed key/value overrides; resolution is org override > plan default > code default. */
export const orgSettings = pgTable('org_settings', {
  orgId: orgId(),
  key: text('key').notNull(),
  value: jsonb('value').notNull(),
  updatedBy: text('updated_by'),
  updatedAt: updatedAt(),
}, (t) => [primaryKey({ columns: [t.orgId, t.key] }), ...tenantPolicies(t.orgId, 'org_settings')])

/** The metering table every cap and every bill reads. Meters are plain text so adding one needs no migration. */
export const usageCounters = pgTable('usage_counters', {
  orgId: orgId(),
  day: date('day').notNull(),
  meter: text('meter').notNull(),
  value: bigint('value', { mode: 'number' }).notNull().default(0),
  updatedAt: updatedAt(),
}, (t) => [primaryKey({ columns: [t.orgId, t.day, t.meter] }), ...tenantPolicies(t.orgId, 'usage_counters')])

/** Append-only trail with real actor identity: user:<id> | agent:<run_id> | system:<job>. Never bodies. */
export const auditLog = pgTable('audit_log', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(),
  orgId: uuid('org_id'),                               // NULL only for platform events
  actor: text('actor').notNull(),
  action: text('action').notNull(),
  entityType: text('entity_type').notNull(),
  entityId: text('entity_id').notNull(),
  detail: jsonb('detail').notNull().default(sql`'{}'::jsonb`),
  ip: inet('ip'),
  userAgent: text('user_agent'),
  createdAt: createdAt(),
}, (t) => [
  index('audit_log_org_created_idx').on(t.orgId, t.createdAt.desc()),
  index('audit_log_org_entity_idx').on(t.orgId, t.entityType, t.entityId),
  ...tenantPolicies(t.orgId, 'audit_log'),
])

/** Per-org data-encryption keys (Task 6/7): the DEK wrapped by a versioned KEK, and the sealed-box keypair. */
export const orgDataKeys = pgTable('org_data_keys', {
  orgId: orgId(),
  version: integer('version').notNull(),
  wrappedDek: bytea('wrapped_dek').notNull(),
  kekVersion: integer('kek_version').notNull(),
  boxPublicKey: bytea('box_public_key').notNull(),
  boxPrivateKeyCiphertext: bytea('box_private_key_ciphertext').notNull(),   // encrypted under the DEK
  createdAt: createdAt(),
}, (t) => [primaryKey({ columns: [t.orgId, t.version] }), ...tenantPolicies(t.orgId, 'org_data_keys')])
