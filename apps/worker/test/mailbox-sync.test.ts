/**
 * `mailbox.sync` against Postgres + a real (test) pg-boss, with `@aesa/mail`'s `createMockMailbox`
 * plugged in via `clientFactory` — no real network. Scenario numbering follows the task brief's list.
 * `providerFactory` stands in for the whole Gmail/Graph adapter only where a scenario needs
 * `getAccessToken`'s `.refresh()` call itself to fail (the reauth scenario) — every other scenario
 * seeds a FRESH access token so `getAccessToken` never calls `.refresh()` at all, matching
 * `@aesa/mail/credentials.test.ts`'s own established pattern.
 */
import { randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type PgBoss from 'pg-boss'
import pino from 'pino'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { encrypt, hashToken, loadKekRing, type KekRing } from '@aesa/crypto'
import {
  agents, loadOrgDek, mailboxConnections, mailboxCredentials, notifications, provisionOrgKeys, tickets, user, withOrg,
  withPlatform, workspaces,
} from '@aesa/db'
import { createDb } from '@aesa/db/raw'
import { createTestDatabase, createTestOrganization } from '@aesa/db/testing'
import {
  createMailLimiter, createMockMailbox, ProviderAuthError, ProviderRateLimitError, type MailboxProvider, type MockMailbox,
} from '@aesa/mail'
import { JOB_NAMES } from '@aesa/queue'
import type { WorkerConfig } from '../src/config.ts'
import { runMailboxSync, type MailboxSyncDeps } from '../src/jobs/mailbox-sync.ts'
import { deleteJobsForOrgs, queryJobs, startTestBoss } from './helpers/boss.ts'

const rand = () => randomBytes(4).toString('hex')

function baseConfig(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    env: 'test', databaseUrl: 'unused', roles: new Set(['sync']), kekRing: null, logLevel: 'silent', anthropicApiKey: null,
    gmailOauth: { clientId: 'gmail-client', clientSecret: { expose: () => 'gmail-secret' } as never },
    mail: { transport: 'devsink', from: 'aesa <onboarding@resend.dev>' },
    appBaseUrl: null,
    appWebOrigin: null,
    voyageApiKey: null,
    knowledgeEmbedModel: 'voyage-4',
    knowledgeRerank: false,
    s3: null,
    msOauth: null, gmailPubsubTopic: null, webhookPublicUrl: null, platformSender: 'no-reply@aesa.test',
    ...overrides,
  }
}

