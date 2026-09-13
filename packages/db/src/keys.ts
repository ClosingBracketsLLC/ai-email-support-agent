import {
  decrypt, encrypt, generateBoxKeypair, generateDek, openSealed, rewrapDek, unwrapDek, wrapDek, type KekRing,
} from '@aesa/crypto'
import { and, desc, eq } from 'drizzle-orm'
import { orgDataKeys, workspaces } from './schema/index.ts'
import type { OrgTx } from './tenant.ts'

const boxAad = (orgId: string, version: number) => `${orgId}:box:v${version}`

/** Creates key version 1 for the org: DEK wrapped by the active KEK, box keypair with the private key under the DEK. */
export async function provisionOrgKeys(tx: OrgTx, ring: KekRing): Promise<{ version: number; boxPublicKey: Buffer }> {
  const existing = await tx.select({ v: orgDataKeys.version }).from(orgDataKeys).limit(1)
  if (existing.length > 0) throw new Error(`org ${tx.orgId} already provisioned`)
  const version = 1
  const dek = generateDek()
  const { kekVersion, wrapped } = wrapDek(dek, ring, tx.orgId)
  const box = await generateBoxKeypair()
  await tx.insert(orgDataKeys).values({
    orgId: tx.orgId, version, wrappedDek: wrapped, kekVersion,
    boxPublicKey: box.publicKey,
    boxPrivateKeyCiphertext: encrypt(dek, box.privateKey, boxAad(tx.orgId, version)),
  })
  await tx.update(workspaces).set({ boxPublicKey: box.publicKey }).where(eq(workspaces.orgId, tx.orgId))
  return { version, boxPublicKey: box.publicKey }
}

export async function loadOrgDek(tx: OrgTx, ring: KekRing): Promise<{ version: number; dek: Buffer }> {
  const [row] = await tx.select().from(orgDataKeys).orderBy(desc(orgDataKeys.version)).limit(1)
  if (!row) throw new Error(`org ${tx.orgId} has no data key`)
  return { version: row.version, dek: unwrapDek(row.wrappedDek, row.kekVersion, ring, tx.orgId) }
}

export async function getOrgBoxPublicKey(tx: OrgTx): Promise<Buffer> {
  const [ws] = await tx.select({ pk: workspaces.boxPublicKey }).from(workspaces).where(eq(workspaces.orgId, tx.orgId))
  if (!ws?.pk) throw new Error(`org ${tx.orgId} has no box public key`)
  return ws.pk
}

/**
 * Null-returning sibling of `getOrgBoxPublicKey`, for callers that need to tell "not provisioned yet"
 * apart from every other failure (a permission regression, a statement timeout, …) — those must still
 * surface as a real thrown error, not be silently folded into "not provisioned" the way a bare
 * try/catch around `getOrgBoxPublicKey` would (Task 17 review, Important 3). There is no try/catch here
 * at all: the only "not provisioned" case this function recognizes is the query itself succeeding with
 * zero rows or a null column, so anything the query throws propagates unchanged.
 */
export async function getOrgBoxPublicKeyOrNull(tx: OrgTx): Promise<Buffer | null> {
  const [ws] = await tx.select({ pk: workspaces.boxPublicKey }).from(workspaces).where(eq(workspaces.orgId, tx.orgId))
  return ws?.pk ?? null
}

/**
 * Re-wraps the org's CURRENT (max-version) DEK under `ring.active`, guarded on the EXACT
 * `wrapped_dek` bytes and `kek_version` this call read (the `llm.probe` re-wrap's bytes-guard idea,
 * `apps/worker/src/jobs/llm-probe.ts`) — a concurrent re-key that lands between the read and the
 * write leaves a different blob behind, and this call must not clobber it. `opts.beforeWrite` is a
 * test-only seam: it runs after the read and before the guarded UPDATE, so a test can mutate the row
 * through a second connection to force that race deterministically.
 */
export async function rewrapOrgDek(
  tx: OrgTx, ring: KekRing, opts?: { beforeWrite?: () => Promise<void> },
): Promise<{ outcome: 'rewrapped' | 'current' | 'lost_race'; fromVersion: number; toVersion: number }> {
  const [row] = await tx.select().from(orgDataKeys).orderBy(desc(orgDataKeys.version)).limit(1)
  if (!row) throw new Error(`org ${tx.orgId} has no data key`)
  if (row.kekVersion === ring.active) {
    return { outcome: 'current', fromVersion: row.kekVersion, toVersion: row.kekVersion }
  }
  const next = rewrapDek(row.wrappedDek, row.kekVersion, ring, tx.orgId)
  await opts?.beforeWrite?.()
  const updated = await tx
    .update(orgDataKeys)
    .set({ wrappedDek: next.wrapped, kekVersion: next.kekVersion })
    .where(and(
      eq(orgDataKeys.orgId, tx.orgId),
      eq(orgDataKeys.version, row.version),
      eq(orgDataKeys.wrappedDek, row.wrappedDek),
      eq(orgDataKeys.kekVersion, row.kekVersion),
    ))
    .returning({ orgId: orgDataKeys.orgId })
  if (updated.length === 0) return { outcome: 'lost_race', fromVersion: row.kekVersion, toVersion: next.kekVersion }
  return { outcome: 'rewrapped', fromVersion: row.kekVersion, toVersion: next.kekVersion }
}

/** Worker side: open a secret the api sealed to the org's public key. */
export async function openSealedForOrg(tx: OrgTx, ring: KekRing, sealed: Buffer): Promise<Buffer> {
  const [row] = await tx.select().from(orgDataKeys).orderBy(desc(orgDataKeys.version)).limit(1)
  if (!row) throw new Error(`org ${tx.orgId} has no data key`)
  const dek = unwrapDek(row.wrappedDek, row.kekVersion, ring, tx.orgId)
  const privateKey = decrypt(dek, row.boxPrivateKeyCiphertext, boxAad(tx.orgId, row.version))
  return openSealed(sealed, row.boxPublicKey, privateKey)
}
