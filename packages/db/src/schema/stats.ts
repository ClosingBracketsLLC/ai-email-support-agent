import { date, index, integer, pgTable, primaryKey, uuid } from 'drizzle-orm/pg-core'
import { orgId, tenantPolicies, updatedAt } from './helpers.ts'
import { agents, categories } from './support.ts'

/** Per agent × category × UTC day, recomputed nightly by `stats.rollup` from `drafts` (spec §Data model). */
export const categoryStatsDaily = pgTable('category_stats_daily', {
  orgId: orgId(),
  agentId: uuid('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  categoryId: uuid('category_id').notNull().references(() => categories.id, { onDelete: 'cascade' }),
  day: date('day').notNull(),
  drafted: integer('drafted').notNull().default(0),
  approvedUnchanged: integer('approved_unchanged').notNull().default(0),
  approvedEdited: integer('approved_edited').notNull().default(0),
  rejected: integer('rejected').notNull().default(0),
  autoSent: integer('auto_sent').notNull().default(0),
  autoSentConfirmed: integer('auto_sent_confirmed').notNull().default(0),
  autoSentFlagged: integer('auto_sent_flagged').notNull().default(0),
  held: integer('held').notNull().default(0),
  updatedAt: updatedAt(),
}, (t) => [
  primaryKey({ columns: [t.agentId, t.categoryId, t.day] }),
  index('category_stats_daily_org_day_idx').on(t.orgId, t.day),
  ...tenantPolicies(t.orgId, 'category_stats_daily'),
])
