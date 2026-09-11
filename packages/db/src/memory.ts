import { createHash, randomBytes } from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import { workspaces } from './schema/tenancy.ts'
import type { OrgTx } from './tenant.ts'

/** Per-org salted, domain-separated, over the lowercased trimmed addr-spec (spec §Learning loop privacy). */
export function customerHash(salt: Buffer, email: string): string {
  return createHash('sha256').update(salt).update(`customer:${email.trim().toLowerCase()}`).digest('hex')
}

/** Mints the org's salt on first use; a concurrent minter loses the guarded UPDATE and reads the winner's. */
export async function ensureCustomerHashSalt(tx: OrgTx, orgId: string): Promise<Buffer> {
  const [existing] = await tx.select({ salt: workspaces.customerHashSalt }).from(workspaces).where(eq(workspaces.orgId, orgId))
  if (!existing) throw new Error(`ensureCustomerHashSalt: org ${orgId} has no workspace row`)
  if (existing.salt) return existing.salt
  await tx.update(workspaces).set({ customerHashSalt: randomBytes(32) })
    .where(sql`${workspaces.orgId} = ${orgId}::uuid AND ${workspaces.customerHashSalt} IS NULL`)
  const [after] = await tx.select({ salt: workspaces.customerHashSalt }).from(workspaces).where(eq(workspaces.orgId, orgId))
  if (!after?.salt) throw new Error(`ensureCustomerHashSalt: salt still missing for org ${orgId}`)
  return after.salt
}
