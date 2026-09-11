/**
 * Phase 2 close-out: the spec's Phase-2 verification scenarios driven end-to-end through REAL
 * pg-boss jobs (`boss.send`/`enqueue` -> `registerJob`'s real work loop), never by calling a job's
 * `run*` function directly. Task 11/14/15/16's own unit suites already pin the business rules this
 * exercises; this file exists to prove the WIRING between them: mailbox.sync's callbacks really
 * reach ticket.triage through boss, ticket.triage's escalations really reach notify.dispatch, and
 * mailbox.poll-sweep's re-enqueue really lands a fresh job pg-boss picks up.
 *
 * One throwaway database (`createTestDatabase`) for every business table, and one pg-boss instance
 * on the shared dev `DATABASE_URL` under a schema unique to THIS run (`pgboss_e2e_<hex>`, dropped in
 * `afterAll`) — never `pgboss_test`, which other spec files poll concurrently. `createMockMailbox`
 * (`@aesa/mail`) is plugged into `mailbox.sync` through its `clientFactory` seam (mapped by the
 * connection's own self-address, since the seam is not handed a connection id); `createFakeProvider`
 * (`@aesa/llm`) stands in for the model call `ticket.triage` makes; a recording stub replaces
 * `notify.dispatch`'s `SendPush`. Scenario numbering follows task-23-brief.md's list; scenario 7's
 * api-level half (`claimConnection` cross-user) lives in Task 17's own tests — this file only proves
 * the mailbox.sync side: a `pending_claim` connection is invisible to sync's own lease claim, so an
 * unclaimed account-linking attempt never gets its mail touched at all.
 */
import { randomBytes } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import pg from 'pg'
import type PgBoss from 'pg-boss'
import pino from 'pino'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { encrypt, hashToken, loadKekRing, type KekRing } from '@aesa/crypto'
import {
  agents, ensureDefaultCategories, loadOrgDek, mailboxConnections, mailboxCredentials, messages,
  notificationDevices, notifications, orgSettings, provisionOrgKeys, tickets, usageCounters, user,
  withOrg, withPlatform, workspaces,
} from '@aesa/db'
import { createDb } from '@aesa/db/raw'
import { createTestDatabase, createTestOrganization } from '@aesa/db/testing'
import { createFakeProvider } from '@aesa/llm'
import { createMailLimiter, createMockMailbox, type MockMailbox } from '@aesa/mail'
import { enqueue, JOB_NAMES, startBoss } from '@aesa/queue'
import type { WorkerConfig } from '../src/config.ts'
import { runMailboxPollSweep } from '../src/jobs/mailbox-poll-sweep.ts'
import { mailboxSyncJob, registerMailboxSync, type MailboxSyncDeps } from '../src/jobs/mailbox-sync.ts'
import { enqueueNotifyDispatch, registerNotifyDispatch, type NotifyDispatchDeps } from '../src/jobs/notify-dispatch.ts'
import { registerTicketTriage, ticketTriageJob, type TicketTriageDeps } from '../src/jobs/ticket-triage.ts'
import type { PushMessage, SendPush } from '../src/push.ts'

const rand = () => randomBytes(4).toString('hex')
const DB_URL = process.env.DATABASE_URL ?? 'postgres://aesa:aesa@localhost:5434/aesa_dev'
const SCHEMA = `pgboss_e2e_${randomBytes(4).toString('hex')}`

/** Every triage call in this file resolves to the same plain, non-escalating verdict — none of the
 * nine scenarios needs a DIFFERENT one (tripwire/cap escalate before the model is ever called). */
const BASE_VERDICT = {
  categoryKey: 'order_status',
  language: 'en',
  sentiment: 'neutral' as const,
  isSpam: false,
  isAutomated: false,
  escalationFlags: [] as ('legal_threat' | 'chargeback_threat' | 'injury' | 'recall_mention')[],
  questions: ['Where is my order?'],
}

