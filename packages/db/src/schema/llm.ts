import { sql } from 'drizzle-orm'
import { boolean, check, doublePrecision, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { agents } from './support.ts'
import { bytea, createdAt, id, orgId, tenantPolicies, updatedAt } from './helpers.ts'

/** A BYOK provider connection's api-visible half: label, provider, endpoint, fingerprint, health. The key itself is in `llm_credential_secrets`. */
export const llmCredentials = pgTable('llm_credentials', {
  id: id(), orgId: orgId(),
  provider: text('provider').notNull(),                       // LLM_PROVIDERS (CHECK, 0020)
  label: text('label').notNull(),
  /** Null for a preset provider (the adapter uses the preset's base URL); the validated https URL for `custom`. */
  baseUrl: text('base_url'),
  /** sha256 hex prefix 8 + '…' + the key's last 4 chars — display only, never enough to reconstruct. */
  keyFingerprint: text('key_fingerprint').notNull(),
  /** The model `llm.probe` exercises: the owner's choice for `custom`, the preset's draft suggestion otherwise. */
  probeModel: text('probe_model'),
  transport: text('transport').notNull().default('direct'),   // 'direct' only in v1 (CHECK) — the spec's bridge seam
  healthStatus: text('health_status').notNull().default('unknown'),   // CREDENTIAL_HEALTH (CHECK)
  lastProbe: jsonb('last_probe'),                              // ProbeResultView
  lastProbedAt: timestamp('last_probed_at', { withTimezone: true }),
  consecutiveFailures: integer('consecutive_failures').notNull().default(0),
  lastError: text('last_error'),                               // scrubbed, ≤ 200 chars
  createdBy: text('created_by').notNull(),                     // user:<id>
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [
  check('llm_credentials_provider_check', sql`${t.provider} IN ('anthropic','openai','deepseek','groq','together','openrouter','custom')`),
  check('llm_credentials_health_check', sql`${t.healthStatus} IN ('unknown','healthy','degraded','dead')`),
  check('llm_credentials_transport_check', sql`${t.transport} IN ('direct')`),
  index('llm_credentials_org_idx').on(t.orgId, t.createdAt),
  ...tenantPolicies(t.orgId, 'llm_credentials'),
])

/** Platform-role-only (0020 REVOKEs aesa_app): the api writes a SEALED blob into the `llm.probe` payload, the worker stores it here and re-wraps it under the org DEK. */
export const llmCredentialSecrets = pgTable('llm_credential_secrets', {
  credentialId: uuid('credential_id').primaryKey().references(() => llmCredentials.id, { onDelete: 'cascade' }),
  orgId: orgId(),
  keyCiphertext: bytea('key_ciphertext').notNull(),
  encryption: text('encryption').notNull(),                    // 'sealed' | 'dek' (CHECK)
  dataKeyVersion: integer('data_key_version'),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [
  check('llm_credential_secrets_encryption_check', sql`${t.encryption} IN ('sealed','dek')`),
  index('llm_credential_secrets_org_idx').on(t.orgId),
  ...tenantPolicies(t.orgId, 'llm_credential_secrets'),
])

/**
 * Per agent × role model choice. `agent_id IS NULL` = the workspace default (admitted, unwritten
 * in v1). The unique index on (org_id, agent_id, role) is declared BY HAND in
 * 0020_provider_hardening.sql with `NULLS NOT DISTINCT` — drizzle 0.44's `uniqueIndex()` builder
 * has no `.nullsNotDistinct()` (only the table-level `unique()` constraint builder does), so
 * expressing it here would silently drop the NULLS NOT DISTINCT clause from the generated SQL.
 */
export const agentModelConfig = pgTable('agent_model_config', {
  id: id(), orgId: orgId(),
  agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'cascade' }),
  role: text('role').notNull(),                                // 'draft' | 'triage' (CHECK)
  mode: text('mode').notNull().default('managed'),             // 'managed' | 'byok' (CHECK)
  credentialId: uuid('credential_id').references(() => llmCredentials.id, { onDelete: 'set null' }),
  model: text('model'),                                        // null → the managed default for the role
  effort: text('effort'),                                      // 'low' | 'medium' | 'high' | null (CHECK)
  fallbackToManaged: boolean('fallback_to_managed').notNull().default(false),
  modelGeneration: integer('model_generation').notNull().default(1),
  modelGenerationAt: timestamp('model_generation_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [
  check('agent_model_config_role_check', sql`${t.role} IN ('draft','triage')`),
  check('agent_model_config_mode_check', sql`${t.mode} IN ('managed','byok')`),
  check('agent_model_config_effort_check', sql`${t.effort} IS NULL OR ${t.effort} IN ('low','medium','high')`),
  // No separate plain org_id index: the hand-written (org_id, agent_id, role) unique index in
  // 0020_provider_hardening.sql already serves an org-only lookup via its leftmost prefix
  // (categories' (org_id, key) unique index is the same shape, with the same omission).
  ...tenantPolicies(t.orgId, 'agent_model_config'),
])

/** Platform data (RLS_EXEMPT, like platform_state): USD per MTok, versioned by effective_from. Seeded by 0020. */
export const modelPricing = pgTable('model_pricing', {
  id: text('id').notNull(),                                    // the pricing family, e.g. 'gpt-5'
  provider: text('provider').notNull(),
  pattern: text('pattern').notNull(),                          // RegExp source, prefix-anchored
  inputPerMtok: doublePrecision('input_per_mtok').notNull(),
  outputPerMtok: doublePrecision('output_per_mtok').notNull(),
  cacheReadPerMtok: doublePrecision('cache_read_per_mtok').notNull(),
  cacheWrite5mPerMtok: doublePrecision('cache_write_5m_per_mtok').notNull(),
  cacheWrite1hPerMtok: doublePrecision('cache_write_1h_per_mtok').notNull(),
  effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull(),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('model_pricing_id_effective_uidx').on(t.id, t.effectiveFrom)])
