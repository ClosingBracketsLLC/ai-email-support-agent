import { sql } from 'drizzle-orm'
import { customType, pgPolicy, timestamp, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core'
import { aesaApp, aesaPlatform } from './roles.ts'

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

export const ORG_ID_PREDICATE_SQL = "org_id = NULLIF(current_setting('app.org_id', true), '')::uuid"

/**
 * The two policies every tenant table gets. NULLIF matters: a pooled connection that ran SET LOCAL in an
 * earlier transaction leaves app.org_id as '' (not NULL) and ''::uuid would raise instead of matching nothing.
 *
 * Two manual steps ride with every new tenant table, both pinned by the RLS invariant in `test/rls.test.ts`:
 * drizzle-kit emits ENABLE ROW LEVEL SECURITY only for tables that declare policies and never emits FORCE,
 * so the migration must add its own `ALTER TABLE ... FORCE ROW LEVEL SECURITY` line. And migration 0002's
 * `ALTER DEFAULT PRIVILEGES` already grants aesa_app full DML on every FUTURE table in `public`, so a table
 * that must restrict the app role (Phase 2's `mailbox_credentials`: worker-role column grants only) needs
 * explicit REVOKEs in its own migration — the default is permissive.
 */
export function tenantPolicies(orgIdColumn: AnyPgColumn, table: string) {
  const predicate = sql`${orgIdColumn} = NULLIF(current_setting('app.org_id', true), '')::uuid`
  return [
    pgPolicy(`${table}_org_isolation`, { as: 'permissive', for: 'all', to: aesaApp, using: predicate, withCheck: predicate }),
    pgPolicy(`${table}_platform_all`, { as: 'permissive', for: 'all', to: aesaPlatform, using: sql`true`, withCheck: sql`true` }),
  ]
}
