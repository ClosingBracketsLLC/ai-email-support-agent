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
 * Lets a cross-org platform sweep (Task 14's backstop/daily crons) call an org-scoped helper —
 * `escalateTicket`, today — for ONE row while still running as `aesa_platform`. Unlike `withOrg`,
 * this does NOT set `app.org_id` or switch role: the transaction it is handed is already a
 * `PlatformTx` (or a SAVEPOINT of one), RLS is already bypassed (`<table>_platform_all` USING
 * true), and every write the helper makes is keyed by an explicit row id (`ticketId`), never by
 * `app.org_id`. `orgId` here feeds ONLY `audit()`'s `tx.orgId` read and the notification insert's
 * explicit `orgId` column — it is identity for the audit trail, not a security boundary. Call it
 * fresh per row (never on the shared outer platform tx, which spans every row in the pass) so one
 * row's identity can never leak into another's audit row.
 *
 * Typed on the unbranded `Tx`, not `PlatformTx`: the usual caller passes a per-row SAVEPOINT
 * (`tx.transaction((tx2) => ...)`), and drizzle's own `transaction()` callback parameter is `Tx`,
 * not the branded type of the transaction it was opened on — `PlatformTx` would reject it. `Tx`
 * still accepts the outer `PlatformTx` too (a strict superset), so either can be passed.
 *
 * Returns a NEW object rather than branding the caller's. `Object.create(tx)` puts `orgId` on a
 * wrapper whose prototype IS the transaction, so every drizzle method and field still resolves
 * through the chain (drizzle's pg-core classes hold no `#private` state that a receiver swap would
 * break — `test/tenant.test.ts` proves a real query and a real audit row still work through the
 * wrapper), while the transaction the caller passed in is left un-branded. Mutating it, as this used
 * to, left "call it fresh per row" a rule nothing could enforce: one mistaken call on the shared
 * outer platform tx would have branded it permanently, for every row after it.
 */
export function withOrgIdentity(tx: Tx, orgId: string): OrgTx {
  return Object.assign(Object.create(tx) as Tx, { orgId }) as unknown as OrgTx
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
