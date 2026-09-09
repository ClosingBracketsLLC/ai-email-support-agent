/**
 * `mailbox.renew-watch` against Postgres + a real (test) pg-boss, with a fake `MailboxProvider`
 * (`providerFactory`) standing in for both `getAccessToken`'s `.refresh` and the client's
 * `subscribe`/`renewSubscription` — no real network. Every connection here seeds a FRESH access
 * token so `getAccessToken` never calls `.refresh`.
 */
import { randomBytes } from 'node:crypto'
import { eq, inArray } from 'drizzle-orm'
import type PgBoss from 'pg-boss'
import pino, { type Logger } from 'pino'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { encrypt, hashToken, hashesEqual, loadKekRing, type KekRing } from '@aesa/crypto'
import { loadOrgDek, mailboxConnections, mailboxCredentials, notifications, provisionOrgKeys, user, withOrg, withPlatform, workspaces } from '@aesa/db'
import { createDb } from '@aesa/db/raw'
import { createTestDatabase, createTestOrganization } from '@aesa/db/testing'
import { ProviderAuthError, type MailboxClient, type MailboxProvider } from '@aesa/mail'
import { JOB_NAMES } from '@aesa/queue'
import type { WorkerConfig } from '../src/config.ts'
import { runMailboxRenewWatch, type MailboxRenewWatchDeps } from '../src/jobs/mailbox-renew-watch.ts'
import { deleteJobsForOrgs, queryJobs, startTestBoss } from './helpers/boss.ts'

const rand = () => randomBytes(4).toString('hex')

function baseConfig(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    env: 'test', databaseUrl: 'unused', roles: new Set(['sync']), kekRing: null, logLevel: 'silent', anthropicApiKey: null,
    gmailOauth: { clientId: 'gmail-client', clientSecret: { expose: () => 'gmail-secret' } as never },
    msOauth: { clientId: 'ms-client', clientSecret: { expose: () => 'ms-secret' } as never },
    gmailPubsubTopic: 'projects/p/topics/t', webhookPublicUrl: 'https://api.example.com', platformSender: 'no-reply@aesa.test',
    ...overrides,
  }
}