/** vitest's own waitFor, tuned for pg-boss's ~2s default poll cadence with headroom for a 2-3 hop chain. */
function waitFor<T>(fn: () => T | Promise<T>): Promise<T> {
  return vi.waitFor(fn, { timeout: 20_000, interval: 200 })
}

function baseConfig(): WorkerConfig {
  return {
    env: 'test',
    databaseUrl: 'unused',
    roles: new Set(['sync']),
    kekRing: null,
    logLevel: 'silent',
    anthropicApiKey: null,
    gmailOauth: { clientId: 'gmail-client', clientSecret: { expose: () => 'gmail-secret' } as never },
    msOauth: { clientId: 'ms-client', clientSecret: { expose: () => 'ms-secret' } as never },
    gmailPubsubTopic: null,
    webhookPublicUrl: null,
    mail: { transport: 'devsink', from: 'aesa <onboarding@resend.dev>' },
    appBaseUrl: null,
    appWebOrigin: null,
    voyageApiKey: null,
    knowledgeEmbedModel: 'voyage-4',
    knowledgeRerank: false,
    s3: null,
    platformSender: 'no-reply@aesa.test',
  }
}

describe('Phase 2 close-out E2E (real pg-boss)', () => {
  let t: Awaited<ReturnType<typeof createTestDatabase>>
  let app: ReturnType<typeof createDb>
  let boss: PgBoss
  let userId: string
  const ring: KekRing = loadKekRing({ AESA_KEK_V1: randomBytes(32).toString('base64'), AESA_KEK_ACTIVE: '1' })
  const mailboxesByAddress = new Map<string, MockMailbox>()
  const llmProvider = createFakeProvider([{ parsed: BASE_VERDICT }])
  const pushCalls: PushMessage[] = []
  const push: SendPush = async (msg) => {
    pushCalls.push(msg)
    return { ok: true, invalidTokens: [] }
  }

  beforeAll(async () => {
    t = await createTestDatabase()
    app = createDb(t.url)
    boss = await startBoss(DB_URL, SCHEMA)
    const [u] = await app.db.insert(user).values({ name: 'Owner', email: `owner-${rand()}@example.com` }).returning()
    userId = u!.id

    const syncDeps: MailboxSyncDeps = {
      db: app.db,
      ring,
      config: baseConfig(),
      limiter: createMailLimiter(),
      logger: pino({ level: 'silent' }),
      clientFactory: (_provider, _accessToken, addr) => mailboxesByAddress.get(addr)!,
    }
    await registerMailboxSync(boss, syncDeps)

    const triageDeps: TicketTriageDeps = {
      db: app.db,
      provider: llmProvider,
      logger: pino({ level: 'silent' }),
      enqueueNotify: (orgId, notificationId) => enqueueNotifyDispatch(boss, orgId, notificationId),
    }
    await registerTicketTriage(boss, triageDeps)

    const dispatchDeps: NotifyDispatchDeps = { db: app.db, push, logger: pino({ level: 'silent' }) }
    await registerNotifyDispatch(boss, dispatchDeps)
  })

  afterAll(async () => {
    await boss.stop({ graceful: false, wait: true })
    const admin = new pg.Client({ connectionString: DB_URL })
    await admin.connect()
    await admin.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`)
    await admin.end()
    await app.pool.end()
    await t.drop()
  })

  // ---- fixtures -----------------------------------------------------------

  async function createOrg(): Promise<string> {
    const orgId = await createTestOrganization(app)
    await withOrg(app.db, orgId, (tx) => tx.insert(workspaces).values({ orgId, businessName: 'Acme', timezone: 'UTC' }))
    await withOrg(app.db, orgId, async (tx) => {
      await provisionOrgKeys(tx, ring)
      await ensureDefaultCategories(tx)
    })
    return orgId
  }

  async function createConnection(
    orgId: string,
    dbProvider: 'gmail' | 'microsoft' = 'gmail',
    status: 'connected' | 'pending_claim' = 'connected',
  ): Promise<{ connectionId: string; selfAddress: string }> {
    const selfAddress = `support-${rand()}@acme.test`
    const [conn] = await withOrg(app.db, orgId, (tx) =>
      tx
        .insert(mailboxConnections)
        .values({ orgId, provider: dbProvider, providerAccountId: `acct-${rand()}`, emailAddress: selfAddress, status, connectedByUserId: userId })
        .returning(),
    )
    if (status === 'connected') {
      await withOrg(app.db, orgId, (tx) =>
        tx.insert(agents).values({ orgId, connectionId: conn!.id, address: selfAddress, domain: selfAddress.split('@')[1]!, displayName: 'Support', status: 'active' }),
      )
    }
    return { connectionId: conn!.id, selfAddress }
  }

  /** A FRESH access token — getAccessToken returns it straight from the row, never calling `.refresh()`
   * (same convention as mailbox-sync.test.ts: no real network adapter is ever exercised). */
  async function seedCredential(orgId: string, connectionId: string): Promise<void> {
    const { dek, version } = await withOrg(app.db, orgId, (tx) => loadOrgDek(tx, ring))
    const refreshToken = `refresh-${rand()}`
    const aad = `${orgId}:mailbox_credentials:${connectionId}`
    await withPlatform(app.db, 'test:seed', (tx) =>
      tx.insert(mailboxCredentials).values({
        connectionId,
        orgId,
        refreshTokenCiphertext: encrypt(dek, Buffer.from(refreshToken, 'utf8'), aad),
        accessTokenCiphertext: encrypt(dek, Buffer.from(`access-${rand()}`, 'utf8'), aad),
        accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
        refreshTokenHash: hashToken('refresh', refreshToken),
        encryption: 'dek',
        dataKeyVersion: version,
      }),
    )
  }

  function mailboxFor(mode: 'gmail' | 'graph', selfAddress: string): MockMailbox {
    const mailbox = createMockMailbox({ mode, selfAddress })
    mailboxesByAddress.set(selfAddress, mailbox)
    return mailbox
  }

  async function readConnection(orgId: string, connectionId: string) {
    const [row] = await withOrg(app.db, orgId, (tx) => tx.select().from(mailboxConnections).where(eq(mailboxConnections.id, connectionId)))
    return row!
  }

  async function ticketsFor(orgId: string, connectionId: string) {
    return withOrg(app.db, orgId, (tx) => tx.select().from(tickets).where(eq(tickets.connectionId, connectionId)))
  }

  async function messagesFor(orgId: string, connectionId: string) {
    return withOrg(app.db, orgId, (tx) => tx.select().from(messages).where(eq(messages.connectionId, connectionId)))
  }

  async function notificationsForOrg(orgId: string) {
    return withOrg(app.db, orgId, (tx) => tx.select().from(notifications).where(eq(notifications.orgId, orgId)))
  }

  async function usageCountersForOrg(orgId: string) {
    return withOrg(app.db, orgId, (tx) => tx.select().from(usageCounters).where(eq(usageCounters.orgId, orgId)))
  }

  async function seedDevice(orgId: string): Promise<void> {
    await withOrg(app.db, orgId, (tx) =>
      tx.insert(notificationDevices).values({ orgId, userId, expoPushToken: `ExponentPushToken[${rand()}]`, platform: 'ios' }),
    )
  }

  async function triggerSync(orgId: string, connectionId: string): Promise<string | null> {
    return enqueue(boss, mailboxSyncJob, { orgId, connectionId }, { entityId: connectionId })
  }

  /** Raw read of THIS run's own pg-boss schema — never `pgboss_test` (see file header). */
  async function queueRows(queueName: string): Promise<{ id: string; data: unknown; state: string }[]> {
    const c = new pg.Client({ connectionString: DB_URL })
    await c.connect()
    try {
      const { rows } = await c.query<{ id: string; data: unknown; state: string }>(`SELECT id, data, state FROM "${SCHEMA}".job WHERE name = $1`, [queueName])
      return rows
    } finally {
      await c.end()
    }
  }

  // ---- 1 & 2: happy path + idempotent re-poll (gmail; reused in graph mode by scenario 8) --------

  async function happyPathAndRepoll(dbProvider: 'gmail' | 'microsoft'): Promise<void> {
    const orgId = await createOrg()
    const { connectionId, selfAddress } = await createConnection(orgId, dbProvider)
    await seedCredential(orgId, connectionId)
    const mailbox = mailboxFor(dbProvider === 'gmail' ? 'gmail' : 'graph', selfAddress)

    await triggerSync(orgId, connectionId) // seed-on-null: remembers where to start, ingests nothing
    await waitFor(async () => {
      expect((await readConnection(orgId, connectionId)).cursor).not.toBeNull()
    })

    mailbox.receiveInbound({ from: `customer-${rand()}@example.test`, to: [selfAddress], subject: 'Where is my order?', bodyText: 'It has been a week.' })
    await triggerSync(orgId, connectionId)

    // 1. new -> triaged, through mailbox.sync's own enqueue of ticket.triage.
    const ticket = await waitFor(async () => {
      const rows = await ticketsFor(orgId, connectionId)
      expect(rows).toHaveLength(1)
      expect(rows[0]!.status).toBe('triaged')
      return rows[0]!
    })
    expect(ticket.categoryId).not.toBeNull()
    expect(ticket.language).toBe(BASE_VERDICT.language)
    expect(ticket.triageQuestions).toEqual(BASE_VERDICT.questions)

    // 2. a re-poll of the SAME history adds nothing anywhere.
    const before = {
      messages: (await messagesFor(orgId, connectionId)).length,
      tickets: (await ticketsFor(orgId, connectionId)).length,
      notifications: (await notificationsForOrg(orgId)).length,
      usage: await usageCountersForOrg(orgId),
      lastSuccessAt: (await readConnection(orgId, connectionId)).lastSuccessAt!.getTime(),
    }
    await triggerSync(orgId, connectionId)
    await waitFor(async () => {
      const after = await readConnection(orgId, connectionId)
      expect(after.lastSuccessAt!.getTime()).toBeGreaterThan(before.lastSuccessAt)
    })
    expect((await messagesFor(orgId, connectionId)).length).toBe(before.messages)
    expect((await ticketsFor(orgId, connectionId)).length).toBe(before.tickets)
    expect((await notificationsForOrg(orgId)).length).toBe(before.notifications)
    const afterUsage = await usageCountersForOrg(orgId)
    expect(afterUsage).toHaveLength(before.usage.length)
    expect(afterUsage.map((r) => r.value)).toEqual(before.usage.map((r) => r.value))
  }

  it(
    '1 & 2. gmail: inbound -> new -> ticket.triage -> triaged with category/language/questions persisted; a re-poll of the same history adds nothing',
    async () => {
      await happyPathAndRepoll('gmail')
    },
    30_000,
  )

  // ---- 3: tripwire mail escalates and the escalation push is marked sent -------------------------

  it(
    '3. tripwire mail -> needs_owner + a notifications row, notify.dispatch marks it sent, escalation_notified_at stamped',
    async () => {
      const orgId = await createOrg()
      await seedDevice(orgId)
      const { connectionId, selfAddress } = await createConnection(orgId)
      await seedCredential(orgId, connectionId)
      const mailbox = mailboxFor('gmail', selfAddress)

      await triggerSync(orgId, connectionId)
      await waitFor(async () => {
        expect((await readConnection(orgId, connectionId)).cursor).not.toBeNull()
      })

      mailbox.receiveInbound({
        from: `angry-${rand()}@example.test`,
        to: [selfAddress],
        subject: 'Lawsuit incoming',
        bodyText: 'I am contacting my lawyer — we will sue you over this.',
      })
      await triggerSync(orgId, connectionId)

      const ticket = await waitFor(async () => {
        const rows = await ticketsFor(orgId, connectionId)
        expect(rows).toHaveLength(1)
        expect(rows[0]!.status).toBe('needs_owner')
        expect(rows[0]!.needsOwnerReason).toBe('tripwire')
        return rows[0]!
      })

      const notification = await waitFor(async () => {
        const rows = await notificationsForOrg(orgId)
        expect(rows).toHaveLength(1)
        expect(rows[0]!.status).toBe('sent')
        return rows[0]!
      })
      expect(notification.kind).toBe('escalation')
      expect(pushCalls.some((m) => (m.data as { ticketId?: string } | undefined)?.ticketId === ticket.id)).toBe(true)

      const after = await withOrg(app.db, orgId, (tx) => tx.select().from(tickets).where(eq(tickets.id, ticket.id)))
      expect(after[0]!.escalationNotifiedAt).not.toBeNull()

      // ticket.triage must never touch a tripwired ticket — the LLM is never invoked for it.
      expect(llmProvider.calls.every((c) => c.meta.idempotencyKey !== `ticket-triage:${ticket.id}`)).toBe(true)
    },
    30_000,
  )

  // ---- 4: the daily triage cap escalates once; poll-sweep's next-day path re-enqueues it ---------

  it(
    "4. triage cap (cap 1): a second ticket -> needs_owner/triage_cap once; poll-sweep's rewound now() re-enqueues it, re-capping in place with no duplicate",
    async () => {
      const orgId = await createOrg()
      await seedDevice(orgId)
      const { connectionId } = await createConnection(orgId)
      await withOrg(app.db, orgId, (tx) => tx.insert(orgSettings).values({ orgId, key: 'triage.daily_cap', value: 1 }))

      async function seedNewTicket(): Promise<string> {
        const [row] = await withOrg(app.db, orgId, (tx) =>
          tx.insert(tickets).values({ orgId, connectionId, providerThreadId: `thread-${rand()}`, status: 'new' }).returning({ id: tickets.id }),
        )
        return row!.id
      }
      async function readTicket(ticketId: string) {
        const [row] = await withOrg(app.db, orgId, (tx) => tx.select().from(tickets).where(eq(tickets.id, ticketId)))
        return row!
      }
      const capNotifications = () =>
        withOrg(app.db, orgId, (tx) => tx.select().from(notifications).where(and(eq(notifications.orgId, orgId), eq(notifications.kind, 'escalation'))))

      const ticketA = await seedNewTicket()
      const ticketB = await seedNewTicket()

      await enqueue(boss, ticketTriageJob, { orgId, ticketId: ticketA }, { entityId: ticketA })
      await waitFor(async () => {
        expect((await readTicket(ticketA)).status).toBe('triaged') // consumes the day's one allowed call
      })

      await enqueue(boss, ticketTriageJob, { orgId, ticketId: ticketB }, { entityId: ticketB })
      await waitFor(async () => {
        const b = await readTicket(ticketB)
        expect(b.status).toBe('needs_owner')
        expect(b.needsOwnerReason).toBe('triage_cap')
      })
      expect(await capNotifications()).toHaveLength(1)

      // The poll-sweep's own injectable now() (job registrars' deps), rewound a day forward, is what
      // makes the cap re-entry's `COALESCE(last_triaged_at, updated_at) < today-start` predicate match
      // ticketB — simulating "the next day" without touching wall-clock time or the notification row.
      const tomorrow = new Date(Date.now() + 24 * 60 * 60_000)
      const before = await queueRows(JOB_NAMES.ticketTriage)
      await runMailboxPollSweep(boss, { db: app.db, logger: pino({ level: 'silent' }), now: () => tomorrow })

      const freshJobId = await waitFor(async () => {
        const rows = await queueRows(JOB_NAMES.ticketTriage)
        const fresh = rows.find((r) => !before.some((b) => b.id === r.id) && (r.data as { ticketId?: string }).ticketId === ticketB)
        expect(fresh).toBeDefined()
        return fresh!.id
      })
      await waitFor(async () => {
        const rows = await queueRows(JOB_NAMES.ticketTriage)
        expect(rows.find((r) => r.id === freshJobId)?.state).toBe('completed')
      })

      // Task 15's ruling: the re-run re-caps in place through the SAME-status guarded write — no
      // duplicate notification, ticket stays needs_owner/triage_cap.
      expect(await capNotifications()).toHaveLength(1)
      const finalB = await readTicket(ticketB)
      expect(finalB.status).toBe('needs_owner')
      expect(finalB.needsOwnerReason).toBe('triage_cap')
    },
    30_000,
  )

  // ---- 5: a per-sender flood folds onto the newest ticket after 5, connection-scoped -------------

  it('5. 6 DMARC-pass inbounds from one sender -> 5 tickets, the 6th message folded', async () => {
    const orgId = await createOrg()
    const { connectionId, selfAddress } = await createConnection(orgId)
    await seedCredential(orgId, connectionId)
    const mailbox = mailboxFor('gmail', selfAddress)

    await triggerSync(orgId, connectionId)
    await waitFor(async () => {
      expect((await readConnection(orgId, connectionId)).cursor).not.toBeNull()
    })

    const flooder = `flood-${rand()}@example.test`
    for (let i = 0; i < 6; i += 1) {
      mailbox.receiveInbound({ from: flooder, to: [selfAddress], subject: `Order ${i}`, bodyText: 'help' }) // default authenticationResults: DMARC pass
    }
    await triggerSync(orgId, connectionId)

    await waitFor(async () => {
      expect(await messagesFor(orgId, connectionId)).toHaveLength(6)
    })
    const finalTickets = await ticketsFor(orgId, connectionId)
    expect(finalTickets).toHaveLength(5)
    const finalMessages = await messagesFor(orgId, connectionId)
    expect(new Set(finalMessages.map((m) => m.ticketId)).size).toBe(5) // the 6th joined an existing ticket
  }, 20_000)

  // ---- 6: an expired cursor triggers a bounded resync; no reopen storm --------------------------

  it(
    '6. an expired cursor mid-stream triggers a bounded resync: a quiet resolved ticket stays resolved, a busy one reopens, the cursor advances',
    async () => {
      const orgId = await createOrg()
      const { connectionId, selfAddress } = await createConnection(orgId)
      await seedCredential(orgId, connectionId)
      const mailbox = mailboxFor('gmail', selfAddress)

      await triggerSync(orgId, connectionId)
      await waitFor(async () => {
        expect((await readConnection(orgId, connectionId)).cursor).not.toBeNull()
      })

      const customerQuiet = `quiet-${rand()}@example.test`
      const customerBusy = `busy-${rand()}@example.test`
      mailbox.receiveInbound({ from: customerQuiet, to: [selfAddress], subject: 'Quiet thread', bodyText: 'hi' })
      const busySeed = mailbox.receiveInbound({ from: customerBusy, to: [selfAddress], subject: 'Busy thread', bodyText: 'hi' })
      await triggerSync(orgId, connectionId)

      const { quietId, busyId } = await waitFor(async () => {
        const rows = await ticketsFor(orgId, connectionId)
        expect(rows).toHaveLength(2)
        const quiet = rows.find((r) => r.subject === 'Quiet thread')
        const busy = rows.find((r) => r.subject === 'Busy thread')
        expect(quiet).toBeDefined()
        expect(busy).toBeDefined()
        return { quietId: quiet!.id, busyId: busy!.id }
      })
      await withOrg(app.db, orgId, (tx) => tx.update(tickets).set({ status: 'resolved' }).where(eq(tickets.id, quietId)))
      await withOrg(app.db, orgId, (tx) => tx.update(tickets).set({ status: 'resolved' }).where(eq(tickets.id, busyId)))

      // A follow-up that dropped every agent address from its headers — invisible to the resync's
      // address window, reachable only through the known-ticket thread re-walk (packages/mail/src/sync.ts).
      mailbox.receiveInbound({
        from: customerBusy,
        to: [`someone-else-${rand()}@acme.test`],
        subject: 'Re: Busy thread',
        bodyText: 'still waiting',
        threadId: busySeed.threadId,
      })
      // A brand-new conversation the address window must still sweep up.
      mailbox.receiveInbound({ from: `fresh-${rand()}@example.test`, to: [selfAddress], subject: 'Fresh', bodyText: 'hello' })

      const beforeConn = await readConnection(orgId, connectionId)
      mailbox.expireCursor()
      await triggerSync(orgId, connectionId)

      await waitFor(async () => {
        const rows = await ticketsFor(orgId, connectionId)
        expect(rows).toHaveLength(3)
        const quiet = rows.find((r) => r.id === quietId)!
        const busy = rows.find((r) => r.id === busyId)!
        const fresh = rows.find((r) => r.subject === 'Fresh')
        expect(quiet.status).toBe('resolved') // nothing new on this thread -> no reopen storm
        expect(busy.status).toBe('new') // a genuinely new inbound DOES reopen
        expect(fresh?.status).toBe('new')
      })
      const afterConn = await readConnection(orgId, connectionId)
      expect(afterConn.resyncState).toBeNull()
      expect(JSON.stringify(afterConn.cursor)).not.toBe(JSON.stringify(beforeConn.cursor))
    },
    20_000,
  )

  // ---- 7: a pending_claim connection is invisible to sync entirely -------------------------------

  it("7. a pending_claim connection (account-linking not yet completed) is skipped by sync's own lease claim", async () => {
    const orgId = await createOrg()
    const { connectionId } = await createConnection(orgId, 'gmail', 'pending_claim')

    const jobId = await triggerSync(orgId, connectionId)
    expect(jobId).not.toBeNull()
    await waitFor(async () => {
      const rows = await queueRows(JOB_NAMES.mailboxSync)
      expect(rows.find((r) => r.id === jobId)?.state).toBe('completed')
    })

    const after = await readConnection(orgId, connectionId)
    expect(after.status).toBe('pending_claim') // untouched — claimLease's WHERE requires status='connected'
    expect(after.pollLeaseUntil).toBeNull()
    expect(after.lastSyncAt).toBeNull() // the client was never even built
    expect(await ticketsFor(orgId, connectionId)).toHaveLength(0)
  }, 20_000)

  // ---- 8: graph-mode pass of scenarios 1-2 -------------------------------------------------------

  it('8. graph mode: the same happy path and idempotent re-poll, through the Graph-shaped mock', async () => {
    await happyPathAndRepoll('microsoft')
  }, 30_000)

  // ---- 9: a poisoned ticket.triage payload dead-letters without retries -------------------------

  it('9. a schema-invalid ticket.triage payload (raw boss.send) is deleted outright — no retries, no handler call', async () => {
    const callsBefore = llmProvider.calls.length
    const jobId = await boss.send(JOB_NAMES.ticketTriage, { orgId: 123, ticketId: 456 })
    expect(jobId).not.toBeNull()

    await waitFor(async () => {
      const rows = await queueRows(JOB_NAMES.ticketTriage)
      expect(rows.some((r) => r.id === jobId)).toBe(false) // deleteJob, not a 'failed' row (Task 1's rule)
    })
    expect(llmProvider.calls.length).toBe(callsBefore) // the handler was never invoked
  }, 15_000)
})
