/**
 * The org's rows for the settings keys a caller resolves, in `resolveSetting`'s `{ org }` shape
 * (`@aesa/core`). Mirrors the worker's identical helper (`apps/worker/src/knowledge/sources.ts`'s
 * `loadOrgSettings`) so both processes read `org_settings` the same way — kept here (not in a
 * shared package) because `packages/core`'s `resolveSetting` takes plain data, not a `Tx`, and
 * the api's own callers (`agents.ts`'s sandbox cap, the knowledge router's upload/crawl caps) have
 * no other shared home for the SELECT.
 */
import { inArray } from 'drizzle-orm'
import type { SettingKey } from '@aesa/core'
import { orgSettings, type OrgTx } from '@aesa/db'

export async function loadOrgSettings(tx: OrgTx, keys: SettingKey[]): Promise<Partial<Record<SettingKey, unknown>>> {
  const rows = await tx
    .select({ key: orgSettings.key, value: orgSettings.value })
    .from(orgSettings)
    .where(inArray(orgSettings.key, keys))
  const out: Partial<Record<SettingKey, unknown>> = {}
  for (const row of rows) out[row.key as SettingKey] = row.value
  return out
}
