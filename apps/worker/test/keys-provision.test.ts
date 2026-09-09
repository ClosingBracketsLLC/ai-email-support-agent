import { randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadKekRing, type KekRing } from '@aesa/crypto'
import { orgDataKeys, withOrg, workspaces } from '@aesa/db'
import { createDb } from '@aesa/db/raw'
import { createTestDatabase, createTestOrganization } from '@aesa/db/testing'
import { runKeysProvision, type KeysProvisionDeps } from '../src/jobs/keys-provision.ts'

const ring: KekRing = loadKekRing({ AESA_KEK_V1: randomBytes(32).toString('base64'), AESA_KEK_ACTIVE: '1' })

describe('keys.provision', () => {
  let t: Awaited<ReturnType<typeof createTestDatabase>>
  let app: ReturnType<typeof createDb>
  let orgId: string
  let deps: KeysProvisionDeps

  beforeAll(async () => {
    t = await createTestDatabase()
    app = createDb(t.url)
    orgId = await createTestOrganization(app)
    await withOrg(app.db, orgId, (tx) => tx.insert(workspaces).values({ orgId, businessName: 'Acme', timezone: 'UTC' }))
    deps = { db: app.db, ring }
  })
  afterAll(async () => {
    await app.pool.end()
    await t.drop()
  })

  it('provisions the org once: a box public key is mirrored onto workspaces and one org_data_keys row exists', async () => {
    await runKeysProvision(deps, { orgId })

    const [ws] = await withOrg(app.db, orgId, (tx) => tx.select({ boxPublicKey: workspaces.boxPublicKey }).from(workspaces).where(eq(workspaces.orgId, orgId)))
    expect(ws?.boxPublicKey).not.toBeNull()
    expect(ws?.boxPublicKey?.length).toBeGreaterThan(0)

    const keyRows = await withOrg(app.db, orgId, (tx) => tx.select().from(orgDataKeys).where(eq(orgDataKeys.orgId, orgId)))
    expect(keyRows).toHaveLength(1)
  })

  it('a second run is an idempotent no-op: the box public key and org_data_keys row are unchanged', async () => {
    const before = await withOrg(app.db, orgId, (tx) => tx.select().from(orgDataKeys).where(eq(orgDataKeys.orgId, orgId)))

    await runKeysProvision(deps, { orgId })

    const after = await withOrg(app.db, orgId, (tx) => tx.select().from(orgDataKeys).where(eq(orgDataKeys.orgId, orgId)))
    expect(after).toHaveLength(1)
    expect(after[0]?.wrappedDek.equals(before[0]!.wrappedDek)).toBe(true)
    expect(after[0]?.version).toBe(before[0]!.version)
  })
})
