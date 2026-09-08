import { sql } from 'drizzle-orm'
import { customType, timestamp, uuid } from 'drizzle-orm/pg-core'

export const id = () => uuid('id').primaryKey().defaultRandom()
export const orgId = () => uuid('org_id').notNull()
export const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
export const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date())

/** drizzle-orm has no bytea column; ciphertexts and keys use this. */
export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() { return 'bytea' },
})

export const emptyTextArray = () => sql`'{}'::text[]`
