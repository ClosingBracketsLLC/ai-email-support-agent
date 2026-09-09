import { randomBytes } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import type { Logger } from 'pino'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { encrypt, hashToken, loadKekRing, type KekRing } from '@aesa/crypto'
import {
  auditLog, getOrgBoxPublicKey, loadOrgDek, mailboxConnections, mailboxCredentials, provisionOrgKeys, user, withOrg,
  withPlatform, workspaces,
} from '@aesa/db'
import { createDb } from '@aesa/db/raw'
import { createTestDatabase, createTestOrganization } from '@aesa/db/testing'
import { createMockMailbox, sealTokens, type MailboxClient, type MailboxProvider } from '@aesa/mail'
import type { WorkerConfig } from '../src/config.ts'
import { runRevokeMailbox, runStoreCredentials, type RevokeMailboxDeps, type StoreCredentialsDeps } from '../src/jobs/mailbox-credentials.ts'

const ring: KekRing = loadKekRing({ AESA_KEK_V1: randomBytes(32).toString('base64'), AESA_KEK_ACTIVE: '1' })
const rand = () => randomBytes(4).toString('hex')

function baseConfig(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    env: 'test', databaseUrl: 'unused', roles: new Set(['sync']), kekRing: null, logLevel: 'silent', anthropicApiKey: null,
    gmailOauth: { clientId: 'gmail-client', clientSecret: { expose: () => 'gmail-secret' } as never },
    msOauth: null, gmailPubsubTopic: null, webhookPublicUrl: null, platformSender: 'no-reply@aesa.test',
    ...overrides,
  }
}

const silentLogger = { warn: () => {}, info: () => {} } as unknown as Logger

