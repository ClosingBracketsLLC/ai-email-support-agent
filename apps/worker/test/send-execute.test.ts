/**
 * `runSendExecute` against real Postgres and `@aesa/mail`'s `createMockMailbox` (plugged in through
 * the `clientFactory` seam, exactly as `mailbox-sync.test.ts` does) — no pg-boss, no network. One
 * `it` (or one `it.each` family) per numbered step in the task brief, plus the crash-window cases
 * the whole design exists for.
 *
 * Every test gets a FRESH org fixture (`beforeEach`): the meters, `ai_handled_month` and the
 * platform kill lever are all org- or process-wide, so a shared org would make several assertions
 * depend on the order the suite happens to run in.
 *
 * The clock is MONOTONIC (base `NOW`, +1 ms per read), not frozen: the crash-recovery cases turn on
 * a second run observing a claim horizon the first run collapsed to its own `now`, which a frozen
 * clock cannot express (`claim_expires_at < now` would be false forever).
 */
import { randomBytes } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import pino from 'pino'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { INVARIANTS } from '@aesa/core'
import { encrypt, hashToken, loadKekRing, type KekRing } from '@aesa/crypto'
import {
  agentCategoryPolicies, agents, audit, auditLog, bumpMeter, categories, drafts, ensureDefaultCategories,
  loadOrgDek, mailboxConnections, mailboxCredentials, messages, notifications, outboundSends, platformState,
  provisionOrgKeys, SEND_METERS, tickets, usageCounters, user, withOrg, withPlatform, workspaces,
} from '@aesa/db'
import { createDb } from '@aesa/db/raw'
import { createTestDatabase, createTestOrganization } from '@aesa/db/testing'
import {
  createMailLimiter, createMockMailbox, MailApiError, MARKER_HEADER, ProviderAuthError, runSync,
  type MailboxClient, type MailboxProvider, type MockMailbox, type SendReplyInput,
} from '@aesa/mail'
import {
  OUTBOUND_SUBJECT_MAX_CHARS, RECOVERY_SCAN_LIMIT, runSendExecute, STALE_ERROR, type SendExecuteDeps,
} from '../src/jobs/send-execute.ts'
import type { WorkerConfig } from '../src/config.ts'

const rand = () => randomBytes(4).toString('hex')
const NOW = new Date('2026-09-09T12:00:00Z')
const TODAY = '2026-09-09'
const THIS_MONTH = '2026-09'
const CUSTOMER = 'customer@example.test'
const SIGNATURE = 'Acme Support'
/** Passes every guardrail screen: no markup, no link, no address, no number, no promise token. */
const CLEAN_BODY = 'Thanks for getting in touch. I have checked the details you gave us and everything looks correct on our side.'

/** Base `NOW`, advancing a millisecond per read — see the file header. */
function monotonicClock(base: Date = NOW): () => Date {
  let tick = 0
  return () => new Date(base.getTime() + tick++)
}

function baseConfig(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    env: 'test', databaseUrl: 'unused', roles: new Set(['send']), kekRing: null, logLevel: 'silent', anthropicApiKey: null,
    gmailOauth: { clientId: 'gmail-client', clientSecret: { expose: () => 'gmail-secret' } as never },
    msOauth: { clientId: 'ms-client', clientSecret: { expose: () => 'ms-secret' } as never },
    mail: { transport: 'devsink', from: 'aesa <onboarding@resend.dev>' },
    appBaseUrl: null,
    appWebOrigin: null,
    gmailPubsubTopic: null, webhookPublicUrl: null, platformSender: 'no-reply@aesa.test',
    ...overrides,
  }
}

/** Never actually reached: every fixture seeds a FRESH access token, so `getAccessToken` returns
 *  straight from the row without calling `.refresh()`, and the client always comes from `clientFactory`. */
function stubProvider(over: Partial<MailboxProvider> = {}): MailboxProvider {
  return {
    kind: 'gmail',
    authorizationUrl: () => { throw new Error('unexpected') },
    exchangeCode: () => { throw new Error('unexpected') },
    refresh: async () => { throw new Error('unexpected refresh') },
    revoke: async () => {},
    client: () => { throw new Error('unexpected client()') },
    ...over,
  } as MailboxProvider
}

let t: Awaited<ReturnType<typeof createTestDatabase>>
let app: ReturnType<typeof createDb>
let userId: string
const ring: KekRing = loadKekRing({ AESA_KEK_V1: randomBytes(32).toString('base64'), AESA_KEK_ACTIVE: '1' })

interface Fixture {
  orgId: string
  connectionId: string
  agentId: string
  categoryId: string
  selfAddress: string
  mailbox: MockMailbox
  mode: 'gmail' | 'graph'
}
let fx: Fixture

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
beforeEach(async () => {
  fx = await seedOrg('gmail')
})

async function seedOrg(mode: 'gmail' | 'graph'): Promise<Fixture> {
  const orgId = await createTestOrganization(app)
  const selfAddress = `support-${rand()}@acme.test`
  const base = await withOrg(app.db, orgId, async (tx) => {
    await tx.insert(workspaces).values({
      orgId, businessName: 'Acme Dog Supplies', timezone: 'UTC', locale: 'en',
      description: 'Acme sells dog beds, leads and bowls online.',
      allowedUrlHosts: ['acme.test'], allowedEmailDomains: ['acme.test'],
      operatingGuidance: 'Always confirm the order number before quoting a delivery window.',
      agentEnabled: true,
    })
    await provisionOrgKeys(tx, ring)
    await ensureDefaultCategories(tx)
    const [conn] = await tx
      .insert(mailboxConnections)
      .values({
        orgId, provider: mode === 'gmail' ? 'gmail' : 'microsoft', providerAccountId: `acct-${rand()}`,
        emailAddress: selfAddress, status: 'connected', connectedByUserId: userId,
      })
      .returning({ id: mailboxConnections.id })
    const [agent] = await tx
      .insert(agents)
      .values({
        orgId, connectionId: conn!.id, address: selfAddress, domain: 'acme.test', displayName: 'Acme Support',
        status: 'active', priority: 0, signature: SIGNATURE,
        guidanceExtra: 'Keep replies to three sentences where you can.',
      })
      .returning({ id: agents.id })
    const cats = await tx.select({ id: categories.id, key: categories.key }).from(categories)
    return { connectionId: conn!.id, agentId: agent!.id, categoryId: cats.find((c) => c.key === 'order_status')!.id }
  })
  await seedFreshCredential(orgId, base.connectionId)
  return { orgId, ...base, selfAddress, mailbox: createMockMailbox({ mode, selfAddress }), mode }
}

/** A FRESH access token — `getAccessToken` returns it straight from the row, never calling `.refresh()`. */
async function seedFreshCredential(orgId: string, connectionId: string): Promise<void> {
  const { dek, version } = await withOrg(app.db, orgId, (tx) => loadOrgDek(tx, ring))
  const refreshToken = `refresh-${rand()}`
  const aad = `${orgId}:mailbox_credentials:${connectionId}`
  await withPlatform(app.db, 'test:seed-credential', (tx) =>
    tx.insert(mailboxCredentials).values({
      connectionId, orgId,
      refreshTokenCiphertext: encrypt(dek, Buffer.from(refreshToken, 'utf8'), aad),
      accessTokenCiphertext: encrypt(dek, Buffer.from(`access-${rand()}`, 'utf8'), aad),
      accessTokenExpiresAt: new Date(Date.now() + 3_600_000), // real wall clock: getAccessToken's freshness check is not on the job's injected clock
      refreshTokenHash: hashToken('refresh', refreshToken),
      encryption: 'dek', dataKeyVersion: version,
    }))
}

async function unexpireCredential(connectionId: string): Promise<void> {
  await withPlatform(app.db, 'test:unexpire-credential', (tx) =>
    tx.update(mailboxCredentials).set({ accessTokenExpiresAt: new Date(Date.now() + 3_600_000) })
      .where(eq(mailboxCredentials.connectionId, connectionId)))
}

