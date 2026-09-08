import { decrypt, encrypt, generateBoxKeypair, generateDek, openSealed, unwrapDek, wrapDek, type KekRing } from '@aesa/crypto'
import { desc, eq } from 'drizzle-orm'
import { orgDataKeys, workspaces } from './schema/index.ts'
import type { OrgTx } from './tenant.ts'

const boxAad = (orgId: string, version: number) => `${orgId}:box:v${version}`

/** Creates key version 1 for the org: DEK wrapped by the active KEK, box keypair with the private key under the DEK. */
export async function provisionOrgKeys(tx: OrgTx, ring: KekRing): Promise<{ version: number; boxPublicKey: Buffer }> {
  const existing = await tx.select({ v: orgDataKeys.version }).from(orgDataKeys).limit(1)
  if (existing.length > 0) throw new Error(`org ${tx.orgId} already provisioned`)
  const version = 1
  const dek = generateDek()
  const { kekVersion, wrapped } = wrapDek(dek, ring)
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
  return { version: row.version, dek: unwrapDek(row.wrappedDek, row.kekVersion, ring) }
}

export async function getOrgBoxPublicKey(tx: OrgTx): Promise<Buffer> {
  const [ws] = await tx.select({ pk: workspaces.boxPublicKey }).from(workspaces).where(eq(workspaces.orgId, tx.orgId))
  if (!ws?.pk) throw new Error(`org ${tx.orgId} has no box public key`)
  return ws.pk
}

/** Worker side: open a secret the api sealed to the org's public key. */
export async function openSealedForOrg(tx: OrgTx, ring: KekRing, sealed: Buffer): Promise<Buffer> {
  const [row] = await tx.select().from(orgDataKeys).orderBy(desc(orgDataKeys.version)).limit(1)
  if (!row) throw new Error(`org ${tx.orgId} has no data key`)
  const dek = unwrapDek(row.wrappedDek, row.kekVersion, ring)
  const privateKey = decrypt(dek, row.boxPrivateKeyCiphertext, boxAad(tx.orgId, row.version))
  return openSealed(sealed, row.boxPublicKey, privateKey)
}
