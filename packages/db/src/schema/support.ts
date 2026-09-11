import { sql } from 'drizzle-orm'
import { boolean, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { user } from './auth.ts'
import { createdAt, id, orgId, tenantPolicies, updatedAt } from './helpers.ts'
import { mailboxConnections } from './mail.ts'

/** A mailbox address the agent replies from; one connection can host several (spec: multi-agent routing). */
export const agents = pgTable('agents', {
  id: id(), orgId: orgId(),
  connectionId: uuid('connection_id').notNull().references(() => mailboxConnections.id, { onDelete: 'cascade' }),
  address: text('address').notNull(),                          // lowercased
  replyFromAddress: text('reply_from_address'),                // NULL = sends as its own address
  domain: text('domain').notNull(),
  displayName: text('display_name').notNull(),
  signature: text('signature').notNull().default(''),
  personaPreset: text('persona_preset').notNull().default('support'),
  personaText: text('persona_text').notNull().default(''),
  guidanceExtra: text('guidance_extra').notNull().default(''),
  priority: integer('priority').notNull().default(0),          // routing order, lower wins
  status: text('status').notNull().default('pending_verification'),
  verificationCodeHash: text('verification_code_hash'),
  verificationExpiresAt: timestamp('verification_expires_at', { withTimezone: true }),
  consentRequiredFromUserId: uuid('consent_required_from_user_id').references(() => user.id),  // set when another user's connection
  autoGraduate: boolean('auto_graduate').notNull().default(false),
  autoSendDelayMin: integer('auto_send_delay_min').notNull().default(2),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [
  uniqueIndex('agents_org_address_uidx').on(t.orgId, t.address),
  index('agents_org_connection_idx').on(t.orgId, t.connectionId, t.priority),
  ...tenantPolicies(t.orgId, 'agents'),
])

/** Owner-editable label over a fixed key; the 8 defaults come from @aesa/contracts DEFAULT_CATEGORIES. */
export const categories = pgTable('categories', {
  id: id(), orgId: orgId(),
  key: text('key').notNull(), label: text('label').notNull(),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [uniqueIndex('categories_org_key_uidx').on(t.orgId, t.key), ...tenantPolicies(t.orgId, 'categories')])

/** Per (agent, category) auto-send policy; graduation/demotion trail. auto is unreachable until Phase 5. */
export const agentCategoryPolicies = pgTable('agent_category_policies', {
  orgId: orgId(),
  agentId: uuid('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  categoryId: uuid('category_id').notNull().references(() => categories.id, { onDelete: 'cascade' }),
  mode: text('mode').notNull().default('review'),              // off | review | auto (auto unreachable until Phase 5)
  autoSendMinConfidence: integer('auto_send_min_confidence'),  // percent 0-100
  graduatedAt: timestamp('graduated_at', { withTimezone: true }),
  demotedAt: timestamp('demoted_at', { withTimezone: true }),
  demotedReason: text('demoted_reason'),
  suggestedAt: timestamp('suggested_at', { withTimezone: true }),
  suggestedWouldSend: integer('suggested_would_send'),
  suggestedOf: integer('suggested_of'),
  updatedAt: updatedAt(),
}, (t) => [
  primaryKey({ columns: [t.agentId, t.categoryId] }),
  index('agent_category_policies_org_idx').on(t.orgId),
  ...tenantPolicies(t.orgId, 'agent_category_policies'),
])

/** One customer conversation thread per (connection, provider thread). */
export const tickets = pgTable('tickets', {
  id: id(), orgId: orgId(),
  connectionId: uuid('connection_id').notNull().references(() => mailboxConnections.id),
  agentId: uuid('agent_id').references(() => agents.id),
  providerThreadId: text('provider_thread_id').notNull(),
  customerEmail: text('customer_email'), customerName: text('customer_name'),
  subject: text('subject'),
  status: text('status').notNull().default('new'),
  needsOwnerReason: text('needs_owner_reason'),
  categoryId: uuid('category_id').references(() => categories.id),
  language: text('language'), sentiment: text('sentiment'),
  spamFlagged: boolean('spam_flagged').notNull().default(false),   // provider put it in spam/junk
  isSpam: boolean('is_spam'), isAutomated: boolean('is_automated'), // triage verdicts, NULL = untriaged
  hasAttachments: boolean('has_attachments').notNull().default(false),
  inboundCount: integer('inbound_count').notNull().default(0),
  lastInboundAt: timestamp('last_inbound_at', { withTimezone: true }),
  lastTriagedAt: timestamp('last_triaged_at', { withTimezone: true }),
  triageFailureCount: integer('triage_failure_count').notNull().default(0),
  triageQuestions: text('triage_questions').array().notNull().default(sql`'{}'::text[]`),
  lastAgentRunAt: timestamp('last_agent_run_at', { withTimezone: true }),
  lastAgentPromptedAt: timestamp('last_agent_prompted_at', { withTimezone: true }),
  lastAgentFinishedAt: timestamp('last_agent_finished_at', { withTimezone: true }),
  agentFailureCount: integer('agent_failure_count').notNull().default(0),
  ownerRedraftFeedback: text('owner_redraft_feedback'),
  redraftCount: integer('redraft_count').notNull().default(0),
  escalationNotifiedAt: timestamp('escalation_notified_at', { withTimezone: true }),
  aiHandledMonth: text('ai_handled_month'),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [
  uniqueIndex('tickets_connection_thread_uidx').on(t.connectionId, t.providerThreadId),
  index('tickets_org_status_idx').on(t.orgId, t.status, t.lastInboundAt),
  index('tickets_org_customer_idx').on(t.orgId, t.customerEmail, t.createdAt),
  ...tenantPolicies(t.orgId, 'tickets'),
])

/** One row per inbound/outbound email on a ticket; 'refs' spells out RFC 'References' (a SQL keyword). */
export const messages = pgTable('messages', {
  id: id(), orgId: orgId(),
  ticketId: uuid('ticket_id').notNull().references(() => tickets.id, { onDelete: 'cascade' }),
  connectionId: uuid('connection_id').notNull(),
  providerMessageId: text('provider_message_id').notNull(),
  direction: text('direction').notNull(),                      // inbound | outbound
  fromAddress: text('from_address'),
  toAddresses: text('to_addresses').array().notNull().default(sql`'{}'::text[]`),
  ccAddresses: text('cc_addresses').array().notNull().default(sql`'{}'::text[]`),
  subject: text('subject'), bodyText: text('body_text'),
  rfcMessageId: text('rfc_message_id'), inReplyTo: text('in_reply_to'),
  refs: text('refs').array().notNull().default(sql`'{}'::text[]`),   // 'references' is a SQL keyword; column name 'refs'
  authResults: text('auth_results'), dmarcPass: boolean('dmarc_pass'),
  attachments: jsonb('attachments').notNull().default(sql`'[]'::jsonb`),  // [{filename, mime, size}] metadata only
  draftId: uuid('draft_id'),
  sentAt: timestamp('sent_at', { withTimezone: true }),
  bodyPurgedAt: timestamp('body_purged_at', { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex('messages_connection_provider_uidx').on(t.connectionId, t.providerMessageId),
  index('messages_org_ticket_idx').on(t.orgId, t.ticketId, t.sentAt),
  index('messages_org_rfc_idx').on(t.orgId, t.rfcMessageId),
  ...tenantPolicies(t.orgId, 'messages'),
])
