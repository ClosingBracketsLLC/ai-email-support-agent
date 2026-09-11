/**
 * `runTicketTriage` against Postgres + a `FakeProvider` (or a hand-built `LlmProvider` for the two
 * scenarios that need to observe state DURING the model call: the spend-guard ordering and the
 * concurrent-owner race). No pg-boss involved — `registerTicketTriage` is thin and untested here;
 * the retry path (rule 7 below threshold) is proven by asserting `runTicketTriage` itself throws,
 * which is exactly what makes pg-boss retry it.
 *
 * One `it` per numbered job-behavior rule in the task brief.
 */
import { randomBytes } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import pino from 'pino'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { TriageVerdict } from '@aesa/contracts'
import {
  auditLog, categories, ensureDefaultCategories, mailboxConnections, messages, notifications, orgSettings,
  tickets, usageCounters, user, withOrg, workspaces,
} from '@aesa/db'
import { createDb } from '@aesa/db/raw'
import { createTestDatabase, createTestOrganization } from '@aesa/db/testing'
import { createFakeProvider, LlmError, type Capabilities, type ChatRequest, type ChatResult, type LlmProvider } from '@aesa/llm'
import { runTicketTriage, type TicketTriageDeps } from '../src/jobs/ticket-triage.ts'

const rand = () => randomBytes(4).toString('hex')
const NOW = new Date('2026-09-09T12:00:00Z')
const TODAY = '2026-09-09'

const BASE_VERDICT: TriageVerdict = {
  categoryKey: 'order_status',
  language: 'en',
  sentiment: 'neutral',
  isSpam: false,
  isAutomated: false,
  escalationFlags: [],
  questions: [],
}

// `LlmProvider.capabilities()` is required on the interface (Task 6); these two hand-built spy
// providers never exercise it, so a fixed stand-in is enough.
const SPY_CAPABILITIES: Capabilities = { structuredOutput: 'native', tools: true, effort: true, cacheMinTokens: 512 }

let t: Awaited<ReturnType<typeof createTestDatabase>>
let app: ReturnType<typeof createDb>
let orgId: string
let userId: string
let connectionId: string
let otherCategoryId: string

beforeAll(async () => {
  t = await createTestDatabase()
  app = createDb(t.url)
  orgId = await createTestOrganization(app)
  const [u] = await app.db.insert(user).values({ name: 'Owner', email: `owner-${rand()}@example.com` }).returning()
  userId = u!.id

  connectionId = await withOrg(app.db, orgId, async (tx) => {
    const [row] = await tx
      .insert(mailboxConnections)
      .values({ orgId, provider: 'gmail', providerAccountId: `acct-${rand()}`, emailAddress: `support-${rand()}@acme.test`, status: 'connected', connectedByUserId: userId })
      .returning({ id: mailboxConnections.id })
    return row!.id
  })

  await withOrg(app.db, orgId, async (tx) => {
    await tx.insert(workspaces).values({ orgId, businessName: 'Acme Dog Supplies', timezone: 'UTC' })
    await ensureDefaultCategories(tx)
  })
  const [other] = await withOrg(app.db, orgId, (tx) => tx.select({ id: categories.id }).from(categories).where(eq(categories.key, 'other')))
  otherCategoryId = other!.id
})
afterAll(async () => {
  await app.pool.end()
  await t.drop()
})

// Every test shares one org, so one usage_counters row per (orgId, day, meter) and the org's
// settings rows are shared state too. Reset both before EVERY test rather than relying on
// end-of-test cleanup — a test that fails an assertion partway through must not leak the
// daily-cap override or the counter value into the next test.
beforeEach(async () => {
  await setUsageCounter(TODAY, 0)
  await setOrgSetting('triage.daily_cap', 6000)
  await setOrgSetting('support.spam_shortcircuit.always', false)
})

