import { sql } from 'drizzle-orm'
import { index, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core'
import { createdAt, id, orgId, tenantPolicies } from './helpers.ts'

/** The owner-facing notification outbox (push/email digest fan-out, Phase 2's notify.dispatch job). */
export const notifications = pgTable('notifications', {
  id: id(), orgId: orgId(),
  kind: text('kind').notNull(),                                // escalation | mailbox_reauth | digest
  title: text('title').notNull(), body: text('body').notNull(),
  dedupeKey: text('dedupe_key').notNull(),
  payload: jsonb('payload').notNull().default(sql`'{}'::jsonb`),  // e.g. { ticketId } for deep links
  status: text('status').notNull().default('pending'),         // pending | sent | collapsed | failed
  sentAt: timestamp('sent_at', { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex('notifications_dedupe_uidx').on(t.dedupeKey),
  index('notifications_org_status_idx').on(t.orgId, t.status, t.createdAt),
  ...tenantPolicies(t.orgId, 'notifications'),
])
