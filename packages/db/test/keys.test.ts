import { randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadKekRing, sealTo, decrypt, encrypt } from '@aesa/crypto'
import { orgDataKeys, withOrg, workspaces } from '../src/index.ts'
import { getOrgBoxPublicKey, getOrgBoxPublicKeyOrNull, loadOrgDek, openSealedForOrg, provisionOrgKeys } from '../src/keys.ts'
import { createDb } from '../src/raw.ts'
import { createTestDatabase, createTestOrganization } from './helpers/test-db.ts'

const ring = loadKekRing({ AESA_KEK_V1: randomBytes(32).toString('base64'), AESA_KEK_ACTIVE: '1' })

describe('org keys', () => {
  let t: Awaited<ReturnType<typeof createTestDatabase>>
  let app: ReturnType<typeof createDb>
  let orgId: string
  beforeAll(async () => {
    t = await createTestDatabase(); app = createDb(t.url)
    orgId = await createTestOrganization(app)
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

  describe('getOrgBoxPublicKeyOrNull', () => {
    it('returns null before provisioning, the public key after — never throws for the "not yet" case', async () => {
      const freshOrgId = await createTestOrganization(app)
      await withOrg(app.db, freshOrgId, (tx) => tx.insert(workspaces).values({ orgId: freshOrgId, businessName: 'Fresh', timezone: 'UTC' }))

      const before = await withOrg(app.db, freshOrgId, (tx) => getOrgBoxPublicKeyOrNull(tx))
      expect(before).toBeNull()

      const { boxPublicKey } = await withOrg(app.db, freshOrgId, (tx) => provisionOrgKeys(tx, ring))
      const after = await withOrg(app.db, freshOrgId, (tx) => getOrgBoxPublicKeyOrNull(tx))
      expect(after?.equals(boxPublicKey)).toBe(true)
    })

    it('rethrows a real query failure instead of masking it as "not provisioned"', async () => {
      const orgX = await createTestOrganization(app)
      await withOrg(app.db, orgX, (tx) => tx.insert(workspaces).values({ orgId: orgX, businessName: 'X', timezone: 'UTC' }))

      // A real superuser connection (bypasses RLS and owns the privilege grants) — same shape as
      // mail-schema.test.ts's `admin` pool — used only to force a genuine permission error, distinct
      // from the "zero rows" case getOrgBoxPublicKeyOrNull treats as "not provisioned".
      const admin = new pg.Pool({ connectionString: t.url })
      try {
        await admin.query('REVOKE SELECT ON workspaces FROM aesa_app')
        await expect(withOrg(app.db, orgX, (tx) => getOrgBoxPublicKeyOrNull(tx))).rejects.toMatchObject({
          cause: expect.objectContaining({ code: '42501' }),
        })
      } finally {
        await admin.query('GRANT SELECT ON workspaces TO aesa_app')
        await admin.end()
      }
    })
  })
})