describe('mailbox.renew-watch', () => {
  let t: Awaited<ReturnType<typeof createTestDatabase>>
  let app: ReturnType<typeof createDb>
  let boss: PgBoss
  let orgId: string
  let userId: string
  const ring: KekRing = loadKekRing({ AESA_KEK_V1: randomBytes(32).toString('base64'), AESA_KEK_ACTIVE: '1' })
  // `runMailboxRenewWatch` scans EVERY 'connected' connection across every org (it's a cron with no
  // org filter) — a connection a test leaves with pushSubscriptionId still null (a failed subscribe,
  // or a test that returns before touching it) would otherwise linger as a candidate for every LATER
  // test in this file. Disable each test's own connections afterward so they never leak forward.
  let createdConnectionIds: string[] = []

  beforeAll(async () => {
    t = await createTestDatabase()
    app = createDb(t.url)
    boss = await startTestBoss()
    await boss.createQueue(JOB_NAMES.notifyDispatch)
    orgId = await createTestOrganization(app)
    await withOrg(app.db, orgId, (tx) => tx.insert(workspaces).values({ orgId, businessName: 'Acme', timezone: 'UTC' }))
    await withOrg(app.db, orgId, (tx) => provisionOrgKeys(tx, ring))
    const [u] = await app.db.insert(user).values({ name: 'Owner', email: `owner-${rand()}@example.com` }).returning()
    userId = u!.id
  })
  afterAll(async () => {
    // Scoped to this file's own org — see test/helpers/boss.ts's deleteJobsForOrgs doc comment.
    await deleteJobsForOrgs(JOB_NAMES.notifyDispatch, [orgId])
    await boss.stop({ graceful: false, wait: true })
    await app.pool.end()
    await t.drop()
  })
  afterEach(async () => {
    if (createdConnectionIds.length === 0) return
    await withOrg(app.db, orgId, (tx) =>
      tx.update(mailboxConnections).set({ status: 'disabled' }).where(inArray(mailboxConnections.id, createdConnectionIds)))
    createdConnectionIds = []
  })

  async function createConnection(provider: 'gmail' | 'microsoft', overrides: Partial<typeof mailboxConnections.$inferInsert> = {}): Promise<string> {
    const [conn] = await withOrg(app.db, orgId, (tx) =>
      tx
        .insert(mailboxConnections)
        .values({
          orgId, provider, providerAccountId: `acct-${rand()}`, emailAddress: `support-${rand()}@acme.test`,
          status: 'connected', connectedByUserId: userId, ...overrides,
        })
        .returning(),
    )
    createdConnectionIds.push(conn!.id)
    return conn!.id
  }

  async function seedFreshCredential(connectionId: string): Promise<void> {
    const { dek, version } = await withOrg(app.db, orgId, (tx) => loadOrgDek(tx, ring))
    const refreshToken = `refresh-${rand()}`
    const accessToken = `access-${rand()}`
    const aad = `${orgId}:mailbox_credentials:${connectionId}`
    await withPlatform(app.db, 'test:seed', (tx) =>
      tx.insert(mailboxCredentials).values({
        connectionId, orgId,
        refreshTokenCiphertext: encrypt(dek, Buffer.from(refreshToken, 'utf8'), aad),
        accessTokenCiphertext: encrypt(dek, Buffer.from(accessToken, 'utf8'), aad),
        accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
        refreshTokenHash: hashToken('refresh', refreshToken),
        encryption: 'dek', dataKeyVersion: version,
      }),
    )
  }

  /** An EXPIRED access token — getAccessToken must claim the refresh lease and call `.refresh()`. */
  async function seedExpiredCredential(connectionId: string): Promise<void> {
    const { dek, version } = await withOrg(app.db, orgId, (tx) => loadOrgDek(tx, ring))
    const refreshToken = `refresh-${rand()}`
    const aad = `${orgId}:mailbox_credentials:${connectionId}`
    await withPlatform(app.db, 'test:seed-expired', (tx) =>
      tx.insert(mailboxCredentials).values({
        connectionId, orgId,
        refreshTokenCiphertext: encrypt(dek, Buffer.from(refreshToken, 'utf8'), aad),
        accessTokenCiphertext: encrypt(dek, Buffer.from('stale-token', 'utf8'), aad),
        accessTokenExpiresAt: new Date(Date.now() - 3_600_000),
        refreshTokenHash: hashToken('refresh', refreshToken),
        encryption: 'dek', dataKeyVersion: version,
      }),
    )
  }

  async function readConnection(connectionId: string) {
    const [row] = await withOrg(app.db, orgId, (tx) => tx.select().from(mailboxConnections).where(eq(mailboxConnections.id, connectionId)))
    return row!
  }

  async function notificationsFor(dedupeKey: string) {
    return withOrg(app.db, orgId, (tx) => tx.select().from(notifications).where(eq(notifications.dedupeKey, dedupeKey)))
  }

  function fakeProvider(client: Partial<MailboxClient>, overrides: Partial<MailboxProvider> = {}): MailboxProvider {
    return {
      kind: 'gmail',
      authorizationUrl: () => { throw new Error('unexpected') },
      exchangeCode: () => { throw new Error('unexpected') },
      refresh: () => { throw new Error('unexpected refresh call') },
      revoke: async () => {},
      client: () => client as MailboxClient,
      ...overrides,
    }
  }

  function makeDeps(overrides: Partial<MailboxRenewWatchDeps> = {}): MailboxRenewWatchDeps {
    return { db: app.db, ring, config: baseConfig(), logger: pino({ level: 'silent' }), ...overrides }
  }

  it('no subscription (microsoft): subscribes, storing a clientState whose hash lands in push_client_state_hash', async () => {
    const connectionId = await createConnection('microsoft')
    await seedFreshCredential(connectionId)
    let seenClientState: string | undefined
    const subscribeExpiresAt = new Date(Date.now() + 4230 * 60_000)
    const client: Partial<MailboxClient> = {
      subscribe: async (input) => {
        seenClientState = input.clientState
        return { subscriptionId: 'graph-sub-1', expiresAt: subscribeExpiresAt }
      },
    }
    const deps = makeDeps({ providerFactory: () => fakeProvider(client) })

    await runMailboxRenewWatch(boss, deps)

    expect(seenClientState).toBeDefined()
    const after = await readConnection(connectionId)
    expect(after.pushSubscriptionId).toBe('graph-sub-1')
    expect(after.pushExpiresAt?.getTime()).toBe(subscribeExpiresAt.getTime())
    expect(after.pushClientStateHash).not.toBeNull()
    expect(hashesEqual(hashToken('action', seenClientState!), after.pushClientStateHash!)).toBe(true)
  })

  it('no subscription (gmail): subscribes with the configured topic, subscriptionId = topic', async () => {
    const connectionId = await createConnection('gmail')
    await seedFreshCredential(connectionId)
    let seenTopic: string | undefined
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60_000)
    const client: Partial<MailboxClient> = {
      subscribe: async (input) => { seenTopic = input.topicOrUrl; return { subscriptionId: input.topicOrUrl, expiresAt } },
    }
    const deps = makeDeps({ providerFactory: () => fakeProvider(client) })

    await runMailboxRenewWatch(boss, deps)

    expect(seenTopic).toBe('projects/p/topics/t')
    const after = await readConnection(connectionId)
    expect(after.pushSubscriptionId).toBe('projects/p/topics/t')
    expect(after.pushExpiresAt?.getTime()).toBe(expiresAt.getTime())
  })

  it('an expiring subscription (< 36h remaining) is renewed', async () => {
    const connectionId = await createConnection('microsoft', {
      pushSubscriptionId: 'graph-sub-old', pushExpiresAt: new Date(Date.now() + 10 * 60 * 60_000),
    })
    await seedFreshCredential(connectionId)
    let renewedId: string | undefined
    const newExpiry = new Date(Date.now() + 4230 * 60_000)
    const client: Partial<MailboxClient> = {
      renewSubscription: async (subscriptionId) => { renewedId = subscriptionId; return { subscriptionId, expiresAt: newExpiry } },
    }
    const deps = makeDeps({ providerFactory: () => fakeProvider(client) })

    await runMailboxRenewWatch(boss, deps)

    expect(renewedId).toBe('graph-sub-old')
    const after = await readConnection(connectionId)
    expect(after.pushExpiresAt?.getTime()).toBe(newExpiry.getTime())
  })

  it('a subscription with plenty of time left (>= 36h) is left alone', async () => {
    const farExpiry = new Date(Date.now() + 40 * 60 * 60_000)
    const connectionId = await createConnection('microsoft', { pushSubscriptionId: 'graph-sub-fine', pushExpiresAt: farExpiry })
    await seedFreshCredential(connectionId)
    let touched = false
    const client: Partial<MailboxClient> = {
      subscribe: async () => { touched = true; throw new Error('must not subscribe') },
      renewSubscription: async () => { touched = true; throw new Error('must not renew') },
    }
    const deps = makeDeps({ providerFactory: () => fakeProvider(client) })

    await runMailboxRenewWatch(boss, deps)

    expect(touched).toBe(false)
    const after = await readConnection(connectionId)
    expect(after.pushExpiresAt?.getTime()).toBe(farExpiry.getTime())
  })

  it('a failure is logged and bumps consecutive_failures without throwing', async () => {
    const connectionId = await createConnection('microsoft')
    await seedFreshCredential(connectionId)
    const client: Partial<MailboxClient> = { subscribe: async () => { throw new Error('graph is down') } }
    const warnings: unknown[] = []
    const logger = { warn: (...args: unknown[]) => warnings.push(args), info: () => {} } as unknown as Logger
    const deps = makeDeps({ providerFactory: () => fakeProvider(client), logger })

    await expect(runMailboxRenewWatch(boss, deps)).resolves.toBeUndefined()

    expect(warnings.length).toBeGreaterThan(0)
    const after = await readConnection(connectionId)
    expect(after.consecutiveFailures).toBe(1)
  })

  it('no push-configured providers at all: does nothing', async () => {
    const connectionId = await createConnection('microsoft')
    await seedFreshCredential(connectionId)
    let called = false
    const deps = makeDeps({
      config: baseConfig({ gmailPubsubTopic: null, webhookPublicUrl: null }),
      providerFactory: () => fakeProvider({ subscribe: async () => { called = true; throw new Error('must not be called') } }),
    })

    await runMailboxRenewWatch(boss, deps)

    expect(called).toBe(false)
    const after = await readConnection(connectionId)
    expect(after.pushSubscriptionId).toBeNull()
  })

  it('getAccessToken throwing ProviderAuthError inserts a mailbox_reauth notification and enqueues notify.dispatch, without bumping consecutive_failures (Important 3)', async () => {
    const connectionId = await createConnection('microsoft')
    await seedExpiredCredential(connectionId)
    const now = new Date()
    let subscribeCalled = false
    const deps = makeDeps({
      now: () => now,
      providerFactory: () => fakeProvider(
        { subscribe: async () => { subscribeCalled = true; throw new Error('must not be called') } },
        { refresh: async () => { throw new ProviderAuthError('refresh token rejected') } },
      ),
    })

    await expect(runMailboxRenewWatch(boss, deps)).resolves.toBeUndefined()

    expect(subscribeCalled).toBe(false)
    const after = await readConnection(connectionId)
    expect(after.status).toBe('reauth_required') // Task 8's own flip (the hash tried was current)
    expect(after.consecutiveFailures).toBe(0) // NOT a generic failure — no backoff-style bump

    const day = now.toISOString().slice(0, 10)
    const rows = await notificationsFor(`reauth:${connectionId}:${day}`)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.kind).toBe('mailbox_reauth')

    const notifyJobs = await queryJobs(JOB_NAMES.notifyDispatch)
    const match = notifyJobs.find((j) => (j.data as { notificationId?: string }).notificationId === rows[0]!.id)
    expect(match).toBeDefined()
  })
})
