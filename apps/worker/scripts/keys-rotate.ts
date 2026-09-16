#!/usr/bin/env tsx
/**
 * `pnpm --filter @aesa/worker keys:rotate` — the operator side of a KEK rotation.
 *
 * A rotation is two steps, and this script is the second: FIRST add the new key to the ring on every
 * replica (`AESA_KEK_V<n>` plus `AESA_KEK_ACTIVE=<n>`, the SAME ring everywhere — a key sealed under
 * one ring cannot be opened by a replica holding another), THEN run this to enqueue one `keys.rotate`
 * per workspace still wrapped under an older KEK. It ENQUEUES only: the `sync`-role worker holds the
 * ring and does the re-wrapping, and this process never opens a single key itself.
 *
 * Safe to re-run. `selectOrgsNeedingRotate` re-derives the work list from the database every time, so
 * an org whose job failed, was collapsed by pg-boss, or lost the guarded write (`lost_race`) is
 * simply selected again on the next run. Running it before the new key is on every replica is the one
 * thing that hurts: those replicas would hold a ring that cannot unwrap what this rotated.
 */
import { pathToFileURL } from 'node:url'
import { sql } from 'drizzle-orm'
import { loadDotEnv } from '@aesa/core'
import type { KekRing } from '@aesa/crypto'
import { withPlatform, type Db } from '@aesa/db'
import { createDb } from '@aesa/db/raw'
import { enqueue, startBoss } from '@aesa/queue'
import { loadConfig } from '../src/config.ts'
import { keysRotateJob } from '../src/jobs/keys-rotate.ts'

export interface OrgNeedingRotate {
  orgId: string
  /** The KEK the org's CURRENT (max-version) key row is wrapped under. */
  kekVersion: number
}

/**
 * Every org whose NEWEST key row is not on `ring.active`. The `DISTINCT ON` has to run first and the
 * `kek_version` filter second (hence the subquery): filtering inside the `DISTINCT ON` would pick the
 * newest row that merely happens to be off the active KEK, which for an org already rotated is an
 * OLD version — and would enqueue a rotate for an org that needs none.
 */
export async function selectOrgsNeedingRotate(db: Db, ring: KekRing): Promise<OrgNeedingRotate[]> {
  return withPlatform(db, 'script:keys.rotate', async (tx) => {
    const res = await tx.execute<{ org_id: string; kek_version: number }>(sql`
      SELECT org_id, kek_version FROM (
        SELECT DISTINCT ON (org_id) org_id, kek_version
        FROM org_data_keys
        ORDER BY org_id, version DESC
      ) current
      WHERE kek_version <> ${ring.active}
      ORDER BY org_id
    `)
    return res.rows.map((r) => ({ orgId: r.org_id, kekVersion: Number(r.kek_version) }))
  })
}

async function main(): Promise<void> {
  loadDotEnv(import.meta.url)
  const config = loadConfig(process.env)
  if (!config.kekRing) {
    throw new Error('keys:rotate needs AESA_KEK_V<n>/AESA_KEK_ACTIVE — set the ring this deployment uses and re-run')
  }
  const ring = config.kekRing
  const { db, pool } = createDb(config.databaseUrl, { role: 'app' })
  const boss = await startBoss(config.databaseUrl)
  try {
    const orgs = await selectOrgsNeedingRotate(db, ring)
    let enqueued = 0
    for (const org of orgs) {
      const id = await enqueue(boss, keysRotateJob, { orgId: org.orgId }, { entityId: org.orgId })
      if (id) enqueued += 1
    }
    console.log(`keys:rotate — active KEK v${ring.active}; ${orgs.length} workspace(s) behind, ${enqueued} job(s) enqueued`)
  } finally {
    await boss.stop({ graceful: true, wait: true })
    await pool.end()
  }
}

// Importable (the test reads `selectOrgsNeedingRotate` out of this module) but runnable: `main` only
// fires when this file IS the process entry point, never when something imports it.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
