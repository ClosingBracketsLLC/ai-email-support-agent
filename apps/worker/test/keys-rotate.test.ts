/**
 * `keys.rotate` against real Postgres. The job re-wraps one org's DEK under a NEW KEK — so what this
 * file has to prove is that the data encrypted under that DEK is still readable afterwards. Two
 * ciphertexts stand in for every secret the platform holds: a mailbox credential (`@aesa/mail`'s
 * AAD) and a BYOK provider key (`provider-resolver.ts`'s AAD), both written under the OLD ring and
 * both opened again through the NEW one.
 */
import { randomBytes } from 'node:crypto'
import { desc, eq } from 'drizzle-orm'
import pino from 'pino'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { decrypt, encrypt, loadKekRing, type KekRing } from '@aesa/crypto'
import {
  auditLog, llmCredentials, llmCredentialSecrets, loadOrgDek, mailboxConnections, mailboxCredentials,
  orgDataKeys, provisionOrgKeys, user, withOrg, withPlatform, workspaces,
} from '@aesa/db'
import { createDb } from '@aesa/db/raw'
import { createTestDatabase, createTestOrganization } from '@aesa/db/testing'
import { runKeysRotate, type KeysRotateDeps } from '../src/jobs/keys-rotate.ts'
import { selectOrgsNeedingRotate } from '../scripts/keys-rotate.ts'

const rand = () => randomBytes(4).toString('hex')
const KEK_1 = randomBytes(32).toString('base64')
const KEK_2 = randomBytes(32).toString('base64')
const ring1: KekRing = loadKekRing({ AESA_KEK_V1: KEK_1, AESA_KEK_ACTIVE: '1' })
const ring2: KekRing = loadKekRing({ AESA_KEK_V1: KEK_1, AESA_KEK_V2: KEK_2, AESA_KEK_ACTIVE: '2' })
/** A replica that holds only v2 cannot UNWRAP a DEK still wrapped under v1 — the CLAUDE.md warning
 *  ("the SAME ring on every replica") made into a test. */
const ringWithoutV1: KekRing = loadKekRing({ AESA_KEK_V2: KEK_2, AESA_KEK_ACTIVE: '2' })

const MAILBOX_SECRET = 'refresh-token-value'
const PROVIDER_SECRET = JSON.stringify({ apiKey: 'sk-byok-secret' })

