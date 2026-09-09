import { auditLog } from './schema/index.ts'
import type { OrgTx } from './tenant.ts'

export type AuditActor = `user:${string}` | `agent:${string}` | `system:${string}`
const ACTOR_RE = /^(user|agent|system):[A-Za-z0-9._:-]+$/

export interface AuditEntry {
  actor: AuditActor
  action: string
  entityType: string
  entityId: string
  /** Already redacted by the caller: never bodies, never secrets, never tokens. */
  detail?: Record<string, unknown>
  ip?: string | null
  userAgent?: string | null
}

/** Appends one audit_log row for the transaction's organization. The only tenant-side writer of audit_log. */
export async function audit(tx: OrgTx, entry: AuditEntry): Promise<void> {
  if (!ACTOR_RE.test(entry.actor)) throw new TypeError(`audit: actor must be user:<id> | agent:<run_id> | system:<job>, got ${JSON.stringify(entry.actor)}`)
  await tx.insert(auditLog).values({
    orgId: tx.orgId, actor: entry.actor, action: entry.action, entityType: entry.entityType, entityId: entry.entityId,
    detail: entry.detail ?? {}, ip: entry.ip ?? null, userAgent: entry.userAgent ?? null,
  })
}
