import { boolean, index, integer, pgTable, text, timestamp, uuid, vector, type AnyPgColumn } from 'drizzle-orm/pg-core'
import { drafts } from './drafts.ts'
import { createdAt, emptyTextArray, id, orgId, tenantPolicies, updatedAt } from './helpers.ts'
import { agents, categories, tickets } from './support.ts'

/**
 * A human-approved (or, until sampled, auto-sent) reply, scrubbed and embedded, retrieved into the
 * next similar draft's prompt as "an answer this business has given before" (spec §Learning loop).
 * Never a raw customer body: `question_text`/`answer_body` are the scrubbed forms `@aesa/knowledge`'s
 * `scrubForMemory` produces. `expires_at` is a FIXED 365 days from the HUMAN decision that set it —
 * capture, a reinforcing approval, or `confirmCandidate` — and nothing else moves it: being retrieved
 * into a prompt, or cited by a draft nobody approved, buys an answer no extra life (CLAUDE.md, Memory).
 */
export const resolvedAnswers = pgTable('resolved_answers', {
  id: id(), orgId: orgId(),
  agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'set null' }),
  categoryId: uuid('category_id').references(() => categories.id, { onDelete: 'set null' }),
  questionText: text('question_text').notNull(),
  questionEmbedding: vector('question_embedding', { dimensions: 1024 }),
  embeddingModel: text('embedding_model'),
  embeddingVersion: integer('embedding_version'),
  answerBody: text('answer_body').notNull(),
  status: text('status').notNull().default('active'),          // candidate | active | needs_review | retired (CHECK, 0017)
  approvals: integer('approvals').notNull().default(0),
  strikes: integer('strikes').notNull().default(0),
  reuseCount: integer('reuse_count').notNull().default(0),
  wasEdited: boolean('was_edited').notNull().default(false),
  citedChunkIds: text('cited_chunk_ids').array().notNull().default(emptyTextArray()),
  knowledgeVersion: integer('knowledge_version').notNull().default(0),
  sourceTicketId: uuid('source_ticket_id').references(() => tickets.id, { onDelete: 'set null' }),
  sourceDraftId: uuid('source_draft_id').references(() => drafts.id, { onDelete: 'set null' }),
  sourceCustomerHash: text('source_customer_hash'),             // sha256(salt ‖ 'customer:' ‖ email) — delete-by-customer's key
  supersedesId: uuid('supersedes_id').references((): AnyPgColumn => resolvedAnswers.id, { onDelete: 'set null' }),
  reviewReason: text('review_reason'),                          // contracts REVIEW_REASONS
  retiredReason: text('retired_reason'),                        // contracts RETIRED_REASONS
  lastApprovedAt: timestamp('last_approved_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [
  index('resolved_answers_org_status_idx').on(t.orgId, t.status),
  index('resolved_answers_org_customer_idx').on(t.orgId, t.sourceCustomerHash),
  index('resolved_answers_org_agent_category_idx').on(t.orgId, t.agentId, t.categoryId),
  index('resolved_answers_org_source_draft_idx').on(t.orgId, t.sourceDraftId),
  ...tenantPolicies(t.orgId, 'resolved_answers'),
])
