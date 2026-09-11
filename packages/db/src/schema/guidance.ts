import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { user } from './auth.ts'
import { drafts } from './drafts.ts'
import { createdAt, id, orgId, tenantPolicies } from './helpers.ts'
import { agents, categories } from './support.ts'

/** An LLM-drafted operating-guidance rule proposed after an edited approval (spec §Product step 7); one tap accepts it. */
export const guidanceSuggestions = pgTable('guidance_suggestions', {
  id: id(), orgId: orgId(),
  agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'set null' }),
  categoryId: uuid('category_id').references(() => categories.id, { onDelete: 'set null' }),
  sourceDraftId: uuid('source_draft_id').references(() => drafts.id, { onDelete: 'set null' }),
  text: text('text').notNull(),
  rationale: text('rationale').notNull().default(''),
  status: text('status').notNull().default('pending'),        // pending | accepted | dismissed (CHECK, 0017)
  createdAt: createdAt(),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  decidedBy: uuid('decided_by').references(() => user.id, { onDelete: 'set null' }),
}, (t) => [
  index('guidance_suggestions_org_status_idx').on(t.orgId, t.status, t.createdAt.desc()),
  ...tenantPolicies(t.orgId, 'guidance_suggestions'),
])