async function expireCredential(connectionId: string): Promise<void> {
  await withPlatform(app.db, 'test:expire-credential', (tx) =>
    tx.update(mailboxCredentials).set({ accessTokenExpiresAt: new Date(Date.now() - 3_600_000) })
      .where(eq(mailboxCredentials.connectionId, connectionId)))
}

interface Seeded {
  ticketId: string
  draftId: string
  sendId: string
  threadId: string
  inbound: { id: string; rfcMessageId: string; sentAt: Date }[]
  threadSnapshotAt: Date
}

interface SeedOpts {
  inbounds?: number
  finalBody?: string
  subject?: string
  ticket?: Partial<typeof tickets.$inferInsert>
  draft?: Partial<typeof drafts.$inferInsert>
  send?: Partial<typeof outboundSends.$inferInsert>
}

/**
 * workspace -> connection -> agent (all from `seedOrg`) -> ticket (`awaiting_review`) -> inbound
 * messages MOCK-INGESTED (so their provider ids, rfc ids and thread id are the ones the mock
 * mailbox will actually serve a recovery scan) -> draft (`approved`, with a `final_body`) ->
 * `outbound_sends` (`queued`, `send_after` in the past).
 */
async function seedApprovedDraft(opts: SeedOpts = {}): Promise<Seeded> {
  const subject = opts.subject ?? 'Where is my order?'
  const count = opts.inbounds ?? 1
  const inbound: Seeded['inbound'] = []
  let threadId: string | undefined
  for (let i = 0; i < count; i++) {
    const received = fx.mailbox.receiveInbound({
      from: CUSTOMER, to: [fx.selfAddress], subject, bodyText: `Hi, where is my order? (${i})`, threadId,
    })
    threadId = received.threadId
    const meta = await fx.mailbox.getMessage(received.id, { format: 'metadata' })
    inbound.push({ id: received.id, rfcMessageId: meta.rfcMessageId!, sentAt: meta.internalDate })
  }
  // A thread with no inbound at all (the `no inbound message to reply to` pre-check) still needs a
  // provider thread id to scan: the mock simply has no messages under it.
  threadId ??= `mock-thread-empty-${rand()}`
  const lastInboundAt = inbound[inbound.length - 1]?.sentAt ?? null
  const threadSnapshotAt = lastInboundAt ?? NOW

  return withOrg(app.db, fx.orgId, async (tx) => {
    const [ticket] = await tx
      .insert(tickets)
      .values({
        orgId: fx.orgId, connectionId: fx.connectionId, agentId: fx.agentId, providerThreadId: threadId!,
        status: 'awaiting_review', categoryId: fx.categoryId, subject, language: 'en', sentiment: 'neutral',
        customerEmail: CUSTOMER, lastInboundAt, inboundCount: count, lastAgentRunAt: new Date(NOW.getTime() - 600_000),
        lastAgentFinishedAt: new Date(NOW.getTime() - 590_000), redraftCount: 1, ownerRedraftFeedback: 'be warmer',
        ...opts.ticket,
      })
      .returning({ id: tickets.id })
    for (const m of inbound) {
      await tx.insert(messages).values({
        orgId: fx.orgId, ticketId: ticket!.id, connectionId: fx.connectionId, providerMessageId: m.id,
        direction: 'inbound', fromAddress: CUSTOMER, toAddresses: [fx.selfAddress], subject,
        bodyText: 'Hi, where is my order?', rfcMessageId: m.rfcMessageId, dmarcPass: true, sentAt: m.sentAt,
      })
    }
    const [draft] = await tx
      .insert(drafts)
      .values({
        orgId: fx.orgId, ticketId: ticket!.id, agentId: fx.agentId, categoryId: fx.categoryId,
        body: CLEAN_BODY, finalBody: opts.finalBody ?? CLEAN_BODY, decision: 'review', decisionReason: 'below_threshold',
        status: 'approved', threadSnapshotAt, customerLanguage: 'en',
        expiresAt: new Date(NOW.getTime() + 86_400_000), decidedBy: userId, decidedAt: new Date(NOW.getTime() - 60_000),
        decisionSource: 'app',
        ...opts.draft,
      })
      .returning({ id: drafts.id })
    const [send] = await tx
      .insert(outboundSends)
      .values({
        orgId: fx.orgId, draftId: draft!.id, ticketId: ticket!.id, connectionId: fx.connectionId, agentId: fx.agentId,
        status: 'queued', sendAfter: new Date(NOW.getTime() - 60_000),
        ...opts.send,
      })
      .returning({ id: outboundSends.id })
    return { ticketId: ticket!.id, draftId: draft!.id, sendId: send!.id, threadId: threadId!, inbound, threadSnapshotAt }
  })
}

interface Harness {
  deps: SendExecuteDeps
  notified: { orgId: string; notificationId: string }[]
  draftEnqueues: { orgId: string; ticketId: string }[]
  sentEvents: { orgId: string; ticketId: string; draftId: string }[]
}

function makeDeps(over: Partial<SendExecuteDeps> = {}): Harness {
  const notified: Harness['notified'] = []
  const draftEnqueues: Harness['draftEnqueues'] = []
  const sentEvents: Harness['sentEvents'] = []
  const deps: SendExecuteDeps = {
    db: app.db,
    ring,
    config: baseConfig(),
    limiter: createMailLimiter(),
    logger: pino({ level: 'silent' }),
    enqueueNotify: async (orgId, notificationId) => void notified.push({ orgId, notificationId }),
    enqueueDraft: async (orgId, ticketId) => void draftEnqueues.push({ orgId, ticketId }),
    onSent: async (p) => void sentEvents.push(p),
    clientFactory: () => fx.mailbox,
    providerFactory: () => stubProvider(),
    now: monotonicClock(),
    ...over,
  }
  return { deps, notified, draftEnqueues, sentEvents }
}

function run(deps: SendExecuteDeps, sendId: string, ctx: { attempt?: number; lastAttempt?: boolean; signal?: AbortSignal } = {}): Promise<void> {
  return runSendExecute(
    deps,
    { orgId: fx.orgId, sendId },
    { signal: ctx.signal ?? new AbortController().signal, attempt: ctx.attempt ?? 1, lastAttempt: ctx.lastAttempt ?? false },
  )
}

// ---- reads -----------------------------------------------------------------

async function getSend(sendId: string) {
  const [row] = await withOrg(app.db, fx.orgId, (tx) => tx.select().from(outboundSends).where(eq(outboundSends.id, sendId)))
  return row!
}
async function getDraft(draftId: string) {
  const [row] = await withOrg(app.db, fx.orgId, (tx) => tx.select().from(drafts).where(eq(drafts.id, draftId)))
  return row!
}
async function getTicket(ticketId: string) {
  const [row] = await withOrg(app.db, fx.orgId, (tx) => tx.select().from(tickets).where(eq(tickets.id, ticketId)))
  return row!
}
async function outboundMessages(ticketId: string) {
  return withOrg(app.db, fx.orgId, (tx) =>
    tx.select().from(messages).where(and(eq(messages.ticketId, ticketId), eq(messages.direction, 'outbound'))))
}
async function auditActions(entityId: string): Promise<string[]> {
  const rows = await withOrg(app.db, fx.orgId, (tx) => tx.select().from(auditLog).where(eq(auditLog.entityId, entityId)))
  return rows.map((r) => r.action)
}
async function auditRows(action: string) {
  return withOrg(app.db, fx.orgId, (tx) => tx.select().from(auditLog).where(eq(auditLog.action, action)))
}
/** Summed across days — `usage_counters` is keyed by (org, day, meter), and two of these cases
 *  deliberately send in different months. */
async function meters(): Promise<Record<string, number>> {
  const rows = await withOrg(app.db, fx.orgId, (tx) => tx.select().from(usageCounters))
  const out: Record<string, number> = {}
  for (const r of rows) out[r.meter] = (out[r.meter] ?? 0) + r.value
  return out
}
async function orgNotifications() {
  return withOrg(app.db, fx.orgId, (tx) => tx.select().from(notifications))
}
function decodeRaw(raw: string): string {
  return Buffer.from(raw, 'base64url').toString()
}
function headerLine(decoded: string, name: string): string {
  const line = decoded.split('\r\n').find((l) => l.startsWith(`${name}: `))
  if (!line) throw new Error(`no ${name} header in\n${decoded.split('\r\n\r\n')[0]}`)
  return line.slice(name.length + 2)
}

