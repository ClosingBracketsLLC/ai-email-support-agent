import { randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { decrypt, encrypt, hashToken, loadKekRing, type KekRing } from '@aesa/crypto'
import {
  getOrgBoxPublicKey,
  loadOrgDek,
  mailboxConnections,
  mailboxCredentials,
  provisionOrgKeys,
  user,
  withOrg,
  withPlatform,
  workspaces,
} from '@aesa/db'
import { createDb } from '@aesa/db/raw'
import { createTestDatabase, createTestOrganization } from '@aesa/db/testing'
import { getAccessToken, sealTokens, type GetAccessTokenDeps } from '../src/credentials.ts'
import { ProviderAuthError } from '../src/errors.ts'
import type { TokenSet } from '../src/types.ts'

const ring: KekRing = loadKekRing({ AESA_KEK_V1: randomBytes(32).toString('base64'), AESA_KEK_ACTIVE: '1' })
const JOB_NAME = 'test-job'
const FRESH_MS = 60 * 60 * 1000
const EXPIRED_MS = -1000

describe('credentials: sealed → DEK, lease refresh', () => {
  let t: Awaited<ReturnType<typeof createTestDatabase>>
  let app: ReturnType<typeof createDb>
  let orgId: string
  let userId: string
  let boxPublicKey: Buffer

  beforeAll(async () => {
    t = await createTestDatabase()
    app = createDb(t.url)
    orgId = await createTestOrganization(app)
    await withOrg(app.db, orgId, (tx) => tx.insert(workspaces).values({ orgId, businessName: 'Acme', timezone: 'UTC' }))
    await withOrg(app.db, orgId, (tx) => provisionOrgKeys(tx, ring))
    boxPublicKey = await withOrg(app.db, orgId, (tx) => getOrgBoxPublicKey(tx))
    const [u] = await app.db
      .insert(user)
      .values({ name: 'Owner', email: `owner-${randomBytes(4).toString('hex')}@example.com` })
      .returning()
    userId = u!.id
  })
  afterAll(async () => {
    await app.pool.end()
    await t.drop()
  })

  async function createConnection(): Promise<string> {
    const [conn] = await withOrg(app.db, orgId, (tx) =>
      tx
        .insert(mailboxConnections)
        .values({
          orgId,
          provider: 'gmail',
          providerAccountId: `acct-${randomBytes(4).toString('hex')}`,
          emailAddress: `support-${randomBytes(4).toString('hex')}@acme.com`,
          status: 'connected',
          connectedByUserId: userId,
        })
        .returning(),
    )
    return conn!.id
  }

  async function seedSealedCredential(connectionId: string, tokens: TokenSet): Promise<void> {
    const sealed = await sealTokens(boxPublicKey, tokens)
    await withPlatform(app.db, 'test:seed-sealed', (tx) =>
      tx.insert(mailboxCredentials).values({ connectionId, orgId, refreshTokenCiphertext: sealed, encryption: 'sealed' }),
    )
  }

  async function seedDekCredential(connectionId: string, tokens: TokenSet): Promise<void> {
    const { dek, version } = await withOrg(app.db, orgId, (tx) => loadOrgDek(tx, ring))
    const aad = `${orgId}:mailbox_credentials:${connectionId}`
    await withPlatform(app.db, 'test:seed-dek', (tx) =>
      tx.insert(mailboxCredentials).values({
        connectionId,
        orgId,
        refreshTokenCiphertext: encrypt(dek, Buffer.from(tokens.refreshToken, 'utf8'), aad),
        accessTokenCiphertext: tokens.accessToken !== null ? encrypt(dek, Buffer.from(tokens.accessToken, 'utf8'), aad) : null,
        accessTokenExpiresAt: tokens.accessTokenExpiresAt,
        refreshTokenHash: hashToken('refresh', tokens.refreshToken),
        encryption: 'dek',
        dataKeyVersion: version,
      }),
    )
  }

  async function readCredentialRow(connectionId: string) {
    const [row] = await withPlatform(app.db, 'test:read', (tx) =>
      tx.select().from(mailboxCredentials).where(eq(mailboxCredentials.connectionId, connectionId)),
    )
    return row!
  }

  async function readConnection(connectionId: string) {
    const [row] = await withPlatform(app.db, 'test:read', (tx) =>
      tx.select().from(mailboxConnections).where(eq(mailboxConnections.id, connectionId)),
    )
    return row!
  }

  function baseDeps(overrides: Partial<GetAccessTokenDeps> = {}): GetAccessTokenDeps {
    return {
      db: app.db,
      ring,
      provider: { refresh: vi.fn(async () => { throw new Error('provider.refresh() unexpectedly called') }) },
      clientId: 'client-id',
      clientSecret: 'client-secret',
      ...overrides,
    }
  }

  it('first worker access opens the sealed box, re-wraps under the DEK and records the hash', async () => {
    const connectionId = await createConnection()
    await seedSealedCredential(connectionId, {
      refreshToken: 'seed-refresh-1',
      accessToken: 'seed-access-1',
      accessTokenExpiresAt: new Date(Date.now() + FRESH_MS),
    })

    const refresh = vi.fn(async () => { throw new Error('must not be called: the seeded access token is fresh') })
    const token = await getAccessToken(baseDeps({ provider: { refresh } }), orgId, connectionId, JOB_NAME)

    expect(token).toBe('seed-access-1')
    expect(refresh).not.toHaveBeenCalled()

    const row = await readCredentialRow(connectionId)
    expect(row.encryption).toBe('dek')
    expect(row.refreshTokenHash).toBe(hashToken('refresh', 'seed-refresh-1'))
    expect(row.dataKeyVersion).toBe(1)

    const { dek } = await withOrg(app.db, orgId, (tx) => loadOrgDek(tx, ring))
    const aad = `${orgId}:mailbox_credentials:${connectionId}`
    expect(decrypt(dek, row.refreshTokenCiphertext, aad).toString('utf8')).toBe('seed-refresh-1')
  })

  it('expired access token refreshes under the lease and persists the rotated refresh token', async () => {
    const connectionId = await createConnection()
    await seedSealedCredential(connectionId, {
      refreshToken: 'old-refresh',
      accessToken: 'old-access',
      accessTokenExpiresAt: new Date(Date.now() + EXPIRED_MS),
    })

    const refresh = vi.fn(async (p: { refreshToken: string }) => {
      expect(p.refreshToken).toBe('old-refresh')
      return { refreshToken: 'rotated-refresh', accessToken: 'new-access', accessTokenExpiresAt: new Date(Date.now() + FRESH_MS) } satisfies TokenSet
    })

    const token = await getAccessToken(baseDeps({ provider: { refresh } }), orgId, connectionId, JOB_NAME)

    expect(token).toBe('new-access')
    expect(refresh).toHaveBeenCalledTimes(1)

    const row = await readCredentialRow(connectionId)
    expect(row.refreshTokenHash).toBe(hashToken('refresh', 'rotated-refresh'))
    expect(row.refreshLockUntil).toBeNull()

    const { dek } = await withOrg(app.db, orgId, (tx) => loadOrgDek(tx, ring))
    const aad = `${orgId}:mailbox_credentials:${connectionId}`
    expect(decrypt(dek, row.refreshTokenCiphertext, aad).toString('utf8')).toBe('rotated-refresh')
    expect(decrypt(dek, row.accessTokenCiphertext!, aad).toString('utf8')).toBe('new-access')
  })

  it("a held lease makes the second caller wait and reuse the winner's token", async () => {
    const connectionId = await createConnection()
    await seedDekCredential(connectionId, {
      refreshToken: 'shared-refresh',
      accessToken: 'stale-access',
      accessTokenExpiresAt: new Date(Date.now() + EXPIRED_MS),
    })
    // Simulate another worker already holding the lease.
    await withPlatform(app.db, 'test:hold-lease', (tx) =>
      tx.update(mailboxCredentials).set({ refreshLockUntil: new Date(Date.now() + 60_000) }).where(eq(mailboxCredentials.connectionId, connectionId)),
    )

    const refresh = vi.fn(async () => { throw new Error('must not be called: the lease is held by another worker') })
    const sleep = vi.fn(async () => {
      // Model the winner finishing its own refresh cycle during our wait.
      const { dek } = await withOrg(app.db, orgId, (tx) => loadOrgDek(tx, ring))
      const aad = `${orgId}:mailbox_credentials:${connectionId}`
      await withPlatform(app.db, 'test:winner-persists', (tx) =>
        tx
          .update(mailboxCredentials)
          .set({
            accessTokenCiphertext: encrypt(dek, Buffer.from('winner-access', 'utf8'), aad),
            accessTokenExpiresAt: new Date(Date.now() + FRESH_MS),
            refreshLockUntil: null,
          })
          .where(eq(mailboxCredentials.connectionId, connectionId)),
      )
    })

    const token = await getAccessToken(baseDeps({ provider: { refresh }, sleep }), orgId, connectionId, JOB_NAME)

    expect(token).toBe('winner-access')
    expect(refresh).not.toHaveBeenCalled()
    expect(sleep).toHaveBeenCalledTimes(1)
  })

  it('a held lease that never clears throws so the job can retry', async () => {
    const connectionId = await createConnection()
    await seedDekCredential(connectionId, {
      refreshToken: 'shared-refresh',
      accessToken: 'stale-access',
      accessTokenExpiresAt: new Date(Date.now() + EXPIRED_MS),
    })
    await withPlatform(app.db, 'test:hold-lease', (tx) =>
      tx.update(mailboxCredentials).set({ refreshLockUntil: new Date(Date.now() + 60_000) }).where(eq(mailboxCredentials.connectionId, connectionId)),
    )

    const refresh = vi.fn(async () => { throw new Error('must not be called: the lease is held by another worker') })
    const sleep = vi.fn(async () => {}) // the other worker never finishes within our one re-read

    await expect(getAccessToken(baseDeps({ provider: { refresh }, sleep }), orgId, connectionId, JOB_NAME)).rejects.toThrow(/in progress/)
    expect(refresh).not.toHaveBeenCalled()
  })

  it('auth failure with the current hash flips the connection to reauth_required', async () => {
    const connectionId = await createConnection()
    await seedDekCredential(connectionId, {
      refreshToken: 'doomed-refresh',
      accessToken: 'stale-access',
      accessTokenExpiresAt: new Date(Date.now() + EXPIRED_MS),
    })

    const refresh = vi.fn(async () => { throw new ProviderAuthError() })

    await expect(getAccessToken(baseDeps({ provider: { refresh } }), orgId, connectionId, JOB_NAME)).rejects.toBeInstanceOf(ProviderAuthError)

    const connection = await readConnection(connectionId)
    expect(connection.status).toBe('reauth_required')

    const row = await readCredentialRow(connectionId)
    expect(row.refreshLockUntil).toBeNull()
  })

  it('auth failure with a stale hash (concurrent rotation) does NOT flip the connection', async () => {
    const connectionId = await createConnection()
    await seedDekCredential(connectionId, {
      refreshToken: 'stale-refresh',
      accessToken: 'old-access',
      accessTokenExpiresAt: new Date(Date.now() + EXPIRED_MS),
    })

    const refresh = vi.fn(async () => {
      // Model another worker completing a full rotation cycle while our network call was in flight.
      const { dek } = await withOrg(app.db, orgId, (tx) => loadOrgDek(tx, ring))
      const aad = `${orgId}:mailbox_credentials:${connectionId}`
      await withPlatform(app.db, 'test:concurrent-rotation', (tx) =>
        tx
          .update(mailboxCredentials)
          .set({
            refreshTokenCiphertext: encrypt(dek, Buffer.from('rotated-elsewhere', 'utf8'), aad),
            accessTokenCiphertext: encrypt(dek, Buffer.from('rotated-access', 'utf8'), aad),
            accessTokenExpiresAt: new Date(Date.now() + FRESH_MS),
            refreshTokenHash: hashToken('refresh', 'rotated-elsewhere'),
            refreshLockUntil: null,
          })
          .where(eq(mailboxCredentials.connectionId, connectionId)),
      )
      throw new ProviderAuthError()
    })

    const token = await getAccessToken(baseDeps({ provider: { refresh } }), orgId, connectionId, JOB_NAME)

    expect(token).toBe('rotated-access')
    expect(refresh).toHaveBeenCalledTimes(1)

    const connection = await readConnection(connectionId)
    expect(connection.status).toBe('connected')

    const row = await readCredentialRow(connectionId)
    expect(row.refreshTokenHash).toBe(hashToken('refresh', 'rotated-elsewhere'))
  })

  it('a non-auth refresh failure clears the lease and rethrows without flipping the connection', async () => {
    const connectionId = await createConnection()
    await seedDekCredential(connectionId, {
      refreshToken: 'transient-refresh',
      accessToken: 'stale-access',
      accessTokenExpiresAt: new Date(Date.now() + EXPIRED_MS),
    })

    const refresh = vi.fn(async () => { throw new Error('network blip') })

    await expect(getAccessToken(baseDeps({ provider: { refresh } }), orgId, connectionId, JOB_NAME)).rejects.toThrow('network blip')

    const connection = await readConnection(connectionId)
    expect(connection.status).toBe('connected')

    const row = await readCredentialRow(connectionId)
    expect(row.refreshLockUntil).toBeNull()
  })

  it("post-lease re-read: a worker that completes a full cycle between B's read and B's claim leaves B returning its fresh token without calling refresh", async () => {
    const connectionId = await createConnection()
    await seedDekCredential(connectionId, {
      refreshToken: 'pre-lease-refresh',
      accessToken: 'pre-lease-access',
      accessTokenExpiresAt: new Date(Date.now() + EXPIRED_MS), // stale, so B's initial (pre-lease) check does not short-circuit
    })

    const refresh = vi.fn(async () => { throw new Error('must not be called: the claimed row is already fresh') })
    const beforeLeaseClaim = vi.fn(async () => {
      // Model worker A completing a full refresh cycle in the gap between B's initial read and B's
      // own lease-claim attempt: A's write lands here, including clearing the lock A held.
      const { dek } = await withOrg(app.db, orgId, (tx) => loadOrgDek(tx, ring))
      const aad = `${orgId}:mailbox_credentials:${connectionId}`
      await withPlatform(app.db, 'test:concurrent-full-cycle', (tx) =>
        tx
          .update(mailboxCredentials)
          .set({
            refreshTokenCiphertext: encrypt(dek, Buffer.from('a-rotated-refresh', 'utf8'), aad),
            accessTokenCiphertext: encrypt(dek, Buffer.from('a-fresh-access', 'utf8'), aad),
            accessTokenExpiresAt: new Date(Date.now() + FRESH_MS),
            refreshTokenHash: hashToken('refresh', 'a-rotated-refresh'),
            refreshLockUntil: null,
          })
          .where(eq(mailboxCredentials.connectionId, connectionId)),
      )
    })

    const token = await getAccessToken(baseDeps({ provider: { refresh }, beforeLeaseClaim }), orgId, connectionId, JOB_NAME)

    expect(token).toBe('a-fresh-access')
    expect(refresh).not.toHaveBeenCalled()
    expect(beforeLeaseClaim).toHaveBeenCalledTimes(1)

    // B still won the (unneeded) lease claim, since A's lock was already clear — B must release it.
    const row = await readCredentialRow(connectionId)
    expect(row.refreshLockUntil).toBeNull()
    expect(row.refreshTokenHash).toBe(hashToken('refresh', 'a-rotated-refresh')) // A's write, untouched by B
  })

  it('persist fence: a stale holder that still succeeds after someone else rotated first does not clobber the winner', async () => {
    const connectionId = await createConnection()
    await seedDekCredential(connectionId, {
      refreshToken: 'fence-refresh',
      accessToken: 'fence-stale-access',
      accessTokenExpiresAt: new Date(Date.now() + EXPIRED_MS),
    })

    const refresh = vi.fn(async (p: { refreshToken: string }) => {
      expect(p.refreshToken).toBe('fence-refresh')
      // Model another worker (C) independently completing its own rotation of the SAME pre-refresh
      // token while this call is "in flight" (e.g. this call ran past its own lease's 60s window).
      const { dek } = await withOrg(app.db, orgId, (tx) => loadOrgDek(tx, ring))
      const aad = `${orgId}:mailbox_credentials:${connectionId}`
      await withPlatform(app.db, 'test:fence-race', (tx) =>
        tx
          .update(mailboxCredentials)
          .set({
            refreshTokenCiphertext: encrypt(dek, Buffer.from('winner-refresh', 'utf8'), aad),
            accessTokenCiphertext: encrypt(dek, Buffer.from('winner-access', 'utf8'), aad),
            accessTokenExpiresAt: new Date(Date.now() + FRESH_MS),
            refreshTokenHash: hashToken('refresh', 'winner-refresh'),
            refreshLockUntil: null,
          })
          .where(eq(mailboxCredentials.connectionId, connectionId)),
      )
      // This call still "succeeds" from the provider's point of view — it just loses the persist race.
      return { refreshToken: 'b-own-refresh', accessToken: 'b-own-access', accessTokenExpiresAt: new Date(Date.now() + FRESH_MS) } satisfies TokenSet
    })

    const token = await getAccessToken(baseDeps({ provider: { refresh } }), orgId, connectionId, JOB_NAME)

    expect(token).toBe('winner-access') // NOT b-own-access
    expect(refresh).toHaveBeenCalledTimes(1)

    const row = await readCredentialRow(connectionId)
    expect(row.refreshTokenHash).toBe(hashToken('refresh', 'winner-refresh')) // the stale holder's persist was a no-op
  })

  it('an empty returned refresh token is refused rather than persisted, and the lease is released', async () => {
    const connectionId = await createConnection()
    await seedDekCredential(connectionId, {
      refreshToken: 'guarded-refresh',
      accessToken: 'guarded-stale-access',
      accessTokenExpiresAt: new Date(Date.now() + EXPIRED_MS),
    })

    const refresh = vi.fn(async () => ({ refreshToken: '', accessToken: 'new-access', accessTokenExpiresAt: new Date(Date.now() + FRESH_MS) }) satisfies TokenSet)

    await expect(getAccessToken(baseDeps({ provider: { refresh } }), orgId, connectionId, JOB_NAME)).rejects.toThrow(/empty refresh token/)

    const row = await readCredentialRow(connectionId)
    expect(row.refreshLockUntil).toBeNull()
    const { dek } = await withOrg(app.db, orgId, (tx) => loadOrgDek(tx, ring))
    const aad = `${orgId}:mailbox_credentials:${connectionId}`
    expect(decrypt(dek, row.refreshTokenCiphertext, aad).toString('utf8')).toBe('guarded-refresh') // untouched
  })

  it('caps the stale-hash retry at one: a second consecutive stale-hash failure rethrows without flipping status', async () => {
    const connectionId = await createConnection()
    await seedDekCredential(connectionId, {
      refreshToken: 'r0',
      accessToken: null,
      accessTokenExpiresAt: null,
    })

    let call = 0
    const refresh = vi.fn(async () => {
      call += 1
      // Every attempt rotates the hash out from under itself and fails — every attempt is "stale"
      // from its own point of view, so the retry cap (not the current-hash branch) is what stops this.
      const { dek } = await withOrg(app.db, orgId, (tx) => loadOrgDek(tx, ring))
      const aad = `${orgId}:mailbox_credentials:${connectionId}`
      await withPlatform(app.db, `test:rotate-${call}`, (tx) =>
        tx
          .update(mailboxCredentials)
          .set({
            refreshTokenCiphertext: encrypt(dek, Buffer.from(`r${call}`, 'utf8'), aad),
            refreshTokenHash: hashToken('refresh', `r${call}`),
            refreshLockUntil: null,
            accessTokenCiphertext: null,
            accessTokenExpiresAt: null,
          })
          .where(eq(mailboxCredentials.connectionId, connectionId)),
      )
      throw new ProviderAuthError()
    })

    await expect(getAccessToken(baseDeps({ provider: { refresh } }), orgId, connectionId, JOB_NAME)).rejects.toBeInstanceOf(ProviderAuthError)

    expect(refresh).toHaveBeenCalledTimes(2) // one attempt + one retry, then give up

    const connection = await readConnection(connectionId)
    expect(connection.status).toBe('connected') // never flipped: both failures were judged stale, not current
  })
})
