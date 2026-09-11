import { sql } from 'drizzle-orm'
import { boolean, index, integer, jsonb, pgTable, real, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { user } from './auth.ts'
import { createdAt, emptyTextArray, id, orgId, tenantPolicies, updatedAt } from './helpers.ts'
import { agentRuns } from './runs.ts'
import { agents, categories, tickets } from './support.ts'

/** One model-authored (or redrafted) reply awaiting an owner decision; the one-live-per-ticket partial unique lives in 0011. */
export const drafts = pgTable('drafts', {
  id: id(), orgId: orgId(),
  ticketId: uuid('ticket_id').notNull().references(() => tickets.id, { onDelete: 'cascade' }),
  agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'set null' }),
  agentRunId: uuid('agent_run_id').references(() => agentRuns.id, { onDelete: 'set null' }),
  version: integer('version').notNull().default(1),                        // per ticket, 1 + count of prior drafts
  body: text('body').notNull(),                                            // the validator-normalized model body
  finalBody: text('final_body'),                                           // what was approved (edited or not); the send reads THIS
  categoryId: uuid('category_id').references(() => categories.id, { onDelete: 'set null' }),
  modelConfidence: real('model_confidence'), confidence: real('confidence'),
  confidenceBreakdown: jsonb('confidence_breakdown').notNull().default(sql`'{}'::jsonb`),
  guardrailResult: jsonb('guardrail_result').notNull().default(sql`'{}'::jsonb`),
  decision: text('decision').notNull(), decisionReason: text('decision_reason').notNull(),   // send | review | escalate (CHECK)
  status: text('status').notNull().default('pending'),                     // DRAFT_STATUSES (CHECK)
  retrievedChunkIds: text('retrieved_chunk_ids').array().notNull().default(emptyTextArray()),
  citedChunkIds: text('cited_chunk_ids').array().notNull().default(emptyTextArray()),
  retrievedAnswerIds: text('retrieved_answer_ids').array().notNull().default(emptyTextArray()),
  usedAnswerIds: text('used_answer_ids').array().notNull().default(emptyTextArray()),
  memoryConflictIds: text('memory_conflict_ids').array().notNull().default(emptyTextArray()),
  rationale: text('rationale'),
  unresolvedQuestions: text('unresolved_questions').array().notNull().default(emptyTextArray()),
  customerLanguage: text('customer_language'),
  threadSnapshotAt: timestamp('thread_snapshot_at', { withTimezone: true }).notNull(),   // the staleness watermark; the send refuses without it
  isRedraft: boolean('is_redraft').notNull().default(false),
  viewedAt: timestamp('viewed_at', { withTimezone: true }),
  decidedBy: uuid('decided_by').references(() => user.id, { onDelete: 'set null' }),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  decisionSource: text('decision_source'),                                 // app | email | auto (CHECK)
  rejectReason: text('reject_reason'), rejectAction: text('reject_action'),
  editDistanceRatio: real('edit_distance_ratio'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [
  index('drafts_org_ticket_idx').on(t.orgId, t.ticketId, t.createdAt),
  index('drafts_org_status_idx').on(t.orgId, t.status, t.createdAt),
  ...tenantPolicies(t.orgId, 'drafts'),
])

/** A single-use, hashed link the review email/push carries; resolved session-less via resolve_draft_action_token (0011). */
export const draftActionTokens = pgTable('draft_action_tokens', {
  id: id(), orgId: orgId(),
  draftId: uuid('draft_id').notNull().references(() => drafts.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex('draft_action_tokens_hash_uidx').on(t.tokenHash),
  index('draft_action_tokens_org_draft_idx').on(t.orgId, t.draftId),
  ...tenantPolicies(t.orgId, 'draft_action_tokens'),
])
