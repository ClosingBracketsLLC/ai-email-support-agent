/**
 * Phase 3 close-out: the spec's Phase-3 verification scenarios driven end-to-end through REAL
 * pg-boss jobs (`enqueue`/`boss.send` -> `registerJob`'s real work loop) and the REAL api draft
 * service (`@aesa/api/drafts`, wired to `createApiFacade`/`createEnqueue` from `@aesa/api/deps`),
 * so an owner's Approve/Reject genuinely runs the shipped gate and genuinely enqueues the shipped
 * `send.execute`. The unit suites (`ticket-draft.test.ts`, `send-execute.test.ts`,
 * `agent-sandbox.test.ts`, `ticket-backstop-sweep.test.ts`, `digest-email.test.ts`) own the
 * branch-by-branch rules; this file exists to prove the WIRING between them.
 *
 * Shape ported from `e2e-phase2.test.ts`: one throwaway database (`createTestDatabase`) for every
 * business table, one pg-boss instance on the shared dev `DATABASE_URL` under a schema unique to
 * THIS run (`pgboss_e2e_<hex>`, dropped in `afterAll`) — never `pgboss_test`, which other spec
 * files poll concurrently. `createMockMailbox` (`@aesa/mail`) is plugged into `mailbox.sync` AND
 * `send.execute` through their `clientFactory` seams, mapped by the connection's own self-address;
 * a `createFakeProvider` (`@aesa/llm`) wrapped in the real `withMetering`/`createMeterSink` pair
 * stands in for every model call (so `llm_calls` rows are real); a recording stub replaces
 * `notify.dispatch`'s `SendPush`. Scenario numbering follows task-23-brief.md's list.
 *
 * THREE harness-level clock/queue adjustments, all of them arrangement rather than assertion:
 *
 *  1. **The send job's clock runs `SEND_CLOCK_SKEW_MS` (16 s) ahead of the wall clock.** An approve
 *     writes `outbound_sends.send_after = now + APPROVE_UNDO_SECONDS` and enqueues `send.execute`
 *     with that `startAfter`, so the real undo window is genuinely 15 s of wall time. Rather than
 *     sleep it out in eight scenarios, the registered job reads a clock 16 s ahead — exactly the
 *     brief's "pass send_after by rewinding `now` on the job" — and each scenario triggers the run
 *     itself with a plain `boss.send` (no singleton key) once its arrangement is in place. The
 *     approve's OWN delayed job still exists and still fires 15 s later; by then the row is `sent`,
 *     `held` or `failed` and it is correctly unclaimable, which is itself part of what this proves.
 *  2. **`retryDelay` is shortened to 1 s** on `ticket.draft` and `send.execute` (`boss.updateQueue`
 *     after registration). Scenarios 5, 12 and 13 turn on pg-boss ACTUALLY retrying a rejected
 *     handler; the production 30 s backoff would make the file take minutes. Nothing else about the
 *     retry (limit, the claim-horizon collapse, the marker rescan) is touched.
 *  3. **Scenario 2's hand-back is a direct write.** No Phase 3 product path returns an
 *     `awaiting_review` ticket that still has a LIVE draft to `triaged` (a reject rejects its draft,
 *     a stale send fails it, a completed send sends it), so the supersede branch is arranged the way
 *     `ticket-draft.test.ts`'s own 14b case arranges it. The second inbound itself is real, ingested
 *     by the real sync walk.
 */
import { randomBytes } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import pg from 'pg'
import type PgBoss from 'pg-boss'
import pino from 'pino'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { emptyRetriever, type DraftDecision } from '@aesa/agent'
import { approveDraft, holdDraft, markViewed, rejectDraft, type DraftActor, type DraftServiceDeps } from '@aesa/api/drafts'
import { createApiFacade, createEnqueue } from '@aesa/api/deps'
import { INVARIANTS } from '@aesa/core'
import { encrypt, hashToken, loadKekRing, Secret, type KekRing } from '@aesa/crypto'
import {
  agentRuns, agents, auditLog, categories, createMeterSink, draftActionTokens, drafts,
  ensureDefaultCategories, llmCalls, loadOrgDek, mailboxConnections, mailboxCredentials, member,
  messages, notificationDevices, notifications, outboundSends, provisionOrgKeys, SEND_METERS,
  tickets, usageCounters, user, withOrg, withPlatform, workspaces,
} from '@aesa/db'
import { createDb } from '@aesa/db/raw'
import { createTestDatabase, createTestOrganization } from '@aesa/db/testing'
import { createFakeProvider, LlmError, withMetering, type FakeScript, type LlmProvider } from '@aesa/llm'
import {
  createMailLimiter, createMockMailbox, MARKER_HEADER, type MailboxProvider, type MockMailbox,
} from '@aesa/mail'
import { createDevSink } from '@aesa/platform-mail'
import { enqueue, JOB_NAMES, startBoss } from '@aesa/queue'
import type { WorkerConfig } from '../src/config.ts'
import { runDigestEmailForOrg } from '../src/digest-email.ts'
import { agentSandboxJob, registerAgentSandbox } from '../src/jobs/agent-sandbox.ts'
import { mailboxSyncJob, registerMailboxSync } from '../src/jobs/mailbox-sync.ts'
import { enqueueNotifyDispatch, registerNotifyDispatch } from '../src/jobs/notify-dispatch.ts'
import { registerSendExecute, type SendExecuteDeps } from '../src/jobs/send-execute.ts'
import { ORPHAN_AFTER_MINUTES, runTicketBackstopSweep } from '../src/jobs/ticket-backstop-sweep.ts'
import { enqueueTicketDraft, registerTicketDraft, ticketDraftJob } from '../src/jobs/ticket-draft.ts'
import { registerTicketTriage } from '../src/jobs/ticket-triage.ts'
import { maybeRegisterSendRole } from '../src/send-role.ts'
import type { PushMessage, SendPush } from '../src/push.ts'

const rand = () => randomBytes(4).toString('hex')
const DB_URL = process.env.DATABASE_URL ?? 'postgres://aesa:aesa@localhost:5434/aesa_dev'
const SCHEMA = `pgboss_e2e_${randomBytes(4).toString('hex')}`
const CUSTOMER_DOMAIN = 'example.test'

/** See the file header, note 1. */
const SEND_CLOCK_SKEW_MS = 16_000

/** Every triage call in this file resolves to the same plain, non-escalating verdict. */
const BASE_VERDICT = {
  categoryKey: 'order_status',
  language: 'en',
  sentiment: 'neutral' as const,
  isSpam: false,
  isAutomated: false,
  escalationFlags: [] as ('legal_threat' | 'chargeback_threat' | 'injury' | 'recall_mention')[],
  questions: ['Where is my order?'],
}

/** Passes every guardrail screen: no markup, no link, no address, no number, no promise token. */
const CLEAN_BODY = 'Thanks for getting in touch. I have checked the details you gave us and everything looks correct on our side.'
/** Clean except for one link to acme.test — allowed in a workspace that lists that host, a hard
 *  `url_not_allowed` failure in one that does not. */
const LINK_BODY = 'Thanks for getting in touch. The details you need are at https://acme.test/help and everything there stays current.'

const REPLY: DraftDecision = {
  outcome: 'reply',
  categoryKey: 'order_status',
  body: CLEAN_BODY,
  confidence: 0.82,
  citedChunkIds: [],
  usedAnswerIds: [],
  memoryConflictIds: [],
  unresolvedQuestions: [],
  customerLanguage: 'en',
  rationale: 'The customer asked where the order is; the thread has the answer.',
}
const reply = (over: Partial<Extract<DraftDecision, { outcome: 'reply' }>> = {}): DraftDecision => ({ ...REPLY, ...over })
const NO_REPLY: DraftDecision = { outcome: 'no_reply', reason: 'already_answered', rationale: 'Nothing new was asked.' }

/** vitest's own waitFor, tuned for pg-boss's ~2 s poll cadence with headroom for a 3-4 hop chain. */
function waitFor<T>(fn: () => T | Promise<T>): Promise<T> {
  return vi.waitFor(fn, { timeout: 25_000, interval: 200 })
}

