import { DEFAULT_CATEGORIES } from '@aesa/contracts'
import { categories } from './schema/support.ts'
import type { OrgTx } from './tenant.ts'

/** Idempotent: seeds the 8 default categories, never touches existing rows (labels are owner-editable). */
export async function ensureDefaultCategories(tx: OrgTx): Promise<void> {
  await tx.insert(categories)
    .values(DEFAULT_CATEGORIES.map((c) => ({ orgId: tx.orgId, key: c.key, label: c.label })))
    .onConflictDoNothing()
}
