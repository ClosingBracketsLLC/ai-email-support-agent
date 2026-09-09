import { bigserial, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core'
import { updatedAt } from './helpers.ts'

/** Platform switches and provider backoff shared by all workers (killswitch.global, *.backoff_until …). No RLS. */
export const platformState = pgTable('platform_state', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: updatedAt(),
})

/** Provider webhook envelope dedupe; 7-day prune runs in mailbox.poll-sweep. RLS_EXEMPT. */
export const webhookEvents = pgTable('webhook_events', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(),
  provider: text('provider').notNull(),
  externalId: text('external_id').notNull(),
  envelope: jsonb('envelope').notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex('webhook_events_external_uidx').on(t.provider, t.externalId)])