/** Never actually reached: every fixture seeds a FRESH access token, so `getAccessToken` returns
 *  straight from the row without calling `.refresh()`, and the client always comes from
 *  `clientFactory`. */
function stubProvider(): MailboxProvider {
  return {
    kind: 'gmail',
    authorizationUrl: () => { throw new Error('unexpected authorizationUrl()') },
    exchangeCode: () => { throw new Error('unexpected exchangeCode()') },
    refresh: async () => { throw new Error('unexpected refresh()') },
    revoke: async () => {},
    client: () => { throw new Error('unexpected client()') },
  } as unknown as MailboxProvider
}

interface Org {
  orgId: string
  connectionId: string
  agentId: string
  categoryId: string
  selfAddress: string
  domain: string
  mailbox: MockMailbox
  ownerUserId: string
  ownerEmail: string
}

describe('Phase 3 close-out E2E (real pg-boss + the real api draft service)', () => {
  let t: Awaited<ReturnType<typeof createTestDatabase>>
  let app: ReturnType<typeof createDb>
  let boss: PgBoss
  let service: DraftServiceDeps
  const logger = pino({ level: 'silent' })
  const ring: KekRing = loadKekRing({ AESA_KEK_V1: randomBytes(32).toString('base64'), AESA_KEK_ACTIVE: '1' })
  const mailboxesByAddress = new Map<string, MockMailbox>()
  const pushCalls: PushMessage[] = []
  const sentEvents: { orgId: string; ticketId: string; draftId: string }[] = []

  /** The draft-role script queue. `scriptDraft` rewrites the tail from the CURRENT call index, so
   *  each scenario's scripts are consumed by that scenario's own calls regardless of how many draft
   *  calls ran before it (`createFakeProvider` advances a per-role index and repeats the last
   *  script once a queue is exhausted). */
  const draftScripts: FakeScript[] = []
  const fake = createFakeProvider([], { byRole: { triage: [{ parsed: BASE_VERDICT }], draft: draftScripts } })
  let provider: LlmProvider

  function scriptDraft(...scripts: FakeScript[]): void {
    const at = fake.callsFor('draft').length
    draftScripts.length = at
    draftScripts.push(...scripts)
  }
  const draftCallCount = () => fake.callsFor('draft').length

  const push: SendPush = async (msg) => {
    pushCalls.push(msg)
    return { ok: true, invalidTokens: [] }
  }

  function sendConfig(): WorkerConfig {
    return {
      env: 'test',
      databaseUrl: 'unused',
      roles: new Set(['send']),
      kekRing: ring,
      logLevel: 'silent',
      anthropicApiKey: null,
      gmailOauth: { clientId: 'gmail-client', clientSecret: new Secret('gmail-secret') },
      msOauth: { clientId: 'ms-client', clientSecret: new Secret('ms-secret') },
      gmailPubsubTopic: null,
      webhookPublicUrl: null,
      mail: { transport: 'devsink', from: 'aesa <onboarding@resend.dev>' },
      appBaseUrl: 'https://api.test',
      appWebOrigin: 'https://app.test',
      platformSender: 'no-reply@aesa.test',
    }
  }

  beforeAll(async () => {
    t = await createTestDatabase()
    app = createDb(t.url)
    boss = await startBoss(DB_URL, SCHEMA)
    // The REAL metering wrapper around the fake: every model call becomes a real `llm_calls` row
    // and real `usage_counters` bumps, which is what scenario 1 reads back.
    provider = withMetering(fake, createMeterSink(app.db), { cacheTtl: '1h' })
    const limiter = createMailLimiter()
    const clientFactory = (_provider: 'gmail' | 'microsoft', _token: string, addr: string) => mailboxesByAddress.get(addr)!

    await registerMailboxSync(boss, {
      db: app.db, ring, config: sendConfig(), limiter, logger, clientFactory,
    })
    await registerTicketTriage(boss, {
      db: app.db, provider, logger,
      enqueueNotify: (orgId, notificationId) => enqueueNotifyDispatch(boss, orgId, notificationId),
      enqueueDraft: (orgId, ticketId) => enqueueTicketDraft(boss, orgId, ticketId),
    })
    await registerTicketDraft(boss, {
      db: app.db, provider, retriever: emptyRetriever, logger,
      enqueueNotify: (orgId, notificationId) => enqueueNotifyDispatch(boss, orgId, notificationId),
      enqueueDraft: (orgId, ticketId, opts) => enqueueTicketDraft(boss, orgId, ticketId, opts),
    })
    await registerAgentSandbox(boss, { db: app.db, provider, retriever: emptyRetriever, logger })
    await registerNotifyDispatch(boss, { db: app.db, push, logger })
    // The production role gate, with only the client/provider/clock seams swapped in through its
    // own `register` argument — `maybeRegisterSendRole`'s ring/OAuth checks still run for real.
    await maybeRegisterSendRole(
      {
        boss, db: app.db, config: sendConfig(), limiter, logger,
        enqueueNotify: (orgId, notificationId) => enqueueNotifyDispatch(boss, orgId, notificationId),
        enqueueDraft: (orgId, ticketId) => enqueueTicketDraft(boss, orgId, ticketId),
      },
      (b, deps: SendExecuteDeps) =>
        registerSendExecute(b, {
          ...deps,
          clientFactory,
          providerFactory: () => stubProvider(),
          onSent: async (p) => void sentEvents.push(p),
          now: () => new Date(Date.now() + SEND_CLOCK_SKEW_MS),
        }),
    )

    // See the file header, note 2 — retry CADENCE only; the limits and the recovery paths are the
    // shipped ones.
    await boss.updateQueue(JOB_NAMES.ticketDraft, {
      name: JOB_NAMES.ticketDraft, policy: 'standard',
      retryLimit: 1, retryDelay: 1, retryBackoff: false, expireInSeconds: INVARIANTS.DRAFT_JOB_EXPIRE_SECONDS,
    })
    await boss.updateQueue(JOB_NAMES.sendExecute, {
      name: JOB_NAMES.sendExecute, policy: 'standard',
      retryLimit: 5, retryDelay: 1, retryBackoff: false, expireInSeconds: INVARIANTS.SEND_QUEUE_EXPIRE_SECONDS,
    })

    service = { api: createApiFacade({ db: app.db, pool: app.pool }), enqueue: createEnqueue(boss), logger }
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

  async function createOrg(opts: { mode?: 'gmail' | 'graph'; domain?: string; allowedUrlHosts?: string[] } = {}): Promise<Org> {
    const mode = opts.mode ?? 'gmail'
    const domain = opts.domain ?? 'acme.test'
    const orgId = await createTestOrganization(app)
    const ownerEmail = `owner-${rand()}@example.com`
    const [owner] = await app.db.insert(user).values({ name: 'Owner', email: ownerEmail }).returning({ id: user.id })
    await app.db.insert(member).values({ organizationId: orgId, userId: owner!.id, role: 'owner' })
    const selfAddress = `support-${rand()}@${domain}`

    const base = await withOrg(app.db, orgId, async (tx) => {
      await tx.insert(workspaces).values({
        orgId, businessName: 'Acme Dog Supplies', timezone: 'UTC', locale: 'en',
        description: 'Acme sells dog beds, leads and bowls online.',
        allowedUrlHosts: opts.allowedUrlHosts ?? [domain], allowedEmailDomains: [domain],
        operatingGuidance: 'Always confirm the order number before quoting a delivery window.',
        agentEnabled: true,
      })
      await provisionOrgKeys(tx, ring)
      await ensureDefaultCategories(tx)
      const [conn] = await tx
        .insert(mailboxConnections)
        .values({
          orgId, provider: mode === 'gmail' ? 'gmail' : 'microsoft', providerAccountId: `acct-${rand()}`,
          emailAddress: selfAddress, status: 'connected', connectedByUserId: owner!.id,
        })
        .returning({ id: mailboxConnections.id })
      const [agent] = await tx
        .insert(agents)
        .values({
          orgId, connectionId: conn!.id, address: selfAddress, domain, displayName: 'Acme Support',
          status: 'active', priority: 0, signature: 'Acme Support',
          guidanceExtra: 'Keep replies to three sentences where you can.',
        })
        .returning({ id: agents.id })
      await tx.insert(notificationDevices).values({
        orgId, userId: owner!.id, expoPushToken: `ExponentPushToken[${rand()}]`, platform: 'ios',
      })
      const cats = await tx.select({ id: categories.id, key: categories.key }).from(categories)
      return { connectionId: conn!.id, agentId: agent!.id, categoryId: cats.find((c) => c.key === 'order_status')!.id }
    })

    await seedCredential(orgId, base.connectionId)
    const mailbox = createMockMailbox({ mode, selfAddress })
    mailboxesByAddress.set(selfAddress, mailbox)
    const org: Org = { orgId, ...base, selfAddress, domain, mailbox, ownerUserId: owner!.id, ownerEmail }

    // Seed-on-null: the first sync remembers where to start and ingests nothing.
    await triggerSync(org)
    await waitFor(async () => {
      expect((await readConnection(org)).cursor).not.toBeNull()
    })
    return org
  }

  /** A FRESH access token — `getAccessToken` returns it straight from the row, never calling
   *  `.refresh()`, so no real network adapter is ever exercised. */
  async function seedCredential(orgId: string, connectionId: string): Promise<void> {
    const { dek, version } = await withOrg(app.db, orgId, (tx) => loadOrgDek(tx, ring))
    const refreshToken = `refresh-${rand()}`
    const aad = `${orgId}:mailbox_credentials:${connectionId}`
    await withPlatform(app.db, 'test:seed', (tx) =>
      tx.insert(mailboxCredentials).values({
        connectionId, orgId,
        refreshTokenCiphertext: encrypt(dek, Buffer.from(refreshToken, 'utf8'), aad),
        accessTokenCiphertext: encrypt(dek, Buffer.from(`access-${rand()}`, 'utf8'), aad),
        accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
        refreshTokenHash: hashToken('refresh', refreshToken),
        encryption: 'dek', dataKeyVersion: version,
      }))
  }

  const triggerSync = (org: Org) => enqueue(boss, mailboxSyncJob, { orgId: org.orgId, connectionId: org.connectionId }, { entityId: org.connectionId })

  async function readConnection(org: Org) {
    const [row] = await withOrg(app.db, org.orgId, (tx) => tx.select().from(mailboxConnections).where(eq(mailboxConnections.id, org.connectionId)))
    return row!
  }
  async function ticketsFor(org: Org) {
    return withOrg(app.db, org.orgId, (tx) => tx.select().from(tickets).where(eq(tickets.orgId, org.orgId)))
  }
  async function getTicket(org: Org, ticketId: string) {
    const [row] = await withOrg(app.db, org.orgId, (tx) => tx.select().from(tickets).where(eq(tickets.id, ticketId)))
    return row!
  }
  async function draftsFor(org: Org, ticketId: string) {
    return withOrg(app.db, org.orgId, (tx) => tx.select().from(drafts).where(eq(drafts.ticketId, ticketId)).orderBy(drafts.version))
  }
  async function getDraft(org: Org, draftId: string) {
    const [row] = await withOrg(app.db, org.orgId, (tx) => tx.select().from(drafts).where(eq(drafts.id, draftId)))
    return row!
  }
  async function sendFor(org: Org, draftId: string) {
    const [row] = await withOrg(app.db, org.orgId, (tx) => tx.select().from(outboundSends).where(eq(outboundSends.draftId, draftId)))
    return row!
  }
  async function runsFor(org: Org, ticketId: string) {
    return withOrg(app.db, org.orgId, (tx) => tx.select().from(agentRuns).where(eq(agentRuns.ticketId, ticketId)).orderBy(agentRuns.startedAt))
  }
  async function messagesFor(org: Org, ticketId: string, direction?: 'inbound' | 'outbound') {
    return withOrg(app.db, org.orgId, (tx) =>
      tx.select().from(messages).where(direction ? and(eq(messages.ticketId, ticketId), eq(messages.direction, direction)) : eq(messages.ticketId, ticketId)))
  }
  async function notificationsFor(org: Org) {
    return withOrg(app.db, org.orgId, (tx) => tx.select().from(notifications).where(eq(notifications.orgId, org.orgId)))
  }
  async function auditRowsFor(org: Org, entityId: string, action: string) {
    return withOrg(app.db, org.orgId, (tx) =>
      tx.select().from(auditLog).where(and(eq(auditLog.entityId, entityId), eq(auditLog.action, action))))
  }
  async function metersFor(org: Org): Promise<Record<string, number>> {
    const rows = await withOrg(app.db, org.orgId, (tx) => tx.select().from(usageCounters).where(eq(usageCounters.orgId, org.orgId)))
    const out: Record<string, number> = {}
    for (const r of rows) out[r.meter] = (out[r.meter] ?? 0) + r.value
    return out
  }
  async function setUsageCounter(org: Org, meter: string, value: number): Promise<void> {
    const day = new Date().toISOString().slice(0, 10)
    await withOrg(app.db, org.orgId, (tx) =>
      tx.insert(usageCounters).values({ orgId: org.orgId, day, meter, value })
        .onConflictDoUpdate({ target: [usageCounters.orgId, usageCounters.day, usageCounters.meter], set: { value } }))
  }

  /** Raw read of THIS run's own pg-boss schema — never `pgboss_test` (see the file header). */
  async function queueRows(queueName: string): Promise<{ id: string; data: unknown; state: string }[]> {
    const c = new pg.Client({ connectionString: DB_URL })
    await c.connect()
    try {
      const { rows } = await c.query<{ id: string; data: unknown; state: string }>(
        `SELECT id, data, state FROM "${SCHEMA}".job WHERE name = $1`, [queueName])
      return rows
    } finally {
      await c.end()
    }
  }

  /**
   * Bounded wait for every matching job row on `queueName` to reach `completed` — the deterministic
   * way to prove a NEGATIVE ("nothing further ran") without a fixed sleep. A job that should never
   * have been enqueued at all still shows up here, is waited on, and then fails the assertion that
   * follows; a slow one is waited for instead of being missed.
   */
  async function waitForJobsCompleted(queueName: string, predicate: (row: { id: string; data: unknown }) => boolean): Promise<number> {
    return waitFor(async () => {
      const rows = (await queueRows(queueName)).filter(predicate)
      expect(rows.length).toBeGreaterThan(0)
      expect(rows.filter((r) => r.state !== 'completed').map((r) => r.state)).toEqual([])
      return rows.length
    })
  }

  const actorFor = (org: Org): DraftActor => ({ userId: org.ownerUserId, actor: `user:${org.ownerUserId}`, source: 'app' })

  /** Inbound -> the real sync walk -> ticket.triage -> ticket.draft, waiting for the live draft. */
  async function inboundToDraft(org: Org, opts: { subject?: string; body?: string; from?: string; threadId?: string } = {}) {
    const from = opts.from ?? `customer-${rand()}@${CUSTOMER_DOMAIN}`
    const received = org.mailbox.receiveInbound({
      from, to: [org.selfAddress], subject: opts.subject ?? 'Where is my order?',
      bodyText: opts.body ?? 'It has been a week and I would like an update.',
      ...(opts.threadId ? { threadId: opts.threadId } : {}),
    })
    await triggerSync(org)
    const draft = await waitFor(async () => {
      const rows = await withOrg(app.db, org.orgId, (tx) => tx.select().from(drafts).where(eq(drafts.status, 'pending')))
      expect(rows).toHaveLength(1)
      return rows[0]!
    })
    return { draftId: draft.id, ticketId: draft.ticketId, threadId: received.threadId, customer: from }
  }

  /** Marks viewed, approves through the real gate, then triggers the ledger row's `send.execute`
   *  immediately (see the file header, note 1). */
  async function approveAndRunSend(org: Org, draftId: string): Promise<string> {
    expect(await markViewed(service, org.orgId, draftId, actorFor(org))).toBe(true)
    const approved = await approveDraft(service, org.orgId, { draftId }, actorFor(org))
    expect(approved.ok).toBe(true)
    const sendId = (approved as { ok: true; sendId: string }).sendId
    await boss.send(JOB_NAMES.sendExecute, { orgId: org.orgId, sendId })
    return sendId
  }

  function decodeRaw(raw: string): string {
    return Buffer.from(raw, 'base64url').toString()
  }
  function headerLine(decoded: string, name: string): string {
    const line = decoded.split('\r\n').find((l) => l.startsWith(`${name}: `))
    if (!line) throw new Error(`no ${name} header in\n${decoded.split('\r\n\r\n')[0]}`)
    return line.slice(name.length + 2)
  }

  // ---- 1: inbound -> sync -> triage -> draft ------------------------------------------------

  let scenario1: { org: Org; ticketId: string; draftId: string; threadId: string } | null = null

  it('1. gmail: inbound -> sync -> triage -> ticket.draft -> awaiting_review, one pending draft, the draft_review push, both llm_calls rows and draft_runs 1', async () => {
    const org = await createOrg()
    scriptDraft({ parsed: REPLY, usage: { inputTokens: 1200, outputTokens: 300 } })
    const { ticketId, draftId, threadId } = await inboundToDraft(org)
    scenario1 = { org, ticketId, draftId, threadId }

    const ticket = await getTicket(org, ticketId)
    expect(ticket.status).toBe('awaiting_review')

    const rows = await draftsFor(org, ticketId)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.version).toBe(1)
    expect(rows[0]!.status).toBe('pending')
    expect(rows[0]!.body).toBe(CLEAN_BODY)
    expect(rows[0]!.decision).toBe('review')
    // The draft's staleness anchor IS the ticket's newest inbound instant, not a wall-clock read.
    expect(rows[0]!.threadSnapshotAt.toISOString()).toBe(ticket.lastInboundAt!.toISOString())

    const pushed = await waitFor(async () => {
      const hit = pushCalls.find((m) => (m.data as { draftId?: string } | undefined)?.draftId === draftId)
      expect(hit).toBeDefined()
      return hit!
    })
    expect(pushed.categoryId).toBe('draft_review')
    expect(pushed.data).toEqual({ kind: 'draft_review', ticketId, draftId })

    const calls = await withOrg(app.db, org.orgId, (tx) => tx.select().from(llmCalls).where(eq(llmCalls.orgId, org.orgId)))
    expect(calls.map((c) => c.role).sort()).toEqual(['draft', 'triage'])
    expect(calls.find((c) => c.role === 'draft')!.inputTokens).toBe(1200)
    expect(calls.find((c) => c.role === 'draft')!.outputTokens).toBe(300)

    expect((await metersFor(org)).draft_runs).toBe(1)
  }, 60_000)

  // ---- 2: idempotent re-poll, then a superseding second run ------------------------------------

  it('2. a re-poll changes nothing; a second inbound plus a hand-back supersedes the live draft into version 2', async () => {
    const s = scenario1!
    expect(s).not.toBeNull()
    const { org, ticketId, threadId } = s

    const before = {
      messages: (await messagesFor(org, ticketId)).length,
      drafts: (await draftsFor(org, ticketId)).length,
      runs: (await runsFor(org, ticketId)).length,
      draftCalls: draftCallCount(),
      lastSuccessAt: (await readConnection(org)).lastSuccessAt!.getTime(),
    }
    await triggerSync(org)
    await waitFor(async () => {
      expect((await readConnection(org)).lastSuccessAt!.getTime()).toBeGreaterThan(before.lastSuccessAt)
    })
    expect((await messagesFor(org, ticketId)).length).toBe(before.messages)
    expect((await draftsFor(org, ticketId)).length).toBe(before.drafts)
    expect((await runsFor(org, ticketId)).length).toBe(before.runs)
    expect(draftCallCount()).toBe(before.draftCalls)

    // A genuine second customer message on the same thread, ingested by the real sync walk.
    org.mailbox.receiveInbound({ from: `customer-${rand()}@${CUSTOMER_DOMAIN}`, to: [org.selfAddress], subject: 'Re: Where is my order?', bodyText: 'Any news yet?', threadId })
    await triggerSync(org)
    await waitFor(async () => {
      expect(await messagesFor(org, ticketId)).toHaveLength(before.messages + 1)
    })

    // The hand-back (see the file header, note 3) — the only thing that puts a ticket carrying a
    // live draft back in front of the agent.
    await withOrg(app.db, org.orgId, (tx) => tx.update(tickets).set({ status: 'triaged', lastAgentRunAt: null }).where(eq(tickets.id, ticketId)))
    scriptDraft({ parsed: reply({ body: `${CLEAN_BODY} We have the update now.` }) })
    await enqueueTicketDraft(boss, org.orgId, ticketId)

    const rows = await waitFor(async () => {
      const all = await draftsFor(org, ticketId)
      expect(all).toHaveLength(2)
      expect(all[1]!.status).toBe('pending')
      return all
    })
    expect(rows.map((r) => r.version)).toEqual([1, 2])
    expect(rows[0]!.status).toBe('superseded')
    expect(rows.filter((r) => r.status === 'pending')).toHaveLength(1)
    const superseded = await auditRowsFor(org, rows[0]!.id, 'draft.superseded')
    expect(superseded).toHaveLength(1)
    expect(superseded[0]!.detail).toMatchObject({ supersededByRunId: rows[1]!.agentRunId })
  }, 60_000)

  // ---- 3: reject-with-reason re-drafts through the api service ---------------------------------

  it('3. rejectDraft with a reason -> triaged with the feedback -> ticket.draft -> the redraft prompt carries the feedback and the prior body at effort high', async () => {
    const org = await createOrg()
    scriptDraft({ parsed: REPLY })
    const first = await inboundToDraft(org)

    const before = draftCallCount()
    scriptDraft({ parsed: reply({ body: `${CLEAN_BODY} The courier has it now.` }) })
    const rejected = await rejectDraft(service, org.orgId, { draftId: first.draftId, action: 'redraft', reason: 'Say the parcel is with the courier, not shipped.' }, actorFor(org))
    expect(rejected).toEqual({ ok: true, resolution: 'redraft' })

    const second = await waitFor(async () => {
      const rows = await draftsFor(org, first.ticketId)
      expect(rows).toHaveLength(2)
      expect(rows[1]!.status).toBe('pending')
      return rows[1]!
    })
    expect(second.isRedraft).toBe(true)
    expect(second.version).toBe(2)
    expect((await getTicket(org, first.ticketId)).redraftCount).toBe(1)

    const call = fake.callsFor('draft')[before]!
    expect(call.messages[0]!.content).toContain('Owner feedback on your previous draft')
    expect(call.messages[0]!.content).toContain('Say the parcel is with the courier, not shipped.')
    expect(call.messages[0]!.content).toContain(CLEAN_BODY)
    expect(call.effort).toBe('high')
  }, 60_000)

  // ---- 4: the redraft cap ----------------------------------------------------------------------

  it('4. a third reason-reject at the redraft cap lands needs_owner/redraft_limit_reached with a notification and NO further model call', async () => {
    const org = await createOrg()
    scriptDraft({ parsed: REPLY })
    const first = await inboundToDraft(org)

    let liveId = first.draftId
    for (const attempt of [1, 2]) {
      scriptDraft({ parsed: reply({ body: `${CLEAN_BODY} Attempt ${attempt === 1 ? 'two' : 'three'}.` }) })
      const res = await rejectDraft(service, org.orgId, { draftId: liveId, action: 'redraft', reason: `Please be warmer, take ${attempt}.` }, actorFor(org))
      expect(res).toEqual({ ok: true, resolution: 'redraft' })
      liveId = (await waitFor(async () => {
        const rows = await draftsFor(org, first.ticketId)
        expect(rows).toHaveLength(attempt + 1)
        expect(rows[attempt]!.status).toBe('pending')
        return rows[attempt]!
      })).id
    }
    expect((await getTicket(org, first.ticketId)).redraftCount).toBe(2)

    const callsBefore = draftCallCount()
    const res = await rejectDraft(service, org.orgId, { draftId: liveId, action: 'redraft', reason: 'Still not right.' }, actorFor(org))
    expect(res).toEqual({ ok: true, resolution: 'escalate_limit' })

    const ticket = await getTicket(org, first.ticketId)
    expect(ticket.status).toBe('needs_owner')
    expect(ticket.needsOwnerReason).toBe('redraft_limit_reached')
    const paged = (await notificationsFor(org)).filter((n) => n.dedupeKey.startsWith(`redraft_limit:${first.ticketId}:`))
    expect(paged).toHaveLength(1)
    // No fourth run. Waiting for EVERY ticket.draft job that names this ticket to be `completed` is
    // what makes that a real assertion rather than a race: a fourth job the reject should never have
    // enqueued would be waited for here and would then move the call count below.
    const draftJobs = await waitForJobsCompleted(JOB_NAMES.ticketDraft, (r) => (r.data as { ticketId?: string }).ticketId === first.ticketId)
    // Triage's own hand-off plus the two redraft enqueues; the capped reject enqueued nothing.
    expect(draftJobs).toBe(3)
    expect(draftCallCount()).toBe(callsBefore)
    expect(await draftsFor(org, first.ticketId)).toHaveLength(3)
  }, 90_000)

  // ---- 5: two transient model failures escalate agent_failed -----------------------------------

  it('5. two transient LlmErrors: the first attempt rejects and pg-boss retries, the second escalates needs_owner/agent_failed with two failed runs', async () => {
    const org = await createOrg()
    scriptDraft(
      { error: new LlmError('rate limited', 'rate_limit', true) },
      { error: new LlmError('rate limited again', 'rate_limit', true) },
    )
    const from = `customer-${rand()}@${CUSTOMER_DOMAIN}`
    org.mailbox.receiveInbound({ from, to: [org.selfAddress], subject: 'Where is my order?', bodyText: 'It has been a week.' })
    await triggerSync(org)

    const ticketId = await waitFor(async () => {
      const rows = await ticketsFor(org)
      expect(rows).toHaveLength(1)
      expect(rows[0]!.status).toBe('needs_owner')
      expect(rows[0]!.needsOwnerReason).toBe('agent_failed')
      return rows[0]!.id
    })
    const ticket = await getTicket(org, ticketId)
    expect(ticket.agentFailureCount).toBe(2)
    const runs = await runsFor(org, ticketId)
    expect(runs).toHaveLength(2)
    expect(runs.every((r) => r.status === 'failed')).toBe(true)
    expect(runs.every((r) => r.errorCode === 'llm_rate_limit')).toBe(true)
    expect((await notificationsFor(org)).filter((n) => n.kind === 'escalation')).toHaveLength(1)
    expect(await draftsFor(org, ticketId)).toHaveLength(0)
  }, 90_000)

  // ---- 6: the two caps -------------------------------------------------------------------------

  it('6a. three draft runs already today escalate needs_owner/agent_run_cap without a model call', async () => {
    const org = await createOrg()
    scriptDraft({ parsed: REPLY })
    const seeded = await inboundToDraft(org)
    // Hand the ticket back and charge it two more runs, so the pre-claim cap read sees three.
    await withOrg(app.db, org.orgId, async (tx) => {
      await tx.update(tickets).set({ status: 'triaged', lastAgentRunAt: null }).where(eq(tickets.id, seeded.ticketId))
      await tx.insert(agentRuns).values(
        Array.from({ length: 2 }, () => ({
          orgId: org.orgId, kind: 'draft', ticketId: seeded.ticketId, agentId: org.agentId,
          provider: 'fake', model: 'claude-opus-5', status: 'succeeded', startedAt: new Date(),
        })),
      )
    })

    const callsBefore = draftCallCount()
    await enqueueTicketDraft(boss, org.orgId, seeded.ticketId)
    await waitFor(async () => {
      const ticket = await getTicket(org, seeded.ticketId)
      expect(ticket.status).toBe('needs_owner')
      expect(ticket.needsOwnerReason).toBe('agent_run_cap')
    })
    expect(draftCallCount()).toBe(callsBefore)
    expect((await notificationsFor(org)).filter((n) => n.dedupeKey.startsWith(`agent_run_cap:${seeded.ticketId}:`))).toHaveLength(1)
  }, 90_000)

  it('6b. the org spend cap leaves the ticket triaged with its claim stamp untouched and pages once per day', async () => {
    const org = await createOrg()
    await setUsageCounter(org, 'llm_cost_micros', 60_000_000)
    const callsBefore = draftCallCount()
    org.mailbox.receiveInbound({ from: `customer-${rand()}@${CUSTOMER_DOMAIN}`, to: [org.selfAddress], subject: 'Where is my order?', bodyText: 'Please update me.' })
    await triggerSync(org)

    const ticketId = await waitFor(async () => {
      const rows = await ticketsFor(org)
      expect(rows).toHaveLength(1)
      expect(rows[0]!.status).toBe('triaged')
      const capped = (await notificationsFor(org)).filter((n) => n.dedupeKey.startsWith(`llm_cap:${org.orgId}:`))
      expect(capped).toHaveLength(1)
      return rows[0]!.id
    })

    // A second run the same day adds no second page and still never calls the model.
    const jobId = await enqueue(boss, ticketDraftJob, { orgId: org.orgId, ticketId }, { entityId: `${ticketId}-again` })
    await waitFor(async () => {
      expect((await queueRows(JOB_NAMES.ticketDraft)).find((r) => r.id === jobId)?.state).toBe('completed')
    })

    const ticket = await getTicket(org, ticketId)
    expect(ticket.status).toBe('triaged')
    expect(ticket.lastAgentRunAt).toBeNull()
    expect(draftCallCount()).toBe(callsBefore)
    const capped = (await notificationsFor(org)).filter((n) => n.dedupeKey.startsWith(`llm_cap:${org.orgId}:`))
    expect(capped).toHaveLength(1)
    expect(capped[0]!.title).toBe('Daily AI budget reached')
    expect(await draftsFor(org, ticketId)).toHaveLength(0)
  }, 90_000)

  // ---- 7: the orphan backstop ------------------------------------------------------------------

  it('7. a ticket whose only draft vanished is escalated needs_owner/orphaned by the backstop sweep, once', async () => {
    const org = await createOrg()
    scriptDraft({ parsed: REPLY })
    const { ticketId, draftId } = await inboundToDraft(org)
    await withOrg(app.db, org.orgId, (tx) => tx.delete(drafts).where(eq(drafts.id, draftId)))

    const sweepNow = new Date(Date.now() + (ORPHAN_AFTER_MINUTES + 5) * 60_000)
    await runTicketBackstopSweep(boss, { db: app.db, logger, now: () => sweepNow })

    const ticket = await getTicket(org, ticketId)
    expect(ticket.status).toBe('needs_owner')
    expect(ticket.needsOwnerReason).toBe('orphaned')
    const orphanPages = (await notificationsFor(org)).filter((n) => n.dedupeKey.startsWith(`orphaned:${ticketId}:`))
    expect(orphanPages).toHaveLength(1)

    await runTicketBackstopSweep(boss, { db: app.db, logger, now: () => sweepNow })
    expect((await notificationsFor(org)).filter((n) => n.dedupeKey.startsWith(`orphaned:${ticketId}:`))).toHaveLength(1)
    expect((await getTicket(org, ticketId)).needsOwnerReason).toBe('orphaned')
  }, 90_000)

  // ---- 8: the guardrail matrix, per workspace ---------------------------------------------------

  it('8. the same acme.test link passes in the workspace that allows the host, buys one automatic redraft in the one that does not, and blocks when both attempts fail', async () => {
    const orgA = await createOrg({ domain: 'acme.test', allowedUrlHosts: ['acme.test'] })
    const orgB = await createOrg({ domain: 'beta.test', allowedUrlHosts: ['beta.test'] })

    // A: allowed -> straight to review, ONE model call.
    let before = draftCallCount()
    scriptDraft({ parsed: reply({ body: LINK_BODY }) })
    const a = await inboundToDraft(orgA)
    expect((await getTicket(orgA, a.ticketId)).status).toBe('awaiting_review')
    const aDraft = await getDraft(orgA, a.draftId)
    expect(aDraft.body).toBe(LINK_BODY)
    expect(aDraft.guardrailResult).toMatchObject({ ok: true })
    expect((await runsFor(orgA, a.ticketId))[0]!.apiCalls).toBe(1)
    expect(draftCallCount()).toBe(before + 1)

    // B: disallowed, but the automatic redraft comes back clean -> review, TWO model calls.
    before = draftCallCount()
    scriptDraft({ parsed: reply({ body: LINK_BODY }) }, { parsed: REPLY })
    const b = await inboundToDraft(orgB)
    expect((await getTicket(orgB, b.ticketId)).status).toBe('awaiting_review')
    const bDraft = await getDraft(orgB, b.draftId)
    expect(bDraft.body).toBe(CLEAN_BODY)
    expect(bDraft.guardrailResult).toMatchObject({ ok: true })
    expect((await runsFor(orgB, b.ticketId))[0]!.apiCalls).toBe(2)
    expect(draftCallCount()).toBe(before + 2)

    // B again, both attempts failing -> the blocked body is STORED pending, decision escalate.
    scriptDraft({ parsed: reply({ body: LINK_BODY }) }, { parsed: reply({ body: LINK_BODY }) })
    const c = await inboundToDraft2(orgB)
    const cDraft = await getDraft(orgB, c.draftId)
    expect(cDraft.status).toBe('pending')
    expect(cDraft.decision).toBe('escalate')
    expect(cDraft.decisionReason).toBe('guardrail_failed')
    expect(cDraft.body).toBe(LINK_BODY)
    expect(cDraft.guardrailResult).toMatchObject({ ok: false })
    const cTicket = await getTicket(orgB, c.ticketId)
    expect(cTicket.status).toBe('needs_owner')
    expect(cTicket.needsOwnerReason).toBe('guardrail_failed')
  }, 120_000)

  /** `inboundToDraft` waits for the org's ONLY pending draft; org B already holds one by this
   *  point, so the third case waits for the newest ticket's own draft instead. */
  async function inboundToDraft2(org: Org) {
    const known = new Set((await withOrg(app.db, org.orgId, (tx) => tx.select({ id: drafts.id }).from(drafts))).map((r) => r.id))
    org.mailbox.receiveInbound({ from: `customer-${rand()}@${CUSTOMER_DOMAIN}`, to: [org.selfAddress], subject: 'A second question', bodyText: 'Where do I find the help pages?' })
    await triggerSync(org)
    const draft = await waitFor(async () => {
      const rows = await withOrg(app.db, org.orgId, (tx) => tx.select().from(drafts))
      const fresh = rows.find((r) => !known.has(r.id))
      expect(fresh).toBeDefined()
      return fresh!
    })
    return { draftId: draft.id, ticketId: draft.ticketId }
  }

  // ---- 9: a kill switch flipped while the send is queued ---------------------------------------

  it('9. the workspace kill switch holds a queued send: the ledger row AND the draft go held together and the owner is paged', async () => {
    const org = await createOrg()
    scriptDraft({ parsed: REPLY })
    const { ticketId, draftId } = await inboundToDraft(org)

    expect(await markViewed(service, org.orgId, draftId, actorFor(org))).toBe(true)
    const approved = await approveDraft(service, org.orgId, { draftId }, actorFor(org))
    expect(approved.ok).toBe(true)
    const sendId = (approved as { ok: true; sendId: string }).sendId
    await withOrg(app.db, org.orgId, (tx) => tx.update(workspaces).set({ killSwitch: true }).where(eq(workspaces.orgId, org.orgId)))
    await boss.send(JOB_NAMES.sendExecute, { orgId: org.orgId, sendId })

    const send = await waitFor(async () => {
      const row = await sendFor(org, draftId)
      expect(row.status).toBe('held')
      return row
    })
    expect(send.lastError).toBe('held:workspace_kill_switch')
    expect(org.mailbox.sentMessages()).toHaveLength(0)
    // The job leaves the DRAFT held too: the service's held -> pending step is the human undo path
    // (`drafts.resume`), never something the job does for itself.
    expect((await getDraft(org, draftId)).status).toBe('held')
    expect((await getTicket(org, ticketId)).status).toBe('awaiting_review')
    const held = (await notificationsFor(org)).filter((n) => n.dedupeKey.startsWith(`send_held:${sendId}:`))
    expect(held).toHaveLength(1)
    expect(held[0]!.title).toMatch(/^Reply on hold — /)
    expect(await auditRowsFor(org, sendId, 'send.held')).toHaveLength(1)
  }, 90_000)

  // ---- 10: the gmail send happy path -----------------------------------------------------------

  it('10. gmail: approve -> send.execute -> one threaded, marked, signed reply, ONE outbound row (still one after sync), the two meters, and a follow-up that reopens into a fresh draft', async () => {
    const org = await createOrg()
    scriptDraft({ parsed: REPLY })
    const { ticketId, draftId, threadId, customer } = await inboundToDraft(org)
    const inbound = (await messagesFor(org, ticketId, 'inbound'))[0]!

    await approveAndRunSend(org, draftId)
    const send = await waitFor(async () => {
      const row = await sendFor(org, draftId)
      expect(row.status).toBe('sent')
      return row
    })

    const sent = org.mailbox.sentMessages()
    expect(sent).toHaveLength(1)
    expect(sent[0]!.markerDraftId).toBe(draftId)
    expect(sent[0]!.bodyText.endsWith('\n\nAcme Support')).toBe(true)
    const decoded = decodeRaw(sent[0]!.raw!)
    expect(headerLine(decoded, 'To')).toBe(customer)
    expect(headerLine(decoded, 'From')).toBe(org.selfAddress)
    expect(headerLine(decoded, 'Subject')).toBe('Re: Where is my order?')
    expect(headerLine(decoded, 'In-Reply-To')).toBe(inbound.rfcMessageId)
    expect(headerLine(decoded, 'References')).toBe(inbound.rfcMessageId)
    expect(headerLine(decoded, MARKER_HEADER)).toBe(draftId)

    expect(send.providerMessageId).toBeTruthy()
    expect(send.providerThreadId).toBe(threadId)
    expect(send.rfcMessageId).toBe(`<${send.providerMessageId}@mock.aesa>`)
    expect(send.sentAt).not.toBeNull()
    expect((await getDraft(org, draftId)).status).toBe('sent')
    expect((await getTicket(org, ticketId)).status).toBe('waiting_on_customer')

    const outbound = await messagesFor(org, ticketId, 'outbound')
    expect(outbound).toHaveLength(1)
    expect(outbound[0]!.draftId).toBe(draftId)

    // The mailbox poll ingests the provider's own copy of the same message: still exactly one row.
    const before = (await readConnection(org)).lastSuccessAt!.getTime()
    await triggerSync(org)
    await waitFor(async () => {
      expect((await readConnection(org)).lastSuccessAt!.getTime()).toBeGreaterThan(before)
    })
    const after = await messagesFor(org, ticketId, 'outbound')
    expect(after).toHaveLength(1)
    expect(after[0]!.draftId).toBe(draftId)

    const meters = await metersFor(org)
    expect(meters[SEND_METERS.reviewSends]).toBe(1)
    expect(meters[SEND_METERS.aiHandledConversations]).toBe(1)
    expect(sentEvents).toContainEqual({ orgId: org.orgId, ticketId, draftId })

    // The customer writes back: reopen -> triage -> a fresh draft on the SAME ticket.
    scriptDraft({ parsed: reply({ body: `${CLEAN_BODY} Here is the follow up.` }) })
    org.mailbox.receiveInbound({ from: customer, to: [org.selfAddress], subject: 'Re: Where is my order?', bodyText: 'Thanks. One more question about the size.', threadId })
    // No clock fixup needed: `reopenIfEligible` clears `last_agent_run_at` on the reopen, so the
    // claim fires on its never-run branch rather than on the `last_inbound_at > last_agent_run_at`
    // watermark — which is what makes a reopen work at all when the provider's timestamp for the
    // follow-up predates the previous run's wall-clock claim stamp (`MockMailbox` stamps from a
    // fixed 2023 baseline, so here it always does).
    await triggerSync(org)
    const second = await waitFor(async () => {
      const rows = await draftsFor(org, ticketId)
      expect(rows).toHaveLength(2)
      expect(rows[1]!.status).toBe('pending')
      return rows[1]!
    })
    expect(second.version).toBe(2)
    expect((await getTicket(org, ticketId)).status).toBe('awaiting_review')
    expect(org.mailbox.sentMessages()).toHaveLength(1) // nothing else went out
  }, 120_000)

  // ---- 11: a duplicate delivery of the same job -------------------------------------------------

  it('11. the same send.execute payload delivered twice sends exactly one message', async () => {
    const org = await createOrg()
    scriptDraft({ parsed: REPLY })
    const { ticketId, draftId } = await inboundToDraft(org)
    expect(await markViewed(service, org.orgId, draftId, actorFor(org))).toBe(true)
    const approved = await approveDraft(service, org.orgId, { draftId }, actorFor(org))
    const sendId = (approved as { ok: true; sendId: string }).sendId

    const jobIds = await Promise.all([
      boss.send(JOB_NAMES.sendExecute, { orgId: org.orgId, sendId }),
      boss.send(JOB_NAMES.sendExecute, { orgId: org.orgId, sendId }),
    ])

    await waitFor(async () => {
      expect((await sendFor(org, draftId)).status).toBe('sent')
    })
    // BOTH deliveries have to have run before "exactly one message" means anything — the second one
    // landing on the already-sent row is the whole point of the scenario.
    expect(await waitForJobsCompleted(JOB_NAMES.sendExecute, (r) => jobIds.includes(r.id))).toBe(2)
    expect(org.mailbox.sentMessages()).toHaveLength(1)
    expect(await messagesFor(org, ticketId, 'outbound')).toHaveLength(1)
    expect((await metersFor(org))[SEND_METERS.reviewSends]).toBe(1)
  }, 90_000)

  // ---- 12: a graph crash between createReply and the send ----------------------------------------

  it('12. graph: a crash AFTER createReply re-enters through the persisted provider_draft_id — one provider draft, one message', async () => {
    const org = await createOrg({ mode: 'graph' })
    scriptDraft({ parsed: REPLY })
    const { ticketId, draftId } = await inboundToDraft(org)
    org.mailbox.failAfter('createReply', new Error('502 from graph after createReply'))

    await approveAndRunSend(org, draftId)
    const send = await waitFor(async () => {
      const row = await sendFor(org, draftId)
      expect(row.status).toBe('sent')
      return row
    })

    expect(send.attempts).toBeGreaterThanOrEqual(2) // the first attempt crashed; pg-boss really retried
    expect(send.providerDraftId).toBeTruthy()
    expect(org.mailbox.drafts().size).toBe(1)
    expect(org.mailbox.drafts().get(send.providerDraftId!)!.sent).toBe(true)
    expect(org.mailbox.sentMessages()).toHaveLength(1)
    expect(send.providerMessageId).toBe(send.providerDraftId)
    expect(await messagesFor(org, ticketId, 'outbound')).toHaveLength(1)
    expect((await getDraft(org, draftId)).status).toBe('sent')
  }, 120_000)

  // ---- 13: a crash after the customer already has the mail ---------------------------------------

  it('13. a crash AFTER the send is recovered by marker on the retry — never a second copy', async () => {
    const org = await createOrg()
    scriptDraft({ parsed: REPLY })
    const { ticketId, draftId } = await inboundToDraft(org)
    org.mailbox.failAfter('send', new Error('socket hung up after the send'))

    await approveAndRunSend(org, draftId)
    await waitFor(async () => {
      expect((await sendFor(org, draftId)).status).toBe('sent')
    })

    expect(org.mailbox.sentMessages()).toHaveLength(1)
    expect((await sendFor(org, draftId)).attempts).toBeGreaterThanOrEqual(2)
    expect(await messagesFor(org, ticketId, 'outbound')).toHaveLength(1)
    expect((await getDraft(org, draftId)).status).toBe('sent')
    expect((await getTicket(org, ticketId)).status).toBe('waiting_on_customer')
    const auditRows = await auditRowsFor(org, (await sendFor(org, draftId)).id, 'send.sent')
    expect(auditRows).toHaveLength(1)
    expect(auditRows[0]!.detail).toMatchObject({ recovered: true })
  }, 120_000)

  // ---- 14: an inbound between approve and send ---------------------------------------------------

  it('14. a customer message that lands after the approve aborts the send, fails the ledger row and the draft, and hands the ticket back to the agent', async () => {
    const org = await createOrg()
    scriptDraft({ parsed: REPLY })
    const { ticketId, draftId, threadId } = await inboundToDraft(org)
    // The re-draft the stale hand-back enqueues answers `no_reply`, which leaves the ticket
    // `triaged` — a stable end state to assert against.
    scriptDraft({ parsed: NO_REPLY })

    expect(await markViewed(service, org.orgId, draftId, actorFor(org))).toBe(true)
    const approved = await approveDraft(service, org.orgId, { draftId }, actorFor(org))
    const sendId = (approved as { ok: true; sendId: string }).sendId

    org.mailbox.receiveInbound({ from: `customer-${rand()}@${CUSTOMER_DOMAIN}`, to: [org.selfAddress], subject: 'Re: Where is my order?', bodyText: 'Never mind, it arrived.', threadId })
    await triggerSync(org)
    await waitFor(async () => {
      expect(await messagesFor(org, ticketId, 'inbound')).toHaveLength(2)
    })

    await boss.send(JOB_NAMES.sendExecute, { orgId: org.orgId, sendId })
    const send = await waitFor(async () => {
      const row = await sendFor(org, draftId)
      expect(row.status).toBe('failed')
      return row
    })
    expect(send.lastError).toBe('stale: newer customer message')
    expect(org.mailbox.sentMessages()).toHaveLength(0)
    expect((await getDraft(org, draftId)).status).toBe('failed')
    const stalePages = (await notificationsFor(org)).filter((n) => n.dedupeKey === `send_stale:${sendId}`)
    expect(stalePages).toHaveLength(1)
    expect(stalePages[0]!.title).toBe('Your approved reply was not sent')
    expect(await auditRowsFor(org, sendId, 'send.stale')).toHaveLength(1)

    // The hand-back really re-ran the agent: a SECOND run exists, and its no_reply leaves the
    // ticket triaged with no new draft.
    await waitFor(async () => {
      const runs = await runsFor(org, ticketId)
      expect(runs).toHaveLength(2)
      expect(runs[1]!.status).toBe('succeeded')
    })
    const ticket = await getTicket(org, ticketId)
    expect(ticket.status).toBe('triaged')
    expect(await draftsFor(org, ticketId)).toHaveLength(1)
  }, 120_000)

  // ---- 15: the undo window ------------------------------------------------------------------------

  it('15. holdDraft inside the undo window holds the send and returns the draft to review; the job then finds nothing to claim', async () => {
    const org = await createOrg()
    scriptDraft({ parsed: REPLY })
    const { ticketId, draftId } = await inboundToDraft(org)
    expect(await markViewed(service, org.orgId, draftId, actorFor(org))).toBe(true)
    const approved = await approveDraft(service, org.orgId, { draftId }, actorFor(org))
    const sendId = (approved as { ok: true; sendId: string }).sendId

    expect(await holdDraft(service, org.orgId, draftId, actorFor(org))).toEqual({ ok: true })
    expect((await sendFor(org, draftId)).status).toBe('held')
    expect((await getDraft(org, draftId)).status).toBe('pending')

    const jobId = await boss.send(JOB_NAMES.sendExecute, { orgId: org.orgId, sendId })
    await waitFor(async () => {
      expect((await queueRows(JOB_NAMES.sendExecute)).find((r) => r.id === jobId)?.state).toBe('completed')
    })

    expect(org.mailbox.sentMessages()).toHaveLength(0)
    const send = await sendFor(org, draftId)
    expect(send.status).toBe('held')
    expect(send.attempts).toBe(0) // never claimable, so never even counted an attempt
    expect((await getTicket(org, ticketId)).status).toBe('awaiting_review')
    expect(await auditRowsFor(org, draftId, 'draft.held')).toHaveLength(1)
  }, 120_000)

  // ---- 16: the graph send happy path ---------------------------------------------------------------

  it('16. graph: the same approve -> send path through the Graph-shaped mock, From reconstructed on the outbound row', async () => {
    const org = await createOrg({ mode: 'graph' })
    scriptDraft({ parsed: REPLY })
    const { ticketId, draftId, threadId, customer } = await inboundToDraft(org)

    await approveAndRunSend(org, draftId)
    const send = await waitFor(async () => {
      const row = await sendFor(org, draftId)
      expect(row.status).toBe('sent')
      return row
    })

    const sent = org.mailbox.sentMessages()
    expect(sent).toHaveLength(1)
    expect(sent[0]!.raw).toBeUndefined() // graph's two-phase send never produces an RFC 2822 blob
    expect(sent[0]!.to).toBe(customer)
    expect(sent[0]!.threadId).toBe(threadId)
    expect(sent[0]!.markerDraftId).toBe(draftId)
    expect(sent[0]!.bodyText.endsWith('\n\nAcme Support')).toBe(true)
    expect(org.mailbox.drafts().size).toBe(1)

    const outbound = await messagesFor(org, ticketId, 'outbound')
    expect(outbound).toHaveLength(1)
    expect(outbound[0]!.fromAddress).toBe(org.selfAddress)
    expect(outbound[0]!.draftId).toBe(draftId)
    expect(send.providerThreadId).toBe(threadId)
    expect((await getDraft(org, draftId)).status).toBe('sent')
    expect((await getTicket(org, ticketId)).status).toBe('waiting_on_customer')
    expect((await metersFor(org))[SEND_METERS.reviewSends]).toBe(1)
  }, 120_000)

  // ---- 17: a no_reply that ignored the owner's correction --------------------------------------------

  it('17. a no_reply while owner feedback is still pending escalates needs_owner/redraft_unfulfilled and clears the redraft cycle', async () => {
    const org = await createOrg()
    scriptDraft({ parsed: REPLY })
    const { ticketId, draftId } = await inboundToDraft(org)

    scriptDraft({ parsed: NO_REPLY })
    const rejected = await rejectDraft(service, org.orgId, { draftId, action: 'redraft', reason: 'Mention the courier by name.' }, actorFor(org))
    expect(rejected).toEqual({ ok: true, resolution: 'redraft' })

    await waitFor(async () => {
      const ticket = await getTicket(org, ticketId)
      expect(ticket.status).toBe('needs_owner')
      expect(ticket.needsOwnerReason).toBe('redraft_unfulfilled')
    })
    const ticket = await getTicket(org, ticketId)
    expect(ticket.ownerRedraftFeedback).toBeNull()
    expect(ticket.redraftCount).toBe(0)
    expect(await draftsFor(org, ticketId)).toHaveLength(1) // the rejected one; no_reply stores none
    expect((await notificationsFor(org)).filter((n) => n.kind === 'escalation')).toHaveLength(1)
  }, 90_000)

  // ---- 18: the sandbox run --------------------------------------------------------------------------

  it('18. agent.sandbox runs the owner question through the real draft pipeline and stores a succeeded run with the screened body', async () => {
    const org = await createOrg()
    scriptDraft({ parsed: REPLY })
    const [run] = await withOrg(app.db, org.orgId, (tx) =>
      tx.insert(agentRuns).values({
        orgId: org.orgId, kind: 'sandbox', agentId: org.agentId, provider: 'fake', model: 'claude-opus-5',
        status: 'running', input: { subject: 'Where is my order?', question: 'Where is my order?' }, startedAt: new Date(),
      }).returning({ id: agentRuns.id }))
    const runId = run!.id

    await enqueue(boss, agentSandboxJob, { orgId: org.orgId, runId }, { entityId: runId })

    const finished = await waitFor(async () => {
      const [row] = await withOrg(app.db, org.orgId, (tx) => tx.select().from(agentRuns).where(eq(agentRuns.id, runId)))
      expect(row!.status).toBe('succeeded')
      return row!
    })
    expect(finished.output).toMatchObject({ outcome: 'reply', normalizedBody: CLEAN_BODY, guardrail: { ok: true } })
    // A sandbox run never touches the ticket/draft tables.
    expect(await ticketsFor(org)).toHaveLength(0)
    expect(await withOrg(app.db, org.orgId, (tx) => tx.select().from(drafts))).toHaveLength(0)
  }, 90_000)

  // ---- 19: the daily digest email --------------------------------------------------------------------

  it('19. at the workspace-local digest hour a pending draft becomes one email per owner/admin, with a /a/<draftId>?t= link whose token row exists', async () => {
    const org = await createOrg()
    scriptDraft({ parsed: REPLY })
    const { ticketId, draftId } = await inboundToDraft(org)

    const mail = createDevSink()
    const at0800 = new Date('2026-09-10T08:00:00Z') // the workspace timezone is UTC; catalog hour is 8
    const result = await runDigestEmailForOrg(
      { db: app.db, mail, appBaseUrl: 'https://api.test', appWebOrigin: 'https://app.test', logger, now: () => at0800 },
      org.orgId,
      at0800,
    )
    expect(result).toBe('sent')

    const emails = mail.all()
    expect(emails).toHaveLength(1)
    expect(emails[0]!.to).toBe(org.ownerEmail)
    const url = [...emails[0]!.text.matchAll(/^Approve: (\S+)$/gm)].map((m) => m[1]!)[0]!
    const parsed = new URL(url)
    expect(parsed.origin).toBe('https://api.test')
    expect(parsed.pathname).toBe(`/a/${draftId}`)

    const raw = parsed.searchParams.get('t')!
    const tokens = await withOrg(app.db, org.orgId, (tx) => tx.select().from(draftActionTokens).where(eq(draftActionTokens.orgId, org.orgId)))
    expect(tokens).toHaveLength(1)
    expect(tokens[0]!.tokenHash).toBe(hashToken('action', raw))
    expect(tokens[0]!.draftId).toBe(draftId)
    expect(tokens[0]!.userId).toBe(org.ownerUserId)
    expect(tokens[0]!.consumedAt).toBeNull()
    expect(emails[0]!.text).toContain(`https://app.test/ticket/${ticketId}`)

    // The once-per-local-day lock row, and a second pass the same day sending nothing more.
    const [lock] = await withOrg(app.db, org.orgId, (tx) =>
      tx.select().from(notifications).where(eq(notifications.dedupeKey, `digest_email:${org.orgId}:2026-09-10`)))
    expect(lock).toBeDefined()
    const again = await runDigestEmailForOrg(
      { db: app.db, mail, appBaseUrl: 'https://api.test', appWebOrigin: 'https://app.test', logger, now: () => at0800 },
      org.orgId,
      at0800,
    )
    expect(again).toBe('skipped')
    expect(mail.all()).toHaveLength(1)
  }, 90_000)

  // ---- 20: a poisoned payload --------------------------------------------------------------------------

  it('20. a schema-invalid ticket.draft payload (raw boss.send) is deleted outright — no handler call, no failed row', async () => {
    const before = draftCallCount()
    const jobId = await boss.send(JOB_NAMES.ticketDraft, { orgId: 123, ticketId: 456 })
    expect(jobId).not.toBeNull()

    await waitFor(async () => {
      const rows = await queueRows(JOB_NAMES.ticketDraft)
      expect(rows.some((r) => r.id === jobId)).toBe(false) // deleteJob, not a 'failed' row
    })
    expect(draftCallCount()).toBe(before)
  }, 60_000)
})