describe('mailbox_credentials jobs', () => {
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
    const [u] = await app.db.insert(user).values({ name: 'Owner', email: `owner-${rand()}@example.com` }).returning()
    userId = u!.id
  })
  afterAll(async () => {
    await app.pool.end()
    await t.drop()
  })

  async function createConnection(overrides: Partial<typeof mailboxConnections.$inferInsert> = {}): Promise<string> {
    const [conn] = await withOrg(app.db, orgId, (tx) =>
      tx
        .insert(mailboxConnections)
        .values({
          orgId, provider: 'gmail', providerAccountId: `acct-${rand()}`, emailAddress: `support-${rand()}@acme.test`,
          status: 'connected', connectedByUserId: userId, ...overrides,
        })
        .returning(),
    )
    return conn!.id
  }

  async function readCredentialRow(connectionId: string) {
    const rows = await withPlatform(app.db, 'test:read', (tx) => tx.select().from(mailboxCredentials).where(eq(mailboxCredentials.connectionId, connectionId)))
    return rows[0]
  }

  describe('mailbox.store-credentials', () => {
    it('writes a fresh row', async () => {
      const connectionId = await createConnection()
      const sealed = await sealTokens(boxPublicKey, { refreshToken: 'rt-1', accessToken: 'at-1', accessTokenExpiresAt: null })
      const deps: StoreCredentialsDeps = { db: app.db }

      await runStoreCredentials(deps, { orgId, connectionId, sealed: sealed.toString('base64') })

      const row = await readCredentialRow(connectionId)
      expect(row?.encryption).toBe('sealed')
      expect(row?.refreshTokenCiphertext.equals(sealed)).toBe(true)
    })

    it('REPLACES an existing row on a second call (reconnect)', async () => {
      const connectionId = await createConnection()
      const deps: StoreCredentialsDeps = { db: app.db }

      const first = await sealTokens(boxPublicKey, { refreshToken: 'rt-a', accessToken: null, accessTokenExpiresAt: null })
      await runStoreCredentials(deps, { orgId, connectionId, sealed: first.toString('base64') })

      const second = await sealTokens(boxPublicKey, { refreshToken: 'rt-b', accessToken: null, accessTokenExpiresAt: null })
      await runStoreCredentials(deps, { orgId, connectionId, sealed: second.toString('base64') })

      const rows = await withPlatform(app.db, 'test:count', (tx) => tx.select().from(mailboxCredentials).where(eq(mailboxCredentials.connectionId, connectionId)))
      expect(rows).toHaveLength(1)
      expect(rows[0]!.refreshTokenCiphertext.equals(second)).toBe(true)
    })
  })

  describe('mailbox.revoke', () => {
    function fakeProvider(overrides: Partial<MailboxProvider> = {}): { provider: MailboxProvider; revokeCalls: unknown[]; unsubscribeCalls: string[] } {
      const revokeCalls: unknown[] = []
      const unsubscribeCalls: string[] = []
      const mock = createMockMailbox({ mode: 'gmail' })
      const client: MailboxClient = {
        ...mock,
        async unsubscribe(subscriptionId: string) {
          unsubscribeCalls.push(subscriptionId)
        },
      }
      const provider: MailboxProvider = {
        kind: 'gmail',
        authorizationUrl: () => { throw new Error('unexpected authorizationUrl call') },
        exchangeCode: () => { throw new Error('unexpected exchangeCode call') },
        refresh: () => { throw new Error('unexpected refresh call') },
        async revoke(p) {
          revokeCalls.push(p)
        },
        client: () => client,
        ...overrides,
      }
      return { provider, revokeCalls, unsubscribeCalls }
    }

    async function seedDekCredential(connectionId: string, refreshToken: string, accessToken: string | null): Promise<void> {
      const { dek, version } = await withOrg(app.db, orgId, (tx) => loadOrgDek(tx, ring))
      const aad = `${orgId}:mailbox_credentials:${connectionId}`
      await withPlatform(app.db, 'test:seed-dek', (tx) =>
        tx.insert(mailboxCredentials).values({
          connectionId, orgId,
          refreshTokenCiphertext: encrypt(dek, Buffer.from(refreshToken, 'utf8'), aad),
          accessTokenCiphertext: accessToken !== null ? encrypt(dek, Buffer.from(accessToken, 'utf8'), aad) : null,
          accessTokenExpiresAt: accessToken !== null ? new Date(Date.now() + 3_600_000) : null,
          refreshTokenHash: hashToken('refresh', refreshToken),
          encryption: 'dek', dataKeyVersion: version,
        }),
      )
    }

    it('calls provider.revoke and unsubscribe, then deletes the row and audits mailbox.revoked', async () => {
      const connectionId = await createConnection({ pushSubscriptionId: 'sub-123' })
      await seedDekCredential(connectionId, 'refresh-xyz', 'access-xyz')
      const { provider, revokeCalls, unsubscribeCalls } = fakeProvider()
      const deps: RevokeMailboxDeps = { db: app.db, ring, config: baseConfig(), logger: silentLogger, providerFactory: () => provider }

      await runRevokeMailbox(deps, { orgId, connectionId })

      expect(revokeCalls).toEqual([expect.objectContaining({ refreshToken: 'refresh-xyz' })])
      expect(unsubscribeCalls).toEqual(['sub-123'])
      expect(await readCredentialRow(connectionId)).toBeUndefined()

      const audits = await withPlatform(app.db, 'test:audit', (tx) =>
        tx.select().from(auditLog).where(and(eq(auditLog.entityId, connectionId), eq(auditLog.action, 'mailbox.revoked'))))
      expect(audits).toHaveLength(1)
      expect(audits[0]!.orgId).toBe(orgId)
    })

    it('completes cleanly with no credentials row (disconnect raced the store job)', async () => {
      const connectionId = await createConnection()
      const { provider, revokeCalls, unsubscribeCalls } = fakeProvider()
      const deps: RevokeMailboxDeps = { db: app.db, ring, config: baseConfig(), logger: silentLogger, providerFactory: () => provider }

      await expect(runRevokeMailbox(deps, { orgId, connectionId })).resolves.toBeUndefined()

      expect(revokeCalls).toHaveLength(0)
      expect(unsubscribeCalls).toHaveLength(0)
      const audits = await withPlatform(app.db, 'test:audit2', (tx) =>
        tx.select().from(auditLog).where(and(eq(auditLog.entityId, connectionId), eq(auditLog.action, 'mailbox.revoked'))))
      expect(audits).toHaveLength(1)
    })

    it('tolerates a missing connection row too', async () => {
      const missingId = crypto.randomUUID()
      const { provider } = fakeProvider()
      const deps: RevokeMailboxDeps = { db: app.db, ring, config: baseConfig(), logger: silentLogger, providerFactory: () => provider }

      await expect(runRevokeMailbox(deps, { orgId, connectionId: missingId })).resolves.toBeUndefined()
    })

    it('reads a SEALED credentials row correctly (the common connect-then-disconnect path: never synced, never migrated to dek)', async () => {
      const connectionId = await createConnection({ pushSubscriptionId: 'sub-sealed' })
      const sealed = await sealTokens(boxPublicKey, { refreshToken: 'refresh-sealed', accessToken: 'access-sealed', accessTokenExpiresAt: null })
      await withPlatform(app.db, 'test:seed-sealed', (tx) =>
        tx.insert(mailboxCredentials).values({ connectionId, orgId, refreshTokenCiphertext: sealed, encryption: 'sealed' }))
      const { provider, revokeCalls, unsubscribeCalls } = fakeProvider()
      const deps: RevokeMailboxDeps = { db: app.db, ring, config: baseConfig(), logger: silentLogger, providerFactory: () => provider }

      await runRevokeMailbox(deps, { orgId, connectionId })

      expect(revokeCalls).toEqual([expect.objectContaining({ refreshToken: 'refresh-sealed' })])
      expect(unsubscribeCalls).toEqual(['sub-sealed'])
      expect(await readCredentialRow(connectionId)).toBeUndefined()
      const audits = await withPlatform(app.db, 'test:audit-sealed', (tx) =>
        tx.select().from(auditLog).where(and(eq(auditLog.entityId, connectionId), eq(auditLog.action, 'mailbox.revoked'))))
      expect(audits).toHaveLength(1)
    })

    it("a network failure on provider.revoke does not block local cleanup", async () => {
      const connectionId = await createConnection()
      await seedDekCredential(connectionId, 'refresh-fail', 'access-fail')
      const { provider } = fakeProvider({ revoke: async () => { throw new Error('network down') } })
      const deps: RevokeMailboxDeps = { db: app.db, ring, config: baseConfig(), logger: silentLogger, providerFactory: () => provider }

      await expect(runRevokeMailbox(deps, { orgId, connectionId })).resolves.toBeUndefined()
      expect(await readCredentialRow(connectionId)).toBeUndefined()
    })
  })
})
