import { sql } from 'drizzle-orm'
import type { Db } from './client.ts'
import { auditLog } from './schema/index.ts'

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

declare const orgTxBrand: unique symbol
declare const platformTxBrand: unique symbol

/** A transaction handle whose queries are scoped to one organization by RLS. Only withOrg() produces one. */
export type OrgTx = Tx & { readonly [orgTxBrand]: true; readonly orgId: string }
/** A transaction handle running as aesa_platform (policy USING true). Only withPlatform() produces one. */
export type PlatformTx = Tx & { readonly [platformTxBrand]: true }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
export const isUuid = (s: string): boolean => UUID_RE.test(s)

/**
 * Runs `fn` inside one transaction with `app.org_id` set for the duration (set_config(..., true) is
 * SET LOCAL, and parametrizable). The pool connection is already `aesa_app`, so RLS scopes every
 * statement to `orgId`. RULE: never await network I/O inside `fn` — the transaction holds a connection
 * and the role's idle_in_transaction_session_timeout (5 s) will kill it.
 */
export async function withOrg<T>(db: Db, orgId: string, fn: (tx: OrgTx) => Promise<T>): Promise<T> {
  if (!isUuid(orgId)) throw new TypeError(`withOrg: orgId must be a uuid, got ${JSON.stringify(orgId)}`)
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.org_id', ${orgId}, true)`)
    return fn(Object.assign(tx, { orgId }) as OrgTx)
  })
}

/**
 * Cross-organization access for sweeps and crons. `reason` is required so every call site documents
 * why it needs to see all tenants. Switches the transaction's role to aesa_platform; the session user
 * (owner/admin) is a member of it via migration 0002. Every call writes one `audit_log` row (org_id NULL,
 * actor `system:<reason>`) inside the same transaction and before `fn`, so the trail is a table, not a grep,
 * and a rolled-back sweep leaves no claim that it ran.
 */
export async function withPlatform<T>(db: Db, reason: string, fn: (tx: PlatformTx) => Promise<T>): Promise<T> {
  if (!reason) throw new TypeError('withPlatform: reason is required')
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL ROLE aesa_platform`)
    await tx.execute(sql`SELECT set_config('app.org_id', '', true)`)
    await tx.insert(auditLog).values({ orgId: null, actor: `system:${reason}`, action: 'platform.access', entityType: 'platform', entityId: reason })
    return fn(tx as PlatformTx)
  })
}
