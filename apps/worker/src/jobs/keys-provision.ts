/**
 * The `keys.provision` job (Phase 2 slice — deviation 11 of the phase's plan). A brand-new org has no
 * `org_data_keys` row yet — no DEK, no box keypair — so `mailboxes.startConnect` (Task 17) enqueues this
 * job idempotently (debounced) before it can seal a token set to an org box key that does not exist yet.
 * Idempotency is via `getOrgBoxPublicKey`: it throws when the org has no key yet, which this job treats
 * as "not provisioned" and falls through to `provisionOrgKeys`; any other org already has a mirrored
 * `workspaces.box_public_key` and this job is a clean no-op.
 */
import type PgBoss from 'pg-boss'
import { z } from 'zod'
import type { KekRing } from '@aesa/crypto'
import { getOrgBoxPublicKey, provisionOrgKeys, withOrg, type Db } from '@aesa/db'
import { defineJob, registerJob, JOB_NAMES, type JobDefinition } from '@aesa/queue'

export const KeysProvisionPayload = z.object({ orgId: z.string() })
export type KeysProvisionPayload = z.infer<typeof KeysProvisionPayload>

/**
 * The importable definition: `mailboxes.startConnect` (Task 17) `enqueue()`s against this — which only
 * ever reads `.name`/`.schema` — never against a handler bound to no deps. `registerKeysProvision` below
 * builds the real, deps-bound definition and registers THAT.
 */
export const keysProvisionJob: JobDefinition<KeysProvisionPayload> = defineJob({
  name: JOB_NAMES.keysProvision,
  schema: KeysProvisionPayload,
  queue: { expireInSeconds: 60, retryLimit: 3, retryBackoff: true },
  handler: async () => {
    throw new Error('keys.provision: this definition has no bound deps — register it through registerKeysProvision(boss, deps)')
  },
})

export interface KeysProvisionDeps {
  db: Db
  ring: KekRing
}

export async function runKeysProvision(deps: KeysProvisionDeps, payload: KeysProvisionPayload): Promise<void> {
  await withOrg(deps.db, payload.orgId, async (tx) => {
    try {
      await getOrgBoxPublicKey(tx)
      return // already provisioned — idempotent no-op
    } catch {
      // No box public key yet (or no workspace row at all) — getOrgBoxPublicKey throws either way,
      // and both cases mean this org still needs its DEK + box keypair.
    }
    await provisionOrgKeys(tx, deps.ring)
  })
}

export async function registerKeysProvision(boss: PgBoss, deps: KeysProvisionDeps): Promise<void> {
  const wired: JobDefinition<KeysProvisionPayload> = {
    ...keysProvisionJob,
    handler: async (ctx) => {
      await runKeysProvision(deps, ctx.data)
    },
  }
  await registerJob(boss, wired)
}
