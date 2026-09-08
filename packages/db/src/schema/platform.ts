import { jsonb, pgTable, text } from 'drizzle-orm/pg-core'
import { updatedAt } from './helpers.ts'

/** Platform switches and provider backoff shared by all workers (killswitch.global, *.backoff_until …). No RLS. */
export const platformState = pgTable('platform_state', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: updatedAt(),
})