async function seedTicket(overrides: Partial<typeof tickets.$inferInsert> = {}): Promise<string> {
  const [row] = await withOrg(app.db, orgId, (tx) =>
    tx.insert(tickets).values({ orgId, connectionId, providerThreadId: `thread-${rand()}`, status: 'new', ...overrides }).returning({ id: tickets.id }))
  return row!.id
}

async function seedInboundMessage(ticketId: string, bodyText: string, sentAt: Date): Promise<void> {
  await withOrg(app.db, orgId, (tx) =>
    tx.insert(messages).values({ orgId, ticketId, connectionId, providerMessageId: `msg-${rand()}`, direction: 'inbound', bodyText, sentAt }))
}

async function getTicket(ticketId: string) {
  const [row] = await withOrg(app.db, orgId, (tx) => tx.select().from(tickets).where(eq(tickets.id, ticketId)))
  return row!
}

async function setOrgSetting(key: string, value: unknown): Promise<void> {
  await withOrg(app.db, orgId, (tx) =>
    tx.insert(orgSettings).values({ orgId, key, value }).onConflictDoUpdate({ target: [orgSettings.orgId, orgSettings.key], set: { value } }))
}

async function setUsageCounter(day: string, value: number): Promise<void> {
  await withOrg(app.db, orgId, (tx) =>
    tx
      .insert(usageCounters)
      .values({ orgId, day, meter: 'triage_calls', value })
      .onConflictDoUpdate({ target: [usageCounters.orgId, usageCounters.day, usageCounters.meter], set: { value } }))
}

async function readUsageCounter(day: string): Promise<number> {
  const [row] = await withOrg(app.db, orgId, (tx) =>
    tx.select({ value: usageCounters.value }).from(usageCounters).where(and(eq(usageCounters.day, day), eq(usageCounters.meter, 'triage_calls'))))
  return row?.value ?? 0
}

async function auditRowsFor(ticketId: string, action: string) {
  return withOrg(app.db, orgId, (tx) => tx.select().from(auditLog).where(and(eq(auditLog.entityId, ticketId), eq(auditLog.action, action))))
}

async function notificationsFor(dedupeKey: string) {
  return withOrg(app.db, orgId, (tx) => tx.select().from(notifications).where(eq(notifications.dedupeKey, dedupeKey)))
}

function makeDeps(provider: LlmProvider): {
  deps: TicketTriageDeps
  notified: { orgId: string; notificationId: string }[]
  drafted: { orgId: string; ticketId: string }[]
} {
  const notified: { orgId: string; notificationId: string }[] = []
  const drafted: { orgId: string; ticketId: string }[] = []
  const deps: TicketTriageDeps = {
    db: app.db,
    provider,
    logger: pino({ level: 'silent' }),
    enqueueNotify: async (org, notificationId) => {
      notified.push({ orgId: org, notificationId })
    },
    enqueueDraft: async (org, ticketId) => {
      drafted.push({ orgId: org, ticketId })
    },
    now: () => NOW,
  }
  return { deps, notified, drafted }
}

function verdictProvider(verdict: TriageVerdict): ReturnType<typeof createFakeProvider> {
  return createFakeProvider([{ parsed: verdict }])
}

/** Reads the usage counter FROM WITHIN the model call — proves the spend guard's write happens
 * strictly before the call, not after. */
function spendOrderSpyProvider(capture: { valueDuringCall: number | null }, verdict: TriageVerdict): LlmProvider {
  return {
    kind: 'spend-order-spy',
    capabilities: () => SPY_CAPABILITIES,
    async chat<T>(req: ChatRequest<T>): Promise<ChatResult<T>> {
      capture.valueDuringCall = await readUsageCounter(TODAY)
      return {
        text: '', parsed: verdict as unknown as T, parseStrategy: 'native',
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, apiCalls: 1 },
        finish: 'stop', provider: 'spend-order-spy', model: req.model, latencyMs: 0,
      }
    },
  }
}

/** Mutates the ticket's status DURING the model call — simulates the owner resolving the ticket
 * while the network call is in flight, which the final guarded write must then back off from. */