// ============================================================================

describe('send.execute', () => {
  it('1+7-11 happy path (gmail): one threaded, marked, signed reply; ledger, draft, ticket, ONE message row, meters and audit', async () => {
    const s = await seedApprovedDraft()
    const { deps, sentEvents, draftEnqueues } = makeDeps()

    await run(deps, s.sendId)

    // --- what actually went out
    const sent = fx.mailbox.sentMessages()
    expect(sent).toHaveLength(1)
    expect(sent[0]!.markerDraftId).toBe(s.draftId)
    expect(sent[0]!.bodyText.endsWith(`\n\n${SIGNATURE}`)).toBe(true)
    const decoded = decodeRaw(sent[0]!.raw!)
    expect(headerLine(decoded, 'To')).toBe(CUSTOMER)
    expect(headerLine(decoded, 'From')).toBe(fx.selfAddress)
    expect(headerLine(decoded, 'Subject')).toBe('Re: Where is my order?')
    expect(headerLine(decoded, 'In-Reply-To')).toBe(s.inbound[0]!.rfcMessageId)
    expect(headerLine(decoded, 'References')).toBe(s.inbound[0]!.rfcMessageId)
    expect(headerLine(decoded, MARKER_HEADER)).toBe(s.draftId)

    // --- the ledger row
    const send = await getSend(s.sendId)
    expect(send.status).toBe('sent')
    expect(send.attempts).toBe(1)
    expect(send.providerMessageId).toBeTruthy()
    expect(send.providerThreadId).toBe(s.threadId)
    expect(send.rfcMessageId).toBe(`<${send.providerMessageId}@mock.aesa>`) // read back in step 10
    expect(send.sentAt).not.toBeNull()
    expect(send.lastError).toBeNull()

    expect((await getDraft(s.draftId)).status).toBe('sent')

    const ticket = await getTicket(s.ticketId)
    expect(ticket.status).toBe('waiting_on_customer')
    expect(ticket.redraftCount).toBe(0)
    expect(ticket.ownerRedraftFeedback).toBeNull()
    expect(ticket.aiHandledMonth).toBe(THIS_MONTH)
    expect(draftEnqueues).toHaveLength(0)

    // --- exactly one outbound message row, before AND after sync ingests the provider's own copy
    const before = await outboundMessages(s.ticketId)
    expect(before).toHaveLength(1)
    expect(before[0]!.draftId).toBe(s.draftId)
    expect(before[0]!.providerMessageId).toBe(send.providerMessageId)

    await runSync({
      db: app.db, client: fx.mailbox, orgId: fx.orgId, connectionId: fx.connectionId, provider: 'gmail',
      selfAddress: fx.selfAddress, platformSender: 'no-reply@aesa.test', tripwireExtras: [],
      onNewInboundTicket: () => {}, onTripwire: () => {},
    })
    expect(await outboundMessages(s.ticketId)).toHaveLength(1)

    // --- meters + audit
    expect(await meters()).toMatchObject({ [SEND_METERS.reviewSends]: 1, [SEND_METERS.aiHandledConversations]: 1 })
    expect(await auditActions(s.sendId)).toContain('send.sent')
    const [auditRow] = await auditRows('send.sent')
    expect(auditRow!.actor).toBe('system:send.execute')
    expect(auditRow!.detail).toMatchObject({ recovered: false, providerMessageId: send.providerMessageId })

    expect(sentEvents).toEqual([{ orgId: fx.orgId, ticketId: s.ticketId, draftId: s.draftId }])
  })

  it('7-8 happy path (graph): provider_draft_id is persisted BEFORE the send and the returned id is stored', async () => {
    fx = await seedOrg('graph')
    const s = await seedApprovedDraft()
    let persistedDuringCallback: string | null | undefined
    const wrapped: MailboxClient = {
      ...fx.mailbox,
      sendReply: (input: SendReplyInput) =>
        fx.mailbox.sendReply({
          ...input,
          onDraftCreated: async (providerDraftId) => {
            await input.onDraftCreated?.(providerDraftId)
            persistedDuringCallback = (await getSend(s.sendId)).providerDraftId
          },
        }),
    }
    const { deps } = makeDeps({ clientFactory: () => wrapped })

    await run(deps, s.sendId)

    const send = await getSend(s.sendId)
    expect(persistedDuringCallback).toBe(send.providerDraftId)
    expect(send.providerDraftId).toBeTruthy()
    expect(send.status).toBe('sent')
    // Graph keeps the draft's id after the send: the stored message IS the draft id.
    expect(send.providerMessageId).toBe(send.providerDraftId)
    expect(fx.mailbox.drafts().get(send.providerDraftId!)).toEqual({ threadId: s.threadId, sent: true })
  })

  it('11 ai_handled_conversations counts a ticket once a MONTH: a second send the same month does not, the next month does', async () => {
    const s = await seedApprovedDraft()
    await run(makeDeps().deps, s.sendId)

    const second = await seedSecondSend(s.ticketId)
    await run(makeDeps().deps, second.sendId)
    expect(await meters()).toMatchObject({ [SEND_METERS.reviewSends]: 2, [SEND_METERS.aiHandledConversations]: 1 })
    expect((await getTicket(s.ticketId)).aiHandledMonth).toBe(THIS_MONTH)

    const third = await seedSecondSend(s.ticketId)
    await run(makeDeps({ now: monotonicClock(new Date('2026-10-02T09:00:00Z')) }).deps, third.sendId)
    expect(await meters()).toMatchObject({ [SEND_METERS.reviewSends]: 3, [SEND_METERS.aiHandledConversations]: 2 })
    expect((await getTicket(s.ticketId)).aiHandledMonth).toBe('2026-10')
  })

  it('7 reply_from_address wins over the agent address as the From', async () => {
    await withOrg(app.db, fx.orgId, (tx) =>
      tx.update(agents).set({ replyFromAddress: 'hello@acme.test' }).where(eq(agents.id, fx.agentId)))
    const s = await seedApprovedDraft()

    await run(makeDeps().deps, s.sendId)

    expect(headerLine(decodeRaw(fx.mailbox.sentMessages()[0]!.raw!), 'From')).toBe('hello@acme.test')
  })

  it('1 a future send_after is not claimable: nothing is sent and nothing is written', async () => {
    const s = await seedApprovedDraft({ send: { sendAfter: new Date(NOW.getTime() + 600_000) } })

    await run(makeDeps().deps, s.sendId)

    expect(fx.mailbox.sentMessages()).toHaveLength(0)
    const send = await getSend(s.sendId)
    expect(send.status).toBe('queued')
    expect(send.attempts).toBe(0)
    expect((await getDraft(s.draftId)).status).toBe('approved')
  })

  it('1 a held row is not claimable: nothing happens', async () => {
    const s = await seedApprovedDraft({ send: { status: 'held', lastError: 'held:workspace_kill_switch' } })

    await run(makeDeps().deps, s.sendId)

    expect(fx.mailbox.sentMessages()).toHaveLength(0)
    expect((await getSend(s.sendId)).status).toBe('held')
    expect((await getSend(s.sendId)).attempts).toBe(0)
  })

  describe('1 kill levers', () => {
    const levers: [string, string, () => Promise<void>][] = [
      ['platform killswitch', 'held:platform_killswitch', async () => {
        await withPlatform(app.db, 'test:killswitch', (tx) =>
          tx.insert(platformState).values({ key: 'killswitch.global', value: true })
            .onConflictDoUpdate({ target: platformState.key, set: { value: true } }))
      }],
      ['workspace kill switch', 'held:workspace_kill_switch', async () => {
        await withOrg(app.db, fx.orgId, (tx) => tx.update(workspaces).set({ killSwitch: true }).where(eq(workspaces.orgId, fx.orgId)))
      }],
      ['agent disabled for the workspace', 'held:agent_disabled', async () => {
        await withOrg(app.db, fx.orgId, (tx) => tx.update(workspaces).set({ agentEnabled: false }).where(eq(workspaces.orgId, fx.orgId)))
      }],
      ['agent not active', 'held:agent_inactive', async () => {
        await withOrg(app.db, fx.orgId, (tx) => tx.update(agents).set({ status: 'disabled' }).where(eq(agents.id, fx.agentId)))
      }],
      ['connection not connected', 'held:connection_unavailable', async () => {
        await withOrg(app.db, fx.orgId, (tx) =>
          tx.update(mailboxConnections).set({ status: 'disabled' }).where(eq(mailboxConnections.id, fx.connectionId)))
      }],
      ['category mode off', 'held:category_off', async () => {
        await withOrg(app.db, fx.orgId, (tx) =>
          tx.insert(agentCategoryPolicies).values({ orgId: fx.orgId, agentId: fx.agentId, categoryId: fx.categoryId, mode: 'off' }))
      }],
    ]

    it.each(levers)('%s holds the send, holds the draft and pages the owner', async (_name, lastError, arm) => {
      const s = await seedApprovedDraft()
      await arm()
      const { deps, notified } = makeDeps()

      try {
        await run(deps, s.sendId)
      } finally {
        await withPlatform(app.db, 'test:killswitch', (tx) => tx.delete(platformState).where(eq(platformState.key, 'killswitch.global')))
      }

      expect(fx.mailbox.sentMessages()).toHaveLength(0)
      const send = await getSend(s.sendId)
      expect(send.status).toBe('held')
      expect(send.lastError).toBe(lastError)
      expect((await getDraft(s.draftId)).status).toBe('held')
      expect((await getTicket(s.ticketId)).status).toBe('awaiting_review')
      expect(await auditActions(s.sendId)).toContain('send.held')

      const rows = await orgNotifications()
      expect(rows).toHaveLength(1)
      expect(rows[0]!.kind).toBe('escalation')
      expect(rows[0]!.title).toMatch(/^Reply on hold — /)
      expect(rows[0]!.dedupeKey).toBe(`send_held:${s.sendId}:${TODAY}`)
      expect(rows[0]!.payload).toEqual({ ticketId: s.ticketId, draftId: s.draftId })
      expect(notified.map((n) => n.notificationId)).toEqual([rows[0]!.id])
    })
  })

  it('1 a draft that is no longer approved fails the send terminally', async () => {
    const s = await seedApprovedDraft({ draft: { status: 'rejected', rejectReason: 'wrong tone' } })
    const { deps } = makeDeps()

    await run(deps, s.sendId)

    expect(fx.mailbox.sentMessages()).toHaveLength(0)
    const send = await getSend(s.sendId)
    expect(send.status).toBe('failed')
    expect(send.lastError).toBe('draft not approved')
    expect((await getDraft(s.draftId)).status).toBe('rejected')
    expect(await auditActions(s.sendId)).toContain('send.failed')
  })

  it('2 the third-pass validator blocks an owner edit that smuggled in a link', async () => {
    const s = await seedApprovedDraft({ finalBody: `${CLEAN_BODY} See https://evil.com/deal for more.` })
    const { deps, notified } = makeDeps()

    await run(deps, s.sendId)

    expect(fx.mailbox.sentMessages()).toHaveLength(0)
    const send = await getSend(s.sendId)
    expect(send.status).toBe('failed')
    expect(send.lastError).toBe('guardrail:url_not_allowed')
    expect((await getDraft(s.draftId)).status).toBe('failed')
    const ticket = await getTicket(s.ticketId)
    expect(ticket.status).toBe('needs_owner')
    expect(ticket.needsOwnerReason).toBe('send_failed')
    expect(await auditActions(s.sendId)).toContain('send.failed')
    expect(notified).toHaveLength(1)
  })

  it('3 a ProviderAuthError holds the send and pages the owner to reconnect', async () => {
    const s = await seedApprovedDraft()
    await expireCredential(fx.connectionId)
    const { deps, notified } = makeDeps({
      providerFactory: () => stubProvider({ refresh: async () => { throw new ProviderAuthError('refresh rejected') } }),
      clientFactory: () => { throw new Error('must not build a client on a reauth failure') },
    })

    await run(deps, s.sendId)

    const send = await getSend(s.sendId)
    expect(send.status).toBe('held')
    expect(send.lastError).toBe('reauth_required')
    expect((await getDraft(s.draftId)).status).toBe('held')
    const rows = await orgNotifications()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.kind).toBe('mailbox_reauth')
    expect(rows[0]!.dedupeKey).toBe(`reauth:${fx.connectionId}:${TODAY}`)
    expect(notified).toHaveLength(1)
  })

  it('4 the recovery scan runs BEFORE the staleness guard: an already-delivered reply completes rather than being refused', async () => {
    const s = await seedApprovedDraft()
    // A previous attempt already put the reply on the thread (it crashed before recording it)...
    const already = await fx.mailbox.sendReply({
      threadId: s.threadId, to: CUSTOMER, subject: 'Where is my order?', inReplyTo: s.inbound[0]!.rfcMessageId,
      references: s.inbound[0]!.rfcMessageId, bodyText: CLEAN_BODY, from: fx.selfAddress,
      replyToProviderMessageId: s.inbound[0]!.id, extraHeaders: { [MARKER_HEADER]: s.draftId },
    })
    // ...and THEN the customer wrote again, which would make a fresh send stale.
    const newer = fx.mailbox.receiveInbound({ from: CUSTOMER, to: [fx.selfAddress], subject: 'Where is my order?', bodyText: 'any news?', threadId: s.threadId })
    const newerMeta = await fx.mailbox.getMessage(newer.id, { format: 'metadata' })
    await withOrg(app.db, fx.orgId, async (tx) => {
      await tx.insert(messages).values({
        orgId: fx.orgId, ticketId: s.ticketId, connectionId: fx.connectionId, providerMessageId: newer.id,
        direction: 'inbound', fromAddress: CUSTOMER, bodyText: 'any news?', rfcMessageId: newerMeta.rfcMessageId,
        dmarcPass: true, sentAt: newerMeta.internalDate,
      })
      await tx.update(tickets).set({ lastInboundAt: newerMeta.internalDate }).where(eq(tickets.id, s.ticketId))
    })
    const { deps, notified, draftEnqueues } = makeDeps()

    await run(deps, s.sendId)

    expect(fx.mailbox.sentMessages()).toHaveLength(1) // no second copy
    const send = await getSend(s.sendId)
    expect(send.status).toBe('sent')
    expect(send.providerMessageId).toBe(already.id)
    expect(send.lastError).toBeNull()
    expect((await getDraft(s.draftId)).status).toBe('sent')
    // The newer inbound landed after the snapshot, so the ticket goes back to the agent, not to the customer.
    const ticket = await getTicket(s.ticketId)
    expect(ticket.status).toBe('triaged')
    expect(ticket.lastAgentRunAt).toBeNull()
    expect(draftEnqueues).toEqual([{ orgId: fx.orgId, ticketId: s.ticketId }])
    expect(notified).toHaveLength(0)
    const [auditRow] = await auditRows('send.sent')
    expect(auditRow!.detail).toMatchObject({ recovered: true })
  })

  it('4 a MessageGone on the thread is skipped rather than aborting the scan', async () => {
    const s = await seedApprovedDraft()
    const already = await fx.mailbox.sendReply({
      threadId: s.threadId, to: CUSTOMER, subject: 'Where is my order?', inReplyTo: s.inbound[0]!.rfcMessageId,
      references: s.inbound[0]!.rfcMessageId, bodyText: CLEAN_BODY, from: fx.selfAddress,
      replyToProviderMessageId: s.inbound[0]!.id, extraHeaders: { [MARKER_HEADER]: s.draftId },
    })
    const owner = fx.mailbox.receiveOutbound({ to: [CUSTOMER], subject: 'Where is my order?', bodyText: 'hand-typed', threadId: s.threadId })
    fx.mailbox.deleteMessage(owner.id)

    await run(makeDeps().deps, s.sendId)

    expect(fx.mailbox.sentMessages()).toHaveLength(1)
    expect((await getSend(s.sendId)).providerMessageId).toBe(already.id)
  })

  it("4 the owner's own unmarked hand-reply in the crash window is NOT mistaken for ours", async () => {
    const s = await seedApprovedDraft()
    fx.mailbox.receiveOutbound({ to: [CUSTOMER], subject: 'Where is my order?', bodyText: 'I typed this myself', threadId: s.threadId })

    await run(makeDeps().deps, s.sendId)

    const sent = fx.mailbox.sentMessages()
    expect(sent).toHaveLength(1)
    expect(sent[0]!.markerDraftId).toBe(s.draftId)
    // inbound + the owner's own reply + ours
    expect(await fx.mailbox.getThreadMessageIds(s.threadId)).toHaveLength(3)
    expect((await getSend(s.sendId)).status).toBe('sent')
  })

  it('4 an unverifiable thread (scan limit exceeded) releases the claim for a retry and THROWS — it never sends blind', async () => {
    const s = await seedApprovedDraft()
    for (let i = 0; i <= RECOVERY_SCAN_LIMIT; i++) {
      fx.mailbox.receiveOutbound({ to: [CUSTOMER], subject: 'Where is my order?', bodyText: `copy ${i}`, threadId: s.threadId })
    }
    const { deps } = makeDeps()

    await expect(run(deps, s.sendId)).rejects.toBeInstanceOf(MailApiError)

    expect(fx.mailbox.sentMessages()).toHaveLength(0)
    const send = await getSend(s.sendId)
    expect(send.status).toBe('queued')
    expect(send.lastError).toMatch(/thread too busy/)
    expect(send.sendAfter.getTime()).toBeGreaterThan(NOW.getTime())
    expect(send.claimToken).toBeNull()
    expect((await getDraft(s.draftId)).status).toBe('approved')
  })

  it('5 a newer customer message aborts the send and hands the ticket back to the agent, KEEPING the redraft cycle', async () => {
    const s = await seedApprovedDraft()
    const newer = fx.mailbox.receiveInbound({ from: CUSTOMER, to: [fx.selfAddress], subject: 'Where is my order?', bodyText: 'never mind, it arrived', threadId: s.threadId })
    const newerMeta = await fx.mailbox.getMessage(newer.id, { format: 'metadata' })
    await withOrg(app.db, fx.orgId, async (tx) => {
      await tx.insert(messages).values({
        orgId: fx.orgId, ticketId: s.ticketId, connectionId: fx.connectionId, providerMessageId: newer.id,
        direction: 'inbound', fromAddress: CUSTOMER, bodyText: 'never mind', rfcMessageId: newerMeta.rfcMessageId,
        dmarcPass: true, sentAt: newerMeta.internalDate,
      })
      await tx.update(tickets).set({ lastInboundAt: newerMeta.internalDate }).where(eq(tickets.id, s.ticketId))
    })
    const { deps, notified, draftEnqueues } = makeDeps()

    await run(deps, s.sendId)

    expect(fx.mailbox.sentMessages()).toHaveLength(0)
    const send = await getSend(s.sendId)
    expect(send.status).toBe('failed')
    expect(send.lastError).toBe(STALE_ERROR)
    expect((await getDraft(s.draftId)).status).toBe('failed')

    const ticket = await getTicket(s.ticketId)
    expect(ticket.status).toBe('triaged')
    expect(ticket.lastAgentRunAt).toBeNull()
    // The owner's correction is still UNFULFILLED — it must ride into the fresh re-draft.
    expect(ticket.redraftCount).toBe(1)
    expect(ticket.ownerRedraftFeedback).toBe('be warmer')

    expect(await auditActions(s.sendId)).toContain('send.stale')
    const [staleAudit] = await auditRows('send.stale')
    expect(staleAudit!.detail).toMatchObject({ threadSnapshotAt: s.threadSnapshotAt.toISOString(), newerInboundAt: newerMeta.internalDate.toISOString() })

    const rows = await orgNotifications()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.dedupeKey).toBe(`send_stale:${s.sendId}`)
    expect(rows[0]!.payload).toEqual({ ticketId: s.ticketId })
    expect(notified).toHaveLength(1)
    expect(draftEnqueues).toEqual([{ orgId: fx.orgId, ticketId: s.ticketId }])
  })

  const preChecks: [string, string, () => Promise<Seeded>][] = [
    ['no customer email', 'ticket has no customer email', () => seedApprovedDraft({ ticket: { customerEmail: null } })],
    ['no inbound message', 'no inbound message to reply to', () => seedApprovedDraft({ inbounds: 0 })],
  ]
  it.each(preChecks)('6 %s fails the send terminally and escalates', async (_name, reason, seed) => {
    const s = await seed()
    const { deps, notified } = makeDeps()

    await run(deps, s.sendId)

    expect(fx.mailbox.sentMessages()).toHaveLength(0)
    const send = await getSend(s.sendId)
    expect(send.status).toBe('failed')
    expect(send.lastError).toBe(reason)
    expect((await getDraft(s.draftId)).status).toBe('failed')
    const ticket = await getTicket(s.ticketId)
    expect(ticket.status).toBe('needs_owner')
    expect(ticket.needsOwnerReason).toBe('send_failed')
    expect(notified).toHaveLength(1)
  })

  it('6 an inbound with no rfc message id and no threadable outbound fails terminally', async () => {
    const s = await seedApprovedDraft()
    await withOrg(app.db, fx.orgId, (tx) =>
      tx.update(messages).set({ rfcMessageId: null }).where(eq(messages.ticketId, s.ticketId)))

    await run(makeDeps().deps, s.sendId)

    expect(fx.mailbox.sentMessages()).toHaveLength(0)
    expect((await getSend(s.sendId)).lastError).toBe('no rfc message id to thread the reply onto')
    expect((await getTicket(s.ticketId)).needsOwnerReason).toBe('send_failed')
  })

  it('7 References keeps the thread ROOT and the newest ids, capped at 20, with In-Reply-To last', async () => {
    const s = await seedApprovedDraft({ inbounds: 23 })

    await run(makeDeps().deps, s.sendId)

    const refs = headerLine(decodeRaw(fx.mailbox.sentMessages()[0]!.raw!), 'References').split(' ')
    expect(refs).toHaveLength(20)
    expect(refs[0]).toBe(s.inbound[0]!.rfcMessageId)
    expect(refs[19]).toBe(s.inbound[22]!.rfcMessageId)
  })

  it('7 a runaway subject is capped so the Subject header stays inside RFC 5322 limits', async () => {
    const long = 'x'.repeat(1200)
    const s = await seedApprovedDraft({ subject: long })

    await run(makeDeps().deps, s.sendId)

    expect(headerLine(decodeRaw(fx.mailbox.sentMessages()[0]!.raw!), 'Subject')).toBe(`Re: ${'x'.repeat(OUTBOUND_SUBJECT_MAX_CHARS)}`)
    expect((await outboundMessages(s.ticketId))[0]!.subject).toHaveLength(OUTBOUND_SUBJECT_MAX_CHARS)
  })

  it('8-9 a crash AFTER the customer has the mail is recovered by marker on the retry — never a second copy', async () => {
    const s = await seedApprovedDraft()
    fx.mailbox.failAfter('send', new Error('socket hung up after the send'))
    const { deps } = makeDeps()

    await expect(run(deps, s.sendId)).rejects.toThrow(/socket hung up/)

    const crashed = await getSend(s.sendId)
    expect(crashed.status).toBe('claimed')
    // The claim horizon is collapsed so the retry can reclaim immediately and scan first.
    expect(crashed.claimExpiresAt!.getTime()).toBeLessThanOrEqual(Date.now())
    expect(crashed.lastError).toMatch(/socket hung up/)
    expect((await getDraft(s.draftId)).status).toBe('sending')
    expect(fx.mailbox.sentMessages()).toHaveLength(1)

    await run(deps, s.sendId)

    expect(fx.mailbox.sentMessages()).toHaveLength(1) // still ONE
    const send = await getSend(s.sendId)
    expect(send.status).toBe('sent')
    expect(send.attempts).toBe(2)
    expect((await getDraft(s.draftId)).status).toBe('sent')
    expect(await outboundMessages(s.ticketId)).toHaveLength(1)
    expect((await getTicket(s.ticketId)).status).toBe('waiting_on_customer')
  })

  it('8-9 a graph crash AFTER createReply re-enters through the persisted provider_draft_id — one draft, one message', async () => {
    fx = await seedOrg('graph')
    const s = await seedApprovedDraft()
    fx.mailbox.failAfter('createReply', new Error('502 from graph after createReply'))
    const { deps } = makeDeps()

    await expect(run(deps, s.sendId)).rejects.toThrow(/502 from graph/)

    const crashed = await getSend(s.sendId)
    expect(crashed.providerDraftId).toBeTruthy()
    expect(fx.mailbox.sentMessages()).toHaveLength(0)
    expect(fx.mailbox.drafts().get(crashed.providerDraftId!)).toEqual({ threadId: s.threadId, sent: false })

    await run(deps, s.sendId)

    expect(fx.mailbox.sentMessages()).toHaveLength(1)
    expect(fx.mailbox.drafts().size).toBe(1)
    expect(fx.mailbox.drafts().get(crashed.providerDraftId!)!.sent).toBe(true)
    const send = await getSend(s.sendId)
    expect(send.status).toBe('sent')
    expect(send.providerMessageId).toBe(crashed.providerDraftId)
    expect(await outboundMessages(s.ticketId)).toHaveLength(1)
  })

  it('1+11 double delivery is impossible: a second sequential run is a no-op on an already-sent row', async () => {
    const s = await seedApprovedDraft()
    const { deps } = makeDeps()

    await run(deps, s.sendId)
    await run(deps, s.sendId)

    expect(fx.mailbox.sentMessages()).toHaveLength(1)
    const send = await getSend(s.sendId)
    expect(send.status).toBe('sent')
    expect(send.attempts).toBe(1) // the second run never even claimed
    expect(await outboundMessages(s.ticketId)).toHaveLength(1)
  })

  it('1 two concurrent runs: exactly one claims, exactly one message goes out', async () => {
    const s = await seedApprovedDraft()
    const { deps } = makeDeps()

    await Promise.all([run(deps, s.sendId), run(deps, s.sendId)])

    expect(fx.mailbox.sentMessages()).toHaveLength(1)
    expect((await getSend(s.sendId)).status).toBe('sent')
    expect((await getSend(s.sendId)).attempts).toBe(1)
    expect(await outboundMessages(s.ticketId)).toHaveLength(1)
  })

  it('11 an inbound that lands DURING the send hands the ticket back to the agent instead of parking it', async () => {
    const s = await seedApprovedDraft()
    const wrapped: MailboxClient = {
      ...fx.mailbox,
      sendReply: async (input: SendReplyInput) => {
        const newer = fx.mailbox.receiveInbound({ from: CUSTOMER, to: [fx.selfAddress], subject: 'Where is my order?', bodyText: 'one more thing', threadId: s.threadId })
        const meta = await fx.mailbox.getMessage(newer.id, { format: 'metadata' })
        await withOrg(app.db, fx.orgId, async (tx) => {
          await tx.insert(messages).values({
            orgId: fx.orgId, ticketId: s.ticketId, connectionId: fx.connectionId, providerMessageId: newer.id,
            direction: 'inbound', fromAddress: CUSTOMER, bodyText: 'one more thing', rfcMessageId: meta.rfcMessageId,
            dmarcPass: true, sentAt: meta.internalDate,
          })
          await tx.update(tickets).set({ lastInboundAt: meta.internalDate }).where(eq(tickets.id, s.ticketId))
        })
        return fx.mailbox.sendReply(input)
      },
    }
    const { deps, draftEnqueues } = makeDeps({ clientFactory: () => wrapped })

    await run(deps, s.sendId)

    expect(fx.mailbox.sentMessages()).toHaveLength(1) // the reply DID go out
    expect((await getSend(s.sendId)).status).toBe('sent')
    const ticket = await getTicket(s.ticketId)
    expect(ticket.status).toBe('triaged')
    expect(ticket.lastAgentRunAt).toBeNull()
    // The reply shipped, so the owner's correction is fulfilled and the cycle is cleared.
    expect(ticket.redraftCount).toBe(0)
    expect(ticket.ownerRedraftFeedback).toBeNull()
    expect(draftEnqueues).toEqual([{ orgId: fx.orgId, ticketId: s.ticketId }])
  })

  it('10 a failed read-back is best-effort: the send still completes without an rfc id', async () => {
    const s = await seedApprovedDraft()
    fx.mailbox.failNext('getMessage', new MailApiError('backend error', 500))
    const { deps } = makeDeps()

    await run(deps, s.sendId)

    const send = await getSend(s.sendId)
    expect(send.status).toBe('sent')
    expect(send.rfcMessageId).toBeNull()
    expect(await outboundMessages(s.ticketId)).toHaveLength(1)
  })

  it('11 when the mailbox poll wins the race and ingests our sent copy first, the upsert still leaves exactly ONE row', async () => {
    const s = await seedApprovedDraft()
    const sync = () =>
      runSync({
        db: app.db, client: fx.mailbox, orgId: fx.orgId, connectionId: fx.connectionId, provider: 'gmail',
        selfAddress: fx.selfAddress, platformSender: 'no-reply@aesa.test', tripwireExtras: [],
        onNewInboundTicket: () => {}, onTripwire: () => {},
      })
    await sync() // seeds the connection cursor; nothing to ingest yet
    const wrapped: MailboxClient = {
      ...fx.mailbox,
      sendReply: async (input: SendReplyInput) => {
        const sent = await fx.mailbox.sendReply(input)
        await sync() // the poll sees the SENT copy before completeSend records it
        return sent
      },
    }
    const { deps } = makeDeps({ clientFactory: () => wrapped })

    await run(deps, s.sendId)

    const rows = await outboundMessages(s.ticketId)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.draftId).toBe(s.draftId)
    expect(rows[0]!.rfcMessageId).toBe(`<${rows[0]!.providerMessageId}@mock.aesa>`)
    expect((await getSend(s.sendId)).status).toBe('sent')
  })

  it('12 the last attempt dead-letters: the send and draft fail and the ticket goes to the owner', async () => {
    const s = await seedApprovedDraft()
    const wrapped: MailboxClient = { ...fx.mailbox, sendReply: async () => { throw new MailApiError('backend error', 500) } }
    const { deps, notified } = makeDeps({ clientFactory: () => wrapped })

    await expect(run(deps, s.sendId, { attempt: 6, lastAttempt: true })).rejects.toBeInstanceOf(MailApiError)

    const send = await getSend(s.sendId)
    expect(send.status).toBe('failed')
    expect(send.lastError).toMatch(/backend error/)
    expect((await getDraft(s.draftId)).status).toBe('failed')
    const ticket = await getTicket(s.ticketId)
    expect(ticket.status).toBe('needs_owner')
    expect(ticket.needsOwnerReason).toBe('send_failed')
    expect(await auditActions(s.sendId)).toContain('send.dead_letter')
    expect(notified).toHaveLength(1)
  })

  it('12 a non-final attempt does NOT dead-letter: the claim horizon collapses and the error propagates for the retry', async () => {
    const s = await seedApprovedDraft()
    const wrapped: MailboxClient = { ...fx.mailbox, sendReply: async () => { throw new MailApiError('backend error', 500) } }
    const { deps, notified } = makeDeps({ clientFactory: () => wrapped })

    await expect(run(deps, s.sendId, { attempt: 1, lastAttempt: false })).rejects.toBeInstanceOf(MailApiError)

    const send = await getSend(s.sendId)
    expect(send.status).toBe('claimed')
    expect(send.claimExpiresAt!.getTime()).toBeLessThanOrEqual(Date.now())
    expect((await getDraft(s.draftId)).status).toBe('sending')
    expect((await getTicket(s.ticketId)).status).toBe('awaiting_review')
    expect(notified).toHaveLength(0)
  })

  it('8 a job past its deadline releases the claim instead of starting a send nobody is waiting on', async () => {
    const s = await seedApprovedDraft()
    const { deps } = makeDeps()

    await run(deps, s.sendId, { signal: AbortSignal.abort() })

    expect(fx.mailbox.sentMessages()).toHaveLength(0)
    const send = await getSend(s.sendId)
    expect(send.status).toBe('queued')
    expect(send.claimToken).toBeNull()
    expect((await getDraft(s.draftId)).status).toBe('approved')
  })

  // ---- the crash re-entry: kill levers run AFTER the recovery scan (controller ruling) ----

  it('A1 a crash re-entry whose scan HITS completes even with a kill lever on — the customer already has the mail', async () => {
    const s = await seedApprovedDraft()
    const already = await putMarkedReplyOnThread(s)
    await asCrashReEntry(s)
    await withOrg(app.db, fx.orgId, (tx) => tx.update(workspaces).set({ killSwitch: true }).where(eq(workspaces.orgId, fx.orgId)))
    const { deps, notified } = makeDeps()

    await run(deps, s.sendId)

    expect(fx.mailbox.sentMessages()).toHaveLength(1)
    const send = await getSend(s.sendId)
    expect(send.status).toBe('sent')
    expect(send.providerMessageId).toBe(already.id)
    expect((await getDraft(s.draftId)).status).toBe('sent')
    expect(await auditActions(s.sendId)).not.toContain('send.held')
    expect(notified).toHaveLength(0)
    expect((await getTicket(s.ticketId)).status).toBe('waiting_on_customer')
  })

  it('A2 a crash re-entry whose scan MISSES applies the lever, moving the send AND the draft to held together', async () => {
    const s = await seedApprovedDraft()
    await asCrashReEntry(s)
    await withOrg(app.db, fx.orgId, (tx) => tx.update(workspaces).set({ killSwitch: true }).where(eq(workspaces.orgId, fx.orgId)))
    const { deps, notified } = makeDeps()

    await run(deps, s.sendId)

    expect(fx.mailbox.sentMessages()).toHaveLength(0)
    const send = await getSend(s.sendId)
    expect(send.status).toBe('held')
    expect(send.lastError).toBe('held:workspace_kill_switch')
    // `sending → held` (added to draftTransitions): a held send beside a `sending` draft is stuck forever.
    expect((await getDraft(s.draftId)).status).toBe('held')
    const rows = await orgNotifications()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.dedupeKey).toBe(`send_held:${s.sendId}:${TODAY}`)
    expect(notified).toHaveLength(1)
  })

  it('A3 a reauth on a crash re-entry releases for a retry and THROWS — delivery is unverified, so nothing is held', async () => {
    const s = await seedApprovedDraft()
    await asCrashReEntry(s)
    await expireCredential(fx.connectionId)
    const { deps, notified } = makeDeps({
      providerFactory: () => stubProvider({ refresh: async () => { throw new ProviderAuthError('refresh rejected') } }),
      clientFactory: () => { throw new Error('must not build a client on a reauth failure') },
    })

    await expect(run(deps, s.sendId)).rejects.toBeInstanceOf(ProviderAuthError)

    const send = await getSend(s.sendId)
    expect(send.status).toBe('queued')
    expect(send.lastError).toBe('reauth_required: delivery unverified')
    expect(send.sendAfter.getTime()).toBeGreaterThan(NOW.getTime())
    expect(send.claimToken).toBeNull()
    // Still `sending`: only the marker scan may decide what happened to it.
    expect((await getDraft(s.draftId)).status).toBe('sending')
    const rows = await orgNotifications()
    expect(rows.map((r) => r.kind)).toEqual(['mailbox_reauth'])
    expect(notified).toHaveLength(1)
  })

  it('A4 a stale crash re-entry fails the draft too, instead of stranding it in sending', async () => {
    const s = await seedApprovedDraft()
    await asCrashReEntry(s)
    await addNewerInbound(s, 'never mind, it arrived')
    const { deps, draftEnqueues } = makeDeps()

    await run(deps, s.sendId)

    expect(fx.mailbox.sentMessages()).toHaveLength(0)
    const send = await getSend(s.sendId)
    expect(send.status).toBe('failed')
    expect(send.lastError).toBe(STALE_ERROR)
    expect((await getDraft(s.draftId)).status).toBe('failed')
    const ticket = await getTicket(s.ticketId)
    expect(ticket.status).toBe('triaged')
    expect(ticket.lastAgentRunAt).toBeNull()
    expect(draftEnqueues).toEqual([{ orgId: fx.orgId, ticketId: s.ticketId }])
  })

  // ---- review round 1: the completion gate, the dead-letter guard, the claim collapse ----

  it('I2 a deadline-overlap retry that completed first leaves this run writing no second meter, audit row or onSent', async () => {
    const s = await seedApprovedDraft()
    // `expireInSeconds` equals the claim horizon, so pg-boss can start a retry while this handler is
    // still inside its provider call. The retry reclaims (the horizon lapsed at the same instant),
    // recovers by marker and completes. This wrapper is that winning worker, injected at the exact
    // point the real one would land: after our send, before our completeSend.
    const wrapped: MailboxClient = {
      ...fx.mailbox,
      getMessage: async (id, opts) => {
        const meta = await fx.mailbox.getMessage(id, opts)
        await withOrg(app.db, fx.orgId, async (tx) => {
          await tx.update(outboundSends).set({ status: 'sent', providerMessageId: id, sentAt: NOW }).where(eq(outboundSends.id, s.sendId))
          await tx.update(drafts).set({ status: 'sent' }).where(eq(drafts.id, s.draftId))
          await bumpMeter(tx, fx.orgId, TODAY, SEND_METERS.reviewSends, 1)
          await audit(tx, {
            actor: 'system:send.execute', action: 'send.sent', entityType: 'outbound_send', entityId: s.sendId,
            detail: { recovered: true, providerMessageId: id },
          })
        })
        return meta
      },
    }
    const { deps, sentEvents } = makeDeps({ clientFactory: () => wrapped })

    await run(deps, s.sendId)

    // One reply, one meter, one audit row, one onSent — `review_sends` is a billing meter.
    expect(fx.mailbox.sentMessages()).toHaveLength(1)
    expect(await meters()).toMatchObject({ [SEND_METERS.reviewSends]: 1 })
    expect(await auditRows('send.sent')).toHaveLength(1)
    expect(sentEvents).toHaveLength(0)
    expect(await outboundMessages(s.ticketId)).toHaveLength(1)
    expect((await getSend(s.sendId)).status).toBe('sent')
  })

  it('I1 a post-commit hook failure on the last attempt never flips a delivered send to failed', async () => {
    const s = await seedApprovedDraft()
    const { deps, notified } = makeDeps({ onSent: async () => { throw new Error('memory.capture is down') } })

    // completeSend swallows the hook failure, so the run resolves and the ledger stays `sent`.
    await run(deps, s.sendId, { attempt: 6, lastAttempt: true })

    const send = await getSend(s.sendId)
    expect(send.status).toBe('sent')
    expect(send.sentAt).not.toBeNull()
    expect((await getDraft(s.draftId)).status).toBe('sent')
    expect(await auditActions(s.sendId)).not.toContain('send.dead_letter')
    expect((await getTicket(s.ticketId)).status).toBe('waiting_on_customer')
    expect(notified).toHaveLength(0)
  })

  it('I1 a last-attempt throw on a row an overlapping retry already completed neither dead-letters nor downgrades it', async () => {
    const s = await seedApprovedDraft();
    (await putMarkedReplyOnThread(s))
    await asCrashReEntry(s)
    // The overlap winner completes the reply while we are inside the scan; our scan then fails.
    const wrapped: MailboxClient = {
      ...fx.mailbox,
      findSentByMarker: async () => {
        await withOrg(app.db, fx.orgId, async (tx) => {
          await tx.update(outboundSends).set({ status: 'sent', sentAt: NOW }).where(eq(outboundSends.id, s.sendId))
          await tx.update(drafts).set({ status: 'sent' }).where(eq(drafts.id, s.draftId))
        })
        throw new MailApiError('backend error', 500)
      },
    }
    const { deps, notified } = makeDeps({ clientFactory: () => wrapped })

    await expect(run(deps, s.sendId, { attempt: 6, lastAttempt: true })).rejects.toBeInstanceOf(MailApiError)

    const send = await getSend(s.sendId)
    expect(send.status).toBe('sent') // neither the scan release nor the dead-letter touched it
    expect(send.sentAt).not.toBeNull()
    expect((await getDraft(s.draftId)).status).toBe('sent')
    expect(await auditActions(s.sendId)).not.toContain('send.dead_letter')
    expect((await getTicket(s.ticketId)).status).not.toBe('needs_owner')
    expect(notified).toHaveLength(0)
  })

  it('I3 a throw between the committed claim and the send collapses the claim horizon so the very next retry reclaims', async () => {
    const s = await seedApprovedDraft()
    await expireCredential(fx.connectionId)
    const { deps } = makeDeps({
      providerFactory: () => stubProvider({ refresh: async () => { throw new Error('provider 503') } }),
      clientFactory: () => { throw new Error('must not build a client') },
    })

    await expect(run(deps, s.sendId)).rejects.toThrow(/provider 503/)

    const send = await getSend(s.sendId)
    expect(send.status).toBe('claimed')
    expect(send.claimExpiresAt!.getTime()).toBeLessThanOrEqual(Date.now())
    expect(send.lastError).toMatch(/provider 503/)
    // Proof the collapse is what matters: the very next retry reclaims and reaches the mailbox.
    // (Without it the row stays claimed until `now + 600 s` and attempts 2-4 return silently.)
    await unexpireCredential(fx.connectionId)
    const { deps: healthy } = makeDeps({ now: monotonicClock(new Date(NOW.getTime() + 60_000)) })
    await run(healthy, s.sendId)
    expect((await getSend(s.sendId)).status).toBe('sent')
    expect((await getSend(s.sendId)).attempts).toBe(2)
  })

  it('M2 a send_failed escalation still pages when the ticket already paged today for another reason', async () => {
    const s = await seedApprovedDraft({ ticket: { customerEmail: null } })
    await withOrg(app.db, fx.orgId, (tx) =>
      tx.insert(notifications).values({
        orgId: fx.orgId, kind: 'escalation', title: 'Draft blocked', body: 'earlier today',
        dedupeKey: `escalation:${s.ticketId}:${TODAY}`, payload: { ticketId: s.ticketId },
      }))
    const { deps, notified } = makeDeps()

    await run(deps, s.sendId)

    const rows = await orgNotifications()
    expect(rows.map((r) => r.dedupeKey).sort()).toEqual([`escalation:${s.ticketId}:${TODAY}`, `send_failed:${s.ticketId}:${TODAY}`].sort())
    expect(notified).toHaveLength(1)
  })

  it('1 the claim horizon is real: a live claim held by another worker is not stealable', async () => {
    const s = await seedApprovedDraft()
    await withOrg(app.db, fx.orgId, (tx) =>
      tx.update(outboundSends)
        .set({
          status: 'claimed', claimedAt: NOW, claimToken: crypto.randomUUID(),
          claimExpiresAt: new Date(NOW.getTime() + INVARIANTS.SEND_CLAIM_HORIZON_SECONDS * 1000),
        })
        .where(eq(outboundSends.id, s.sendId)))

    await run(makeDeps().deps, s.sendId)

    expect(fx.mailbox.sentMessages()).toHaveLength(0)
    expect((await getSend(s.sendId)).attempts).toBe(0)
  })
})

