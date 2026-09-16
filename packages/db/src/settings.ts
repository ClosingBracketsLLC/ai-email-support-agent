/**
 * `resolveSetting`'s two data sources (`@aesa/core`), read together. `org` is one SELECT over the
 * requested keys — the shape the api's `org-settings.ts` and the worker's `knowledge/sources.ts`
 * each used to carry their own copy of (both deleted in Phase 7; this is the ONE loader now),
 * because it is also the place that can resolve `plan`, which those two duplicates never did:
 * `plan` is
 * `planSettingDefaults(readBillingState(tx, now).plan)`, so a caller resolving a cap gets the org's
 * own override, falling back to the WORKSPACE'S CURRENT PLAN's default, falling back to the code
 * default `resolveSetting` already knows — in that order.
 */
import { and, eq, inArray } from 'drizzle-orm'
import { planSettingDefaults, type PlanId, type SettingKey } from '@aesa/core'
import { readBillingState, type BillingStateView } from './billing.ts'
import { orgSettings } from './schema/index.ts'
import type { OrgTx } from './tenant.ts'

export interface SettingSources {
  org: Partial<Record<SettingKey, unknown>>
  plan: Partial<Record<SettingKey, number | boolean>>
  planId: PlanId
  /** The whole `readBillingState` view the plan defaults were resolved from (ruling R27): a caller
   *  that needs the derived STATE (`trialing` vs `trial_expired`/`canceled` — the trial budget
   *  applies to the first alone) or the trial clock reads it here instead of reading the row again. */
  billing: BillingStateView
}

/** org_settings for `keys` + `planSettingDefaults(readBillingState(tx, now).plan)`. One query each. */
export async function loadSettingSources(tx: OrgTx, keys: readonly SettingKey[], now: Date = new Date()): Promise<SettingSources> {
  const rows = keys.length === 0
    ? []
    : await tx
        .select({ key: orgSettings.key, value: orgSettings.value })
        .from(orgSettings)
        .where(and(eq(orgSettings.orgId, tx.orgId), inArray(orgSettings.key, [...keys])))
  const org: Partial<Record<SettingKey, unknown>> = {}
  for (const row of rows) org[row.key as SettingKey] = row.value

  const billing = await readBillingState(tx, now)
  return { org, plan: planSettingDefaults(billing.plan), planId: billing.plan, billing }
}