describe('mailbox.sync', () => {
  let t: Awaited<ReturnType<typeof createTestDatabase>>
  let app: ReturnType<typeof createDb>
  let boss: PgBoss
  let orgId: string
  let userId: string
  const ring: KekRing = loadKekRing({ AESA_KEK_V1: randomBytes(32).toString('base64'), AESA_KEK_ACTIVE: '1' })

  beforeAll(async () => {
    t = await createTestDatabase()
    app = createDb(t.url)
    boss = await startTestBoss()
    await boss.createQueue(JOB_NAMES.ticketTriage)
    await boss.createQueue(JOB_NAMES.notifyDispatch)
    await boss.createQueue(JOB_NAMES.mailboxSync)

    orgId = await createTestOrganization(app)
    await withOrg(app.db, orgId, (tx) => tx.insert(workspaces).values({ orgId, businessName: 'Acme', timezone: 'UTC' }))
    await withOrg(app.db, orgId, (tx) => provisionOrgKeys(tx, ring))
    const [u] = await app.db.insert(user).values({ name: 'Owner', email: `owner-${rand()}@example.com` }).returning()
    userId = u!.id
  })
  afterAll(async () => {
    // Scoped to this file's own org — pgboss_test is a real, shared schema on the stable dev
    // database, and other spec files run against the SAME queue names concurrently (see
    // test/helpers/boss.ts's deleteJobsForOrgs doc comment).
    await deleteJobsForOrgs(JOB_NAMES.ticketTriage, [orgId])
    await deleteJobsForOrgs(JOB_NAMES.notifyDispatch, [orgId])
    await deleteJobsForOrgs(JOB_NAMES.mailboxSync, [orgId])
    await boss.stop({ graceful: false, wait: true })
    await app.pool.end()
    await t.drop()
  })

  async function createConnection(): Promise<{ connectionId: string; selfAddress: string }> {
    const selfAddress = `support-${rand()}@acme.test`
    const [conn] = await withOrg(app.db, orgId, (tx) =>
      tx
        .insert(mailboxConnections)
        .values({ orgId, provider: 'gmail', providerAccountId: `acct-${rand()}`, emailAddress: selfAddress, status: 'connected', connectedByUserId: userId })
        .returning(),
    )
    await withOrg(app.db, orgId, (tx) =>
      tx.insert(agents).values({ orgId, connectionId: conn!.id, address: selfAddress, domain: selfAddress.split('@')[1]!, displayName: 'Support', status: 'active' }),
    )
    return { connectionId: conn!.id, selfAddress }
  }

  /** A FRESH access token — getAccessToken returns it straight from the row, never calling `.refresh()`. */
  async function seedFreshCredential(connectionId: string, accessToken = `access-${rand()}`): Promise<string> {
    const { dek, version } = await withOrg(app.db, orgId, (tx) => loadOrgDek(tx, ring))
    const refreshToken = `refresh-${rand()}`
    const aad = `${orgId}:mailbox_credentials:${connectionId}`
    await withPlatform(app.db, 'test:seed-fresh', (tx) =>
      tx.insert(mailboxCredentials).values({
        connectionId, orgId,
        refreshTokenCiphertext: encrypt(dek, Buffer.from(refreshToken, 'utf8'), aad),
        accessTokenCiphertext: encrypt(dek, Buffer.from(accessToken, 'utf8'), aad),
        accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
        refreshTokenHash: hashToken('refresh', refreshToken),
        encryption: 'dek', dataKeyVersion: version,
      }),
    )
    return accessToken
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

  function makeDeps(overrides: Partial<MailboxSyncDeps> = {}): MailboxSyncDeps {
    return {
      db: app.db,
      ring,
      config: baseConfig(),
      limiter: createMailLimiter(),
      logger: pino({ level: 'silent' }),
      ...overrides,
    }
  }

  async function notificationsFor(dedupeKey: string) {
    return withOrg(app.db, orgId, (tx) => tx.select().from(notifications).where(eq(notifications.dedupeKey, dedupeKey)))
  }

  it('lease contention: a pre-held lease means the handler returns without touching the client', async () => {
    const { connectionId } = await createConnection()
    const future = new Date(Date.now() + 60_000)
    await withOrg(app.db, orgId, (tx) => tx.update(mailboxConnections).set({ pollLeaseUntil: future }).where(eq(mailboxConnections.id, connectionId)))

    let clientCalled = false
    const deps = makeDeps({ clientFactory: () => { clientCalled = true; throw new Error('must not be called') } })

    await runMailboxSync(boss, deps, { orgId, connectionId })

    expect(clientCalled).toBe(false)
    const after = await readConnection(connectionId)
    expect(after.pollLeaseUntil?.getTime()).toBe(future.getTime())
  })

  it('happy path: a mock inbound message creates a ticket, enqueues ticket.triage, and writes health', async () => {
    const { connectionId, selfAddress } = await createConnection()
    const accessToken = await seedFreshCredential(connectionId)
    const mailbox: MockMailbox = createMockMailbox({ mode: 'gmail', selfAddress })
    let seenArgs: [string, string, string] | undefined
    const deps = makeDeps({
      clientFactory: (provider, token, addr) => { seenArgs = [provider, token, addr]; return mailbox },
    })

    // Seed-on-null: the first call only remembers where to start (no message exists yet).
    await runMailboxSync(boss, deps, { orgId, connectionId })
    expect(seenArgs).toEqual(['gmail', accessToken, selfAddress])

    mailbox.receiveInbound({ from: 'customer@example.test', to: [selfAddress], subject: 'Help', bodyText: 'Where is my order?' })
    await runMailboxSync(boss, deps, { orgId, connectionId })

    const ticketRows = await withOrg(app.db, orgId, (tx) => tx.select().from(tickets).where(eq(tickets.connectionId, connectionId)))
    expect(ticketRows).toHaveLength(1)
    expect(ticketRows[0]!.status).toBe('new')

    const after = await readConnection(connectionId)
    expect(after.pollLeaseUntil).toBeNull()
    expect(after.lastSyncAt).not.toBeNull()
    expect(after.lastSuccessAt).not.toBeNull()
    expect(after.consecutiveFailures).toBe(0)

    const jobs = await queryJobs(JOB_NAMES.ticketTriage)
    const match = jobs.find((j) => (j.data as { ticketId?: string }).ticketId === ticketRows[0]!.id)
    expect(match).toBeDefined()
    expect((match!.data as { orgId?: string }).orgId).toBe(orgId)
  })

  it('failure path: a listChanges failure bumps consecutive_failures and sets a backoff', async () => {
    const { connectionId, selfAddress } = await createConnection()
    await seedFreshCredential(connectionId)
    const mailbox: MockMailbox = createMockMailbox({ mode: 'gmail', selfAddress })
    const deps = makeDeps({ clientFactory: () => mailbox })

    await runMailboxSync(boss, deps, { orgId, connectionId }) // seed the cursor — a clean run, sets lastSuccessAt
    const seeded = await readConnection(connectionId)
    expect(seeded.lastSuccessAt).not.toBeNull()

    mailbox.failNext('listChanges', new Error('boom'))
    await runMailboxSync(boss, deps, { orgId, connectionId })

    const after = await readConnection(connectionId)
    expect(after.consecutiveFailures).toBe(1)
    expect(after.backoffUntil).not.toBeNull()
    expect(after.backoffUntil!.getTime()).toBeGreaterThan(Date.now())
    expect(after.pollLeaseUntil).toBeNull()
    expect(after.lastSuccessAt?.getTime()).toBe(seeded.lastSuccessAt!.getTime()) // unchanged by the failed run
    expect(after.lastSyncAt!.getTime()).toBeGreaterThan(seeded.lastSyncAt!.getTime()) // last_sync_at still bumps
  })

  it('reauth path: getAccessToken throwing ProviderAuthError inserts a mailbox_reauth notification and completes', async () => {
    const { connectionId } = await createConnection()
    await seedExpiredCredential(connectionId)
    const failingProvider: MailboxProvider = {
      kind: 'gmail',
      authorizationUrl: () => { throw new Error('unexpected') },
      exchangeCode: () => { throw new Error('unexpected') },
      refresh: async () => { throw new ProviderAuthError('refresh token rejected') },
      revoke: async () => {},
      client: () => { throw new Error('must not build a client on a reauth failure') },
    }
    let clientBuilt = false
    const deps = makeDeps({
      providerFactory: () => failingProvider,
      clientFactory: () => { clientBuilt = true; throw new Error('must not be called') },
    })

    await expect(runMailboxSync(boss, deps, { orgId, connectionId })).resolves.toBeUndefined()

    expect(clientBuilt).toBe(false)
    const after = await readConnection(connectionId)
    expect(after.status).toBe('reauth_required') // Task 8's own flip (the hash tried was current)
    expect(after.pollLeaseUntil).toBeNull()

    const day = new Date().toISOString().slice(0, 10)
    const rows = await notificationsFor(`reauth:${connectionId}:${day}`)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.kind).toBe('mailbox_reauth')

    const notifyJobs = await queryJobs(JOB_NAMES.notifyDispatch)
    const match = notifyJobs.find((j) => (j.data as { notificationId?: string }).notificationId === rows[0]!.id)
    expect(match).toBeDefined()
  })

  it('a missing OAuth pair for the connection\'s provider (the !oauth throw) still clears the lease and writes consecutive_failures/backoff, no crash', async () => {
    const { connectionId } = await createConnection() // provider: 'gmail'
    // No credential seeded at all — the !oauth throw fires before getAccessToken is ever reached,
    // so there is nothing for it to read. index.ts registers mailbox.sync without gating on which
    // OAuth pairs are configured (a deployment may support only one provider), so a connection whose
    // provider has no configured pair is production-reachable, not just a test artifact.
    const deps = makeDeps({ config: baseConfig({ gmailOauth: null }) })

    await expect(runMailboxSync(boss, deps, { orgId, connectionId })).resolves.toBeUndefined()

    const after = await readConnection(connectionId)
    expect(after.pollLeaseUntil).toBeNull()
    expect(after.consecutiveFailures).toBe(1)
    expect(after.backoffUntil).not.toBeNull()
    expect(after.backoffUntil!.getTime()).toBeGreaterThan(Date.now())
  })

  it('mid-walk ProviderAuthError (a 401 from any adapter call, not just getAccessToken) still runs Step 6 for messages already committed before it', async () => {
    const { connectionId, selfAddress } = await createConnection()
    await seedFreshCredential(connectionId)
    const mailbox: MockMailbox = createMockMailbox({ mode: 'gmail', selfAddress })
    const seedDeps = makeDeps({ clientFactory: () => mailbox })
    await runMailboxSync(boss, seedDeps, { orgId, connectionId }) // seed the cursor

    // Two messages land in the same poll; the client throws ProviderAuthError fetching the SECOND
    // one, after the first has already been fully ingested (ticket created, message inserted,
    // onNewInboundTicket already fired into runMailboxSync's collected array) by runSync's own
    // per-message transaction.
    mailbox.receiveInbound({ from: 'customer1@example.test', to: [selfAddress], subject: 'Order 1', bodyText: 'Where is my order?' })
    const msg2 = mailbox.receiveInbound({ from: 'customer2@example.test', to: [selfAddress], subject: 'Order 2', bodyText: 'Refund please' })
    const wrappedClient = {
      ...mailbox,
      getMessage: async (id: string, opts: { format: 'metadata' | 'full' }) => {
        if (id === msg2.id) throw new ProviderAuthError('token rejected mid-walk')
        return mailbox.getMessage(id, opts)
      },
    }
    const deps = makeDeps({ clientFactory: () => wrappedClient })

    await expect(runMailboxSync(boss, deps, { orgId, connectionId })).resolves.toBeUndefined()

    // msg1's ticket exists and was enqueued for triage — the fix under test.
    const ticketRows = await withOrg(app.db, orgId, (tx) => tx.select().from(tickets).where(eq(tickets.connectionId, connectionId)))
    expect(ticketRows).toHaveLength(1) // msg2 never got far enough to open a second ticket
    const jobs = await queryJobs(JOB_NAMES.ticketTriage)
    const match = jobs.find((j) => (j.data as { ticketId?: string }).ticketId === ticketRows[0]!.id)
    expect(match).toBeDefined()
    expect((match!.data as { orgId?: string }).orgId).toBe(orgId)

    // AND the reauth handling itself still ran: notification exists, no failure bump.
    const after = await readConnection(connectionId)
    expect(after.consecutiveFailures).toBe(0)
    expect(after.pollLeaseUntil).toBeNull()
    const day = new Date().toISOString().slice(0, 10)
    const rows = await notificationsFor(`reauth:${connectionId}:${day}`)
    expect(rows).toHaveLength(1)
    const notifyJobs = await queryJobs(JOB_NAMES.notifyDispatch)
    expect(notifyJobs.some((j) => (j.data as { notificationId?: string }).notificationId === rows[0]!.id)).toBe(true)
  })

  it('a generic (non-auth, non-rate-limit) getAccessToken failure still clears the lease and writes consecutive_failures/backoff (Important 4)', async () => {
    const { connectionId } = await createConnection()
    await seedExpiredCredential(connectionId)
    const failingProvider: MailboxProvider = {
      kind: 'gmail',
      authorizationUrl: () => { throw new Error('unexpected') },
      exchangeCode: () => { throw new Error('unexpected') },
      refresh: async () => { throw new Error('network exploded') },
      revoke: async () => {},
      client: () => { throw new Error('must not build a client on a getAccessToken failure') },
    }
    const deps = makeDeps({ providerFactory: () => failingProvider })

    // Before the fix: this throw happened AFTER claimLease but BEFORE the health/finally block, so
    // it propagated straight out of runMailboxSync — leaking the 90s lease and skipping the
    // consecutive_failures/backoff write entirely (fix review, Important 4).
    await expect(runMailboxSync(boss, deps, { orgId, connectionId })).resolves.toBeUndefined()

    const after = await readConnection(connectionId)
    expect(after.pollLeaseUntil).toBeNull()
    expect(after.consecutiveFailures).toBe(1)
    expect(after.backoffUntil).not.toBeNull()
    expect(after.backoffUntil!.getTime()).toBeGreaterThan(Date.now())
  })

  it('heal ruling: a connection flipped to reauth_required mid-run (another worker\'s slower attempt) heals to connected on a successful run', async () => {
    const { connectionId, selfAddress } = await createConnection()
    await seedFreshCredential(connectionId)
    const mailbox: MockMailbox = createMockMailbox({ mode: 'gmail', selfAddress })
    const seedDeps = makeDeps({ clientFactory: () => mailbox })
    await runMailboxSync(boss, seedDeps, { orgId, connectionId }) // seed the cursor

    // Simulate the race the Task 8 carry-over ruling exists for: by the time THIS run reaches the
    // walk (already past its own getAccessToken call, lease already claimed while status was still
    // 'connected'), another worker's slower attempt flips the row to reauth_required.
    let flipped = false
    const wrappedClient = {
      ...mailbox,
      listChanges: async (cursor: unknown, pageToken?: string) => {
        if (!flipped) {
          flipped = true
          await withOrg(app.db, orgId, (tx) => tx.update(mailboxConnections).set({ status: 'reauth_required' }).where(eq(mailboxConnections.id, connectionId)))
        }
        return mailbox.listChanges(cursor, pageToken)
      },
    }
    const healDeps = makeDeps({ clientFactory: () => wrappedClient })

    await runMailboxSync(boss, healDeps, { orgId, connectionId })

    expect(flipped).toBe(true)
    const after = await readConnection(connectionId)
    expect(after.status).toBe('connected') // healed — this run's own getAccessToken proved the credential works
    expect(after.lastSuccessAt).not.toBeNull()
  })

  it('heal ruling companion: an intentional disconnect (status disabled) mid-run is NEVER overridden by the success write', async () => {
    const { connectionId, selfAddress } = await createConnection()
    await seedFreshCredential(connectionId)
    const mailbox: MockMailbox = createMockMailbox({ mode: 'gmail', selfAddress })
    const seedDeps = makeDeps({ clientFactory: () => mailbox })
    await runMailboxSync(boss, seedDeps, { orgId, connectionId }) // seed the cursor

    let flipped = false
    const wrappedClient = {
      ...mailbox,
      listChanges: async (cursor: unknown, pageToken?: string) => {
        if (!flipped) {
          flipped = true
          await withOrg(app.db, orgId, (tx) => tx.update(mailboxConnections).set({ status: 'disabled' }).where(eq(mailboxConnections.id, connectionId)))
        }
        return mailbox.listChanges(cursor, pageToken)
      },
    }
    const disconnectDeps = makeDeps({ clientFactory: () => wrappedClient })

    await runMailboxSync(boss, disconnectDeps, { orgId, connectionId })

    expect(flipped).toBe(true)
    const after = await readConnection(connectionId)
    expect(after.status).toBe('disabled') // the user's disconnect wins — only reauth_required heals
  })

  it('a ProviderRateLimitError from runSync re-enqueues itself and does not count as a failure', async () => {
    const { connectionId, selfAddress } = await createConnection()
    await seedFreshCredential(connectionId)
    const mailbox: MockMailbox = createMockMailbox({ mode: 'gmail', selfAddress })
    const deps = makeDeps({ clientFactory: () => mailbox })

    await runMailboxSync(boss, deps, { orgId, connectionId }) // seed the cursor

    mailbox.failNext('listChanges', new ProviderRateLimitError('slow down', 5_000))
    await runMailboxSync(boss, deps, { orgId, connectionId })

    const after = await readConnection(connectionId)
    expect(after.consecutiveFailures).toBe(0)
    expect(after.backoffUntil).toBeNull()
    expect(after.pollLeaseUntil).toBeNull()

    const jobs = await queryJobs(JOB_NAMES.mailboxSync)
    const selfRequeue = jobs.find((j) => (j.data as { connectionId?: string }).connectionId === connectionId)
    expect(selfRequeue).toBeDefined()
    expect(selfRequeue!.startAfter.getTime()).toBeGreaterThan(Date.now())
  })
})