/**
 * Rewrites a seeded fixture into a CRASH RE-ENTRY: the draft is `sending` (a prior attempt got past
 * the pre-send flip) and the send row is `claimed` with a horizon step 9 already collapsed, so the
 * next run re-claims it. This is the state every deferred-lever case starts from.
 */
async function asCrashReEntry(s: Seeded, opts: { providerDraftId?: string } = {}): Promise<void> {
  await withOrg(app.db, fx.orgId, async (tx) => {
    await tx.update(drafts).set({ status: 'sending' }).where(eq(drafts.id, s.draftId))
    await tx
      .update(outboundSends)
      .set({
        status: 'claimed', claimedAt: new Date(NOW.getTime() - 1000), claimExpiresAt: new Date(NOW.getTime() - 1000),
        claimToken: crypto.randomUUID(), attempts: 1, lastError: 'socket hung up',
        ...(opts.providerDraftId ? { providerDraftId: opts.providerDraftId } : {}),
      })
      .where(eq(outboundSends.id, s.sendId))
  })
}

/** Puts a marked copy of the reply on the thread, as a crashed prior attempt would have left it. */
async function putMarkedReplyOnThread(s: Seeded): Promise<{ id: string }> {
  return fx.mailbox.sendReply({
    threadId: s.threadId, to: CUSTOMER, subject: 'Where is my order?', inReplyTo: s.inbound[0]!.rfcMessageId,
    references: s.inbound[0]!.rfcMessageId, bodyText: CLEAN_BODY, from: fx.selfAddress,
    replyToProviderMessageId: s.inbound[0]!.id, extraHeaders: { [MARKER_HEADER]: s.draftId },
  })
}

