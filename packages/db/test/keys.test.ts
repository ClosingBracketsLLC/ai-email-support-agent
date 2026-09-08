import { randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadKekRing, sealTo, decrypt, encrypt } from '@aesa/crypto'
import { orgDataKeys, withOrg, workspaces } from '../src/index.ts'
import { getOrgBoxPublicKey, loadOrgDek, openSealedForOrg, provisionOrgKeys } from '../src/keys.ts'
import { createDb } from '../src/raw.ts'
import { createTestDatabase } from './helpers/test-db.ts'

const ring = loadKekRing({ AESA_KEK_V1: randomBytes(32).toString('base64'), AESA_KEK_ACTIVE: '1' })

describe('org keys', () => {
  let t: Awaited<ReturnType<typeof createTestDatabase>>
  let app: ReturnType<typeof createDb>
  const orgId = crypto.randomUUID()
  beforeAll(async () => {
    t = await createTestDatabase(); app = createDb(t.url)
    await withOrg(app.db, orgId, (tx) => tx.insert(workspaces).values({ orgId, businessName: 'A', timezone: 'UTC' }))
  })
  afterAll(async () => { await app.pool.end(); await t.drop() })

  it('provisions a wrapped DEK and a box keypair, publishing only the public key on the workspace', async () => {
    const { version, boxPublicKey } = await withOrg(app.db, orgId, (tx) => provisionOrgKeys(tx, ring))
    expect(version).toBe(1)
    const [ws] = await withOrg(app.db, orgId, (tx) => tx.select().from(workspaces).where(eq(workspaces.orgId, orgId)))
    expect(ws!.boxPublicKey!.equals(boxPublicKey)).toBe(true)
    const [row] = await withOrg(app.db, orgId, (tx) => tx.select().from(orgDataKeys))
    expect(row!.kekVersion).toBe(1)
    expect(row!.wrappedDek.length).toBeGreaterThan(32)
  })

  it('api-side seal → worker-side open → re-encrypt under the DEK', async () => {
    const pub = await withOrg(app.db, orgId, (tx) => getOrgBoxPublicKey(tx))     // what the api may read
    const sealed = await sealTo(pub, Buffer.from('provider-refresh-token'))
    const { plaintext, dek } = await withOrg(app.db, orgId, async (tx) => ({
      plaintext: await openSealedForOrg(tx, ring, sealed),
      dek: (await loadOrgDek(tx, ring)).dek,
    }))
    expect(plaintext.toString()).toBe('provider-refresh-token')
    const stored = encrypt(dek, plaintext, `${orgId}:cred-1`)
    expect(decrypt(dek, stored, `${orgId}:cred-1`).toString()).toBe('provider-refresh-token')
  })

  it('refuses to provision twice for the same version', async () => {
    await expect(withOrg(app.db, orgId, (tx) => provisionOrgKeys(tx, ring))).rejects.toThrow(/already provisioned/)
  })
})
