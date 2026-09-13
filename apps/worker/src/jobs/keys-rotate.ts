/**
 * `keys.rotate` (spec §Security) — re-wraps ONE org's data-encryption key under the ring's ACTIVE
 * KEK. The DEK itself never changes, so nothing encrypted under it has to be re-encrypted: a mailbox
 * refresh token, a BYOK provider key and an org's sealed-box private key all keep opening exactly as
 * before. What changes is which KEK the wrapping is under, which is what makes retiring a leaked or
 * aged KEK possible at all.
 *
 * `rewrapOrgDek` (`@aesa/db`) owns the guarded write: it re-reads the org's newest key row, refuses
 * when it is already on the active KEK (`current`), and guards its UPDATE on the EXACT `wrapped_dek`
 * bytes and `kek_version` it read. A concurrent re-key that lands in between leaves different bytes
 * behind, this call matches nothing, and the outcome is `lost_race` — which is a fact to log, not an
 * error: the enqueue script re-selects that org on its next pass.
 *
 * A ring that cannot UNWRAP the version the row carries throws, and the row is untouched. That is
 * deliberate: it is exactly the "same ring on every replica" failure CLAUDE.md warns about, and a
 * rotate that swallowed it would report success while the org's data was one KEK away from being
 * unreadable. The enqueue script (`apps/worker/scripts/keys-rotate.ts`) is where an operator meets
 * it, one failed job per affected org.
 */
import type PgBoss from 'pg-boss'
import type pino from 'pino'
import { z } from 'zod'
import type { KekRing } from '@aesa/crypto'
import { audit, rewrapOrgDek, withOrg, type AuditActor, type Db } from '@aesa/db'
import { defineJob, JOB_NAMES, registerJob, type RegisteredJobDefinition } from '@aesa/queue'

export const KeysRotatePayload = z.object({ orgId: z.string() })
export type KeysRotatePayload = z.infer<typeof KeysRotatePayload>

const ROTATE_ACTOR: AuditActor = 'system:job:keys.rotate'

/** The importable definition: `scripts/keys-rotate.ts` `enqueue()`s against this (it only ever reads
 *  `.name`/`.schema`). `registerKeysRotate` builds the deps-bound definition and registers THAT. */
export const keysRotateJob: RegisteredJobDefinition<KeysRotatePayload> = defineJob({
  name: JOB_NAMES.keysRotate,
  schema: KeysRotatePayload,
  handler: async () => {
    throw new Error('keys.rotate: this definition has no bound deps — register it through registerKeysRotate(boss, deps)')
  },
})

export interface KeysRotateDeps {
  db: Db
  ring: KekRing
  logger: pino.Logger
}

export async function runKeysRotate(deps: KeysRotateDeps, payload: KeysRotatePayload): Promise<'rewrapped' | 'current' | 'lost_race'> {
  const outcome = await withOrg(deps.db, payload.orgId, async (tx) => {
    const result = await rewrapOrgDek(tx, deps.ring)
    if (result.outcome === 'rewrapped') {
      // Inside the SAME transaction as the re-wrap: an audit row claiming a rotate that rolled back
      // would be worse than no row, and this is the only record that the KEK behind an org changed.
      await audit(tx, {
        actor: ROTATE_ACTOR, action: 'keys.rotated', entityType: 'workspace', entityId: payload.orgId,
        detail: { from: result.fromVersion, to: result.toVersion },
      })
    }
    return result
  })

  if (outcome.outcome === 'lost_race') {
    deps.logger.warn(
      { orgId: payload.orgId, from: outcome.fromVersion, to: outcome.toVersion },
      'keys_rotate_lost_race',
    )
  }
  return outcome.outcome
}

export async function registerKeysRotate(boss: PgBoss, deps: KeysRotateDeps): Promise<void> {
  const wired: RegisteredJobDefinition<KeysRotatePayload> = {
    ...keysRotateJob,
    handler: async (ctx) => {
      await runKeysRotate(deps, ctx.data)
    },
  }
  await registerJob(boss, wired)
}