/** Adds an inbound newer than the draft's snapshot, in the mock AND in the ticket's thread. */
async function addNewerInbound(s: Seeded, body = 'any news?'): Promise<Date> {
  const newer = fx.mailbox.receiveInbound({ from: CUSTOMER, to: [fx.selfAddress], subject: 'Where is my order?', bodyText: body, threadId: s.threadId })
  const meta = await fx.mailbox.getMessage(newer.id, { format: 'metadata' })
  await withOrg(app.db, fx.orgId, async (tx) => {
    await tx.insert(messages).values({
      orgId: fx.orgId, ticketId: s.ticketId, connectionId: fx.connectionId, providerMessageId: newer.id,
      direction: 'inbound', fromAddress: CUSTOMER, bodyText: body, rfcMessageId: meta.rfcMessageId,
      dmarcPass: true, sentAt: meta.internalDate,
    })
    await tx.update(tickets).set({ lastInboundAt: meta.internalDate }).where(eq(tickets.id, s.ticketId))
  })
  return meta.internalDate
}

/** A follow-up approved draft + send row on an already-answered ticket (the month-meter cases). */
async function seedSecondSend(ticketId: string): Promise<{ draftId: string; sendId: string }> {
  return withOrg(app.db, fx.orgId, async (tx) => {
    const [ticket] = await tx.select().from(tickets).where(eq(tickets.id, ticketId))
    await tx.update(tickets).set({ status: 'awaiting_review' }).where(eq(tickets.id, ticketId))
    const [draft] = await tx
      .insert(drafts)
      .values({
        orgId: fx.orgId, ticketId, agentId: fx.agentId, categoryId: fx.categoryId, version: 2,
        body: CLEAN_BODY, finalBody: CLEAN_BODY, decision: 'review', decisionReason: 'below_threshold',
        status: 'approved', threadSnapshotAt: ticket!.lastInboundAt!, customerLanguage: 'en',
        expiresAt: new Date(NOW.getTime() + 86_400_000), decidedBy: userId, decisionSource: 'app',
      })
      .returning({ id: drafts.id })
    const [send] = await tx
      .insert(outboundSends)
      .values({
        orgId: fx.orgId, draftId: draft!.id, ticketId, connectionId: fx.connectionId, agentId: fx.agentId,
        status: 'queued', sendAfter: new Date(NOW.getTime() - 60_000),
      })
      .returning({ id: outboundSends.id })
    return { draftId: draft!.id, sendId: send!.id }
  })
}