describe('keys.rotate', () => {
  let t: Awaited<ReturnType<typeof createTestDatabase>>
  let app: ReturnType<typeof createDb>
  let userId: string

  beforeAll(async () => {
    t = await createTestDatabase()
    app = createDb(t.url)
    const [u] = await app.db.insert(user).values({ name: 'Owner', email: `owner-${rand()}@example.com` }).returning()
    userId = u!.id
  })
  afterAll(async () => {
    await app.pool.end()
    await t.drop()
  })

  const deps = (ring: KekRing): KeysRotateDeps => ({ db: app.db, ring, logger: pino({ level: 'silent' }) })

  /** An org provisioned under `ring1`, with two secrets sealed under its DEK. */
  async function seedOrg(): Promise<{ orgId: string; connectionId: string; credentialId: string }> {
    const orgId = await createTestOrganization(app)
    await withOrg(app.db, orgId, (tx) => tx.insert(workspaces).values({ orgId, businessName: 'Acme', timezone: 'UTC' }))
    await withOrg(app.db, orgId, (tx) => provisionOrgKeys(tx, ring1))

    const { connectionId, credentialId } = await withOrg(app.db, orgId, async (tx) => {
      const [conn] = await tx.insert(mailboxConnections).values({
        orgId, provider: 'gmail', providerAccountId: `acct-${rand()}`, emailAddress: `s-${rand()}@acme.test`,
        status: 'connected', connectedByUserId: userId,
      }).returning({ id: mailboxConnections.id })
      const [cred] = await tx.insert(llmCredentials).values({
        orgId, provider: 'openai', label: 'Prod key', keyFingerprint: 'abcd1234…7890', createdBy: `user:${userId}`,
      }).returning({ id: llmCredentials.id })
      return { connectionId: conn!.id, credentialId: cred!.id }
    })

    const dek = await withOrg(app.db, orgId, async (tx) => (await loadOrgDek(tx, ring1)).dek)
    await withPlatform(app.db, 'test:seed-secrets', async (tx) => {
      await tx.insert(mailboxCredentials).values({
        connectionId, orgId, encryption: 'dek', dataKeyVersion: 1,
        refreshTokenCiphertext: encrypt(dek, Buffer.from(MAILBOX_SECRET, 'utf8'), `${orgId}:mailbox_credentials:${connectionId}`),
      })
      await tx.insert(llmCredentialSecrets).values({
        credentialId, orgId, encryption: 'dek', dataKeyVersion: 1,
        keyCiphertext: encrypt(dek, Buffer.from(PROVIDER_SECRET, 'utf8'), `${orgId}:llm_credential_secrets:${credentialId}`),
      })
    })

    return { orgId, connectionId, credentialId }
  }

  const readKeyRow = (orgId: string) =>
    withOrg(app.db, orgId, async (tx) =>
      (await tx.select().from(orgDataKeys).where(eq(orgDataKeys.orgId, orgId)).orderBy(desc(orgDataKeys.version)))[0]!)

  it('provisions at kek_version 1 under a v1-only ring (the state a rotate starts from)', async () => {
    const { orgId } = await seedOrg()
    const row = await readKeyRow(orgId)
    expect(row.version).toBe(1)
    expect(row.kekVersion).toBe(1)
  })

  it('re-wraps under the active KEK and leaves every secret written before the rotate readable', async () => {
    const { orgId, connectionId, credentialId } = await seedOrg()
    const before = await readKeyRow(orgId)

    expect(await runKeysRotate(deps(ring2), { orgId })).toBe('rewrapped')

    const after = await readKeyRow(orgId)
    expect(after.kekVersion).toBe(2)
    expect(after.version).toBe(before.version)                       // a re-wrap, not a new key version
    expect(after.wrappedDek.equals(before.wrappedDek)).toBe(false)   // the blob really changed

    // The point of the whole job: the DEK is the same key, so both ciphertexts still open.
    const dek = await withOrg(app.db, orgId, async (tx) => (await loadOrgDek(tx, ring2)).dek)
    const secrets = await withPlatform(app.db, 'test:read-secrets', async (tx) => {
      const [mb] = await tx.select().from(mailboxCredentials).where(eq(mailboxCredentials.connectionId, connectionId))
      const [llm] = await tx.select().from(llmCredentialSecrets).where(eq(llmCredentialSecrets.credentialId, credentialId))
      return { mb: mb!, llm: llm! }
    })
    expect(decrypt(dek, secrets.mb.refreshTokenCiphertext, `${orgId}:mailbox_credentials:${connectionId}`).toString('utf8')).toBe(MAILBOX_SECRET)
    expect(decrypt(dek, secrets.llm.keyCiphertext, `${orgId}:llm_credential_secrets:${credentialId}`).toString('utf8')).toBe(PROVIDER_SECRET)

    // One audit row, naming both versions.
    const audits = await withOrg(app.db, orgId, (tx) =>
      tx.select({ action: auditLog.action, detail: auditLog.detail }).from(auditLog).where(eq(auditLog.action, 'keys.rotated')))
    expect(audits).toEqual([{ action: 'keys.rotated', detail: { from: 1, to: 2 } }])

    // A second rotate under the same ring is a no-op and writes no second audit row.
    expect(await runKeysRotate(deps(ring2), { orgId })).toBe('current')
    const audits2 = await withOrg(app.db, orgId, (tx) =>
      tx.select({ action: auditLog.action }).from(auditLog).where(eq(auditLog.action, 'keys.rotated')))
    expect(audits2).toHaveLength(1)
  })

  it('throws — and leaves the row untouched — when the ring cannot unwrap the version the row carries', async () => {
    const { orgId } = await seedOrg()
    const before = await readKeyRow(orgId)

    await expect(runKeysRotate(deps(ringWithoutV1), { orgId })).rejects.toThrow(/KEK version 1 is not configured/)

    const after = await readKeyRow(orgId)
    expect(after.kekVersion).toBe(1)
    expect(after.wrappedDek.equals(before.wrappedDek)).toBe(true)
  })

  it('selectOrgsNeedingRotate returns exactly the orgs whose CURRENT key version is not on the active KEK', async () => {
    const stale = await seedOrg()
    const rotated = await seedOrg()
    await runKeysRotate(deps(ring2), { orgId: rotated.orgId })

    const needing = await selectOrgsNeedingRotate(app.db, ring2)
    const ids = needing.map((r) => r.orgId)
    expect(ids).toContain(stale.orgId)
    expect(ids).not.toContain(rotated.orgId)
    expect(needing.find((r) => r.orgId === stale.orgId)?.kekVersion).toBe(1)

    // Under the ORIGINAL ring nothing is stale except the org this test just rotated forward.
    const needingV1 = (await selectOrgsNeedingRotate(app.db, ring1)).map((r) => r.orgId)
    expect(needingV1).toContain(rotated.orgId)
    expect(needingV1).not.toContain(stale.orgId)
  })
})