function concurrentOwnerRaceProvider(ticketId: string, verdict: TriageVerdict): LlmProvider {
  return {
    kind: 'race',
    capabilities: () => SPY_CAPABILITIES,
    async chat<T>(req: ChatRequest<T>): Promise<ChatResult<T>> {
      await withOrg(app.db, orgId, (tx) => tx.update(tickets).set({ status: 'resolved' }).where(eq(tickets.id, ticketId)))
      return {
        text: '', parsed: verdict as unknown as T, parseStrategy: 'native',
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, apiCalls: 1 },
        finish: 'stop', provider: 'race', model: req.model, latencyMs: 0,
      }
    },
  }
}

describe('runTicketTriage', () => {
  it('1. skips silently a ticket that is not new, and not (triaged with a fresh inbound)', async () => {
    const provider = createFakeProvider([{ error: new LlmError('must not be called', 'permanent', false) }])
    const { deps } = makeDeps(provider)

    const needsOwnerId = await seedTicket({ status: 'needs_owner', needsOwnerReason: 'tripwire' })
    await runTicketTriage(deps, { orgId, ticketId: needsOwnerId }, new AbortController().signal)
    expect((await getTicket(needsOwnerId)).status).toBe('needs_owner')

    const staleTriagedId = await seedTicket({ status: 'triaged', lastInboundAt: new Date('2026-09-01T00:00:00Z'), lastTriagedAt: new Date('2026-09-02T00:00:00Z') })
    await runTicketTriage(deps, { orgId, ticketId: staleTriagedId }, new AbortController().signal)
    expect((await getTicket(staleTriagedId)).status).toBe('triaged')

    expect(provider.calls).toHaveLength(0)
  })

  it('1c. needs_owner/triage_cap IS selectable — mailbox.poll-sweep re-entry lands the verdict through the legal needs_owner -> triaged edge', async () => {
    const ticketId = await seedTicket({ status: 'needs_owner', needsOwnerReason: 'triage_cap' })
    const provider = verdictProvider(BASE_VERDICT)
    const { deps } = makeDeps(provider)

    await runTicketTriage(deps, { orgId, ticketId }, new AbortController().signal)

    expect(provider.calls).toHaveLength(1)
    const ticket = await getTicket(ticketId)
    expect(ticket.status).toBe('triaged')
    expect(ticket.needsOwnerReason).toBeNull()
  })

  it('1d. every OTHER needs_owner reason stays non-selectable', async () => {
    const provider = createFakeProvider([{ error: new LlmError('must not be called', 'permanent', false) }])
    const { deps } = makeDeps(provider)

    for (const reason of ['tripwire', 'triage_flags', 'sentiment_angry', 'triage_failed'] as const) {
      const ticketId = await seedTicket({ status: 'needs_owner', needsOwnerReason: reason })
      await runTicketTriage(deps, { orgId, ticketId }, new AbortController().signal)
      const ticket = await getTicket(ticketId)
      expect(ticket.status).toBe('needs_owner')
      expect(ticket.needsOwnerReason).toBe(reason)
    }
    expect(provider.calls).toHaveLength(0)
  })

  it('1b. a triaged ticket with a genuinely new inbound IS selectable and proceeds to the model', async () => {
    const ticketId = await seedTicket({ status: 'triaged', lastInboundAt: new Date('2026-09-05T00:00:00Z'), lastTriagedAt: new Date('2026-09-01T00:00:00Z') })
    const provider = verdictProvider(BASE_VERDICT)
    const { deps } = makeDeps(provider)

    await runTicketTriage(deps, { orgId, ticketId }, new AbortController().signal)

    expect(provider.calls).toHaveLength(1)
    expect((await getTicket(ticketId)).status).toBe('triaged')
  })

  it('2. an automated ticket resolves without spending a call (pre-LLM short-circuit), and clears a stale needs_owner_reason', async () => {
    const ticketId = await seedTicket({ isAutomated: true, needsOwnerReason: 'triage_flags' })
    const provider = createFakeProvider([{ error: new LlmError('must not be called', 'permanent', false) }])
    const { deps } = makeDeps(provider)

    await runTicketTriage(deps, { orgId, ticketId }, new AbortController().signal)

    const ticket = await getTicket(ticketId)
    expect(ticket.status).toBe('resolved')
    expect(ticket.needsOwnerReason).toBeNull()
    expect(provider.calls).toHaveLength(0)
    expect(await readUsageCounter(TODAY)).toBe(0)
    const audits = await auditRowsFor(ticketId, 'ticket.auto_reply_dropped')
    expect(audits).toHaveLength(1)
    expect(audits[0]!.actor).toBe('system:ticket.triage')
  })

  it('3. a spam-flagged ticket resolves without a model call once support.spam_shortcircuit.always is set, and clears a stale needs_owner_reason', async () => {
    await setOrgSetting('support.spam_shortcircuit.always', true)
    const ticketId = await seedTicket({ spamFlagged: true, needsOwnerReason: 'sentiment_angry' })
    const provider = createFakeProvider([{ error: new LlmError('must not be called', 'permanent', false) }])
    const { deps } = makeDeps(provider)

    await runTicketTriage(deps, { orgId, ticketId }, new AbortController().signal)

    const ticket = await getTicket(ticketId)
    expect(ticket.status).toBe('resolved')
    expect(ticket.isSpam).toBe(true)
    expect(ticket.needsOwnerReason).toBeNull()
    expect(provider.calls).toHaveLength(0)
    expect(await readUsageCounter(TODAY)).toBe(0)
    expect(await auditRowsFor(ticketId, 'ticket.spam_shortcircuit')).toHaveLength(1)
  })

  it('3b. a spam-flagged ticket at the daily cap also resolves pre-LLM (the OTHER short-circuit condition)', async () => {
    await setOrgSetting('triage.daily_cap', 1)
    await setUsageCounter(TODAY, 1)
    const ticketId = await seedTicket({ spamFlagged: true })
    const provider = createFakeProvider([{ error: new LlmError('must not be called', 'permanent', false) }])
    const { deps } = makeDeps(provider)

    await runTicketTriage(deps, { orgId, ticketId }, new AbortController().signal)

    expect((await getTicket(ticketId)).status).toBe('resolved')
    expect(provider.calls).toHaveLength(0)
  })

  it('3c. a spam-flagged ticket NOT at cap and without the always setting still reaches the model', async () => {
    const ticketId = await seedTicket({ spamFlagged: true })
    const provider = verdictProvider({ ...BASE_VERDICT, isSpam: false })
    const { deps } = makeDeps(provider)

    await runTicketTriage(deps, { orgId, ticketId }, new AbortController().signal)

    expect(provider.calls).toHaveLength(1)
    expect((await getTicket(ticketId)).status).toBe('triaged')
  })

  it('4. the spend counter is incremented BEFORE the model call runs, not after', async () => {
    await setUsageCounter(TODAY, 0)
    const ticketId = await seedTicket()
    const capture: { valueDuringCall: number | null } = { valueDuringCall: null }
    const provider = spendOrderSpyProvider(capture, BASE_VERDICT)
    const { deps } = makeDeps(provider)

    await runTicketTriage(deps, { orgId, ticketId }, new AbortController().signal)

    expect(capture.valueDuringCall).toBe(1) // already incremented by the time the call happened
    expect(await readUsageCounter(TODAY)).toBe(1)
  })

  it('5. the cap path escalates without ever calling the model', async () => {
    await setOrgSetting('triage.daily_cap', 1)
    await setUsageCounter(TODAY, 1)
    const ticketId = await seedTicket()
    const provider = createFakeProvider([{ error: new LlmError('must not be called', 'permanent', false) }])
    const { deps, notified } = makeDeps(provider)

    await runTicketTriage(deps, { orgId, ticketId }, new AbortController().signal)

    const ticket = await getTicket(ticketId)
    expect(ticket.status).toBe('needs_owner')
    expect(ticket.needsOwnerReason).toBe('triage_cap')
    expect(provider.calls).toHaveLength(0)

    const dedupeKey = `triage_cap:${ticketId}:${TODAY}`
    const rows = await notificationsFor(dedupeKey)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.kind).toBe('escalation')
    expect(notified).toEqual([{ orgId, notificationId: rows[0]!.id }])

    await setOrgSetting('triage.daily_cap', 6000)
    await setUsageCounter(TODAY, 0)
  })

  it('5b. the cap path fires at most once per ticket per UTC day (dedupe on the notification row)', async () => {
    await setOrgSetting('triage.daily_cap', 1)
    await setUsageCounter(TODAY, 1)
    const ticketId = await seedTicket()
    const provider = createFakeProvider([{ error: new LlmError('must not be called', 'permanent', false) }])
    const { deps, notified } = makeDeps(provider)

    await runTicketTriage(deps, { orgId, ticketId }, new AbortController().signal)
    expect(notified).toHaveLength(1)

    // Simulate the ticket becoming selectable again the same UTC day (still capped) and re-running.
    await withOrg(app.db, orgId, (tx) => tx.update(tickets).set({ status: 'new' }).where(eq(tickets.id, ticketId)))
    await runTicketTriage(deps, { orgId, ticketId }, new AbortController().signal)

    expect((await getTicket(ticketId)).status).toBe('needs_owner')
    expect(notified).toHaveLength(1) // no second notification, no second enqueueNotify call

    await setOrgSetting('triage.daily_cap', 6000)
    await setUsageCounter(TODAY, 0)
  })

  it('6. a clean verdict with no flags and neutral sentiment lands as triaged, and audits ticket.triaged', async () => {
    const ticketId = await seedTicket()
    await seedInboundMessage(ticketId, 'Where is my order?', new Date('2026-09-08T00:00:00Z'))
    const provider = verdictProvider(BASE_VERDICT)
    const { deps } = makeDeps(provider)

    await runTicketTriage(deps, { orgId, ticketId }, new AbortController().signal)

    const ticket = await getTicket(ticketId)
    expect(ticket.status).toBe('triaged')
    expect(ticket.language).toBe('en')
    expect(ticket.sentiment).toBe('neutral')
    expect(ticket.lastTriagedAt).not.toBeNull()

    const audits = await auditRowsFor(ticketId, 'ticket.triaged')
    expect(audits).toHaveLength(1)
    expect(audits[0]!.actor).toBe('system:ticket.triage')
    expect(audits[0]!.detail).toMatchObject({ categoryKey: 'order_status', sentiment: 'neutral', outcome: 'triaged' })
  })

  it('6h. the triaged outcome hands the ticket to ticket.draft exactly once; no other outcome does', async () => {
    const ticketId = await seedTicket()
    await seedInboundMessage(ticketId, 'Where is my order?', new Date('2026-09-08T00:00:00Z'))
    const { deps, drafted } = makeDeps(verdictProvider(BASE_VERDICT))

    await runTicketTriage(deps, { orgId, ticketId }, new AbortController().signal)

    expect(drafted).toEqual([{ orgId, ticketId }])

    // An escalating verdict is the owner's, not the agent's: no draft run is enqueued for it.
    const angryId = await seedTicket()
    const { deps: angryDeps, drafted: angryDrafted } = makeDeps(verdictProvider({ ...BASE_VERDICT, sentiment: 'angry' }))
    await runTicketTriage(angryDeps, { orgId, ticketId: angryId }, new AbortController().signal)
    expect(angryDrafted).toEqual([])
  })

  it('6b. isSpam or isAutomated in the verdict resolves the ticket', async () => {
    const spamId = await seedTicket()
    await runTicketTriage(makeDeps(verdictProvider({ ...BASE_VERDICT, isSpam: true })).deps, { orgId, ticketId: spamId }, new AbortController().signal)
    expect((await getTicket(spamId)).status).toBe('resolved')

    const automatedId = await seedTicket()
    await runTicketTriage(makeDeps(verdictProvider({ ...BASE_VERDICT, isAutomated: true })).deps, { orgId, ticketId: automatedId }, new AbortController().signal)
    expect((await getTicket(automatedId)).status).toBe('resolved')
  })

  it('6c. escalation flags land as needs_owner/triage_flags with an escalation notification', async () => {
    const ticketId = await seedTicket()
    const provider = verdictProvider({ ...BASE_VERDICT, escalationFlags: ['legal_threat'] })
    const { deps, notified } = makeDeps(provider)

    await runTicketTriage(deps, { orgId, ticketId }, new AbortController().signal)

    const ticket = await getTicket(ticketId)
    expect(ticket.status).toBe('needs_owner')
    expect(ticket.needsOwnerReason).toBe('triage_flags')
    expect(ticket.escalationNotifiedAt).toBeNull()

    const dedupeKey = `escalation:${ticketId}:${TODAY}`
    const rows = await notificationsFor(dedupeKey)
    expect(rows).toHaveLength(1)
    expect(notified).toEqual([{ orgId, notificationId: rows[0]!.id }])
  })

  it('6d. angry sentiment (with no flags) lands as needs_owner/sentiment_angry', async () => {
    const ticketId = await seedTicket()
    const provider = verdictProvider({ ...BASE_VERDICT, sentiment: 'angry' })
    const { deps } = makeDeps(provider)

    await runTicketTriage(deps, { orgId, ticketId }, new AbortController().signal)

    const ticket = await getTicket(ticketId)
    expect(ticket.status).toBe('needs_owner')
    expect(ticket.needsOwnerReason).toBe('sentiment_angry')
  })

  it('6e. an unknown categoryKey maps to the org\'s "other" category rather than failing', async () => {
    const ticketId = await seedTicket()
    const provider = verdictProvider({ ...BASE_VERDICT, categoryKey: 'not_a_real_category' })
    const { deps } = makeDeps(provider)

    await runTicketTriage(deps, { orgId, ticketId }, new AbortController().signal)

    expect((await getTicket(ticketId)).categoryId).toBe(otherCategoryId)
  })

  it('6f. a concurrent owner action during the call wins: the guarded write skips silently', async () => {
    const ticketId = await seedTicket()
    const provider = concurrentOwnerRaceProvider(ticketId, BASE_VERDICT)
    const { deps, notified } = makeDeps(provider)

    await runTicketTriage(deps, { orgId, ticketId }, new AbortController().signal)

    // The race provider set status to 'resolved' mid-call; the verdict write was guarded on 'new'
    // (the status the ticket was SELECTED with), so it must not have clobbered the owner's action.
    expect((await getTicket(ticketId)).status).toBe('resolved')
    expect(await auditRowsFor(ticketId, 'ticket.triaged')).toHaveLength(0)
    expect(notified).toHaveLength(0)
  })

  it('6g. a stale needs_owner_reason from a prior episode is cleared on a clean triaged/resolved verdict', async () => {
    // A ticket that was needs_owner once, then moved back to `new` by some other (future) owner
    // mutation that didn't clear the reason column — this job's own write must not leave it behind.
    const ticketId = await seedTicket({ needsOwnerReason: 'triage_flags' })
    const provider = verdictProvider(BASE_VERDICT)
    const { deps } = makeDeps(provider)

    await runTicketTriage(deps, { orgId, ticketId }, new AbortController().signal)

    const ticket = await getTicket(ticketId)
    expect(ticket.status).toBe('triaged')
    expect(ticket.needsOwnerReason).toBeNull()
  })

  it('7. two consecutive failures escalate to needs_owner/triage_failed; below that, it rethrows for pg-boss to retry', async () => {
    const ticketId = await seedTicket()
    const provider = createFakeProvider([
      { error: new LlmError('rate limited', 'rate_limit', true) },
      { error: new LlmError('rate limited again', 'rate_limit', true) },
    ])
    const { deps, notified } = makeDeps(provider)

    await expect(runTicketTriage(deps, { orgId, ticketId }, new AbortController().signal)).rejects.toThrow(/rate limited/)
    let ticket = await getTicket(ticketId)
    expect(ticket.status).toBe('new') // unchanged — still selectable for the retry
    expect(ticket.triageFailureCount).toBe(1)
    expect(notified).toHaveLength(0)

    await runTicketTriage(deps, { orgId, ticketId }, new AbortController().signal) // 2nd failure: does NOT throw
    ticket = await getTicket(ticketId)
    expect(ticket.status).toBe('needs_owner')
    expect(ticket.needsOwnerReason).toBe('triage_failed')
    expect(ticket.triageFailureCount).toBe(2)

    const dedupeKey = `escalation:${ticketId}:${TODAY}`
    const rows = await notificationsFor(dedupeKey)
    expect(rows).toHaveLength(1)
    expect(notified).toEqual([{ orgId, notificationId: rows[0]!.id }])
  })

  it('7c. a ticket that resolves after paging can re-escalate on a LATER UTC day and pushes a second notification', async () => {
    // Controller ruling (fix review): the escalation dedupe key is scoped to the UTC day, not the
    // ticket's whole lifetime — otherwise the FIRST-ever escalation for a ticket would permanently
    // win the unique index and a genuine re-escalation later would page nobody.
    const ticketId = await seedTicket()
    const provider = createFakeProvider([
      { parsed: { ...BASE_VERDICT, escalationFlags: ['legal_threat'] } },
      { parsed: { ...BASE_VERDICT, escalationFlags: ['legal_threat'] } },
    ])
    const { deps, notified } = makeDeps(provider)

    await runTicketTriage(deps, { orgId, ticketId }, new AbortController().signal)
    expect((await getTicket(ticketId)).status).toBe('needs_owner')
    expect(notified).toHaveLength(1)

    // The owner resolves it (paged, handled), and later a fresh inbound reopens it — both out of
    // this job's scope; done directly here to set up a genuine re-escalation.
    await withOrg(app.db, orgId, (tx) => tx.update(tickets).set({ status: 'resolved' }).where(eq(tickets.id, ticketId)))
    await withOrg(app.db, orgId, (tx) => tx.update(tickets).set({ status: 'new' }).where(eq(tickets.id, ticketId)))

    const nextDay = '2026-09-10'
    const deps2: TicketTriageDeps = { ...deps, now: () => new Date(`${nextDay}T09:00:00Z`) }
    await runTicketTriage(deps2, { orgId, ticketId }, new AbortController().signal)

    expect((await getTicket(ticketId)).status).toBe('needs_owner')
    expect(notified).toHaveLength(2) // a SECOND enqueueNotify — the day-scoped key doesn't collide

    const firstDayRows = await notificationsFor(`escalation:${ticketId}:${TODAY}`)
    const secondDayRows = await notificationsFor(`escalation:${ticketId}:${nextDay}`)
    expect(firstDayRows).toHaveLength(1)
    expect(secondDayRows).toHaveLength(1)
    expect(notified.map((n) => n.notificationId).sort()).toEqual([firstDayRows[0]!.id, secondDayRows[0]!.id].sort())
  })

  it('7b. an unparsable verdict (parsed: null) counts as a failed attempt, same as a thrown LlmError', async () => {
    const ticketId = await seedTicket()
    const provider = createFakeProvider([{ text: 'not a valid tool call' }]) // parsed stays null
    const { deps } = makeDeps(provider)

    await expect(runTicketTriage(deps, { orgId, ticketId }, new AbortController().signal)).rejects.toThrow(/unparsable verdict/)
    expect((await getTicket(ticketId)).triageFailureCount).toBe(1)
  })
})
