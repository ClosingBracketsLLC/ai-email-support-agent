/**
 * `runTicketDraft` against real Postgres, a `createFakeProvider` script (or a hand-built
 * `LlmProvider` for the four scenarios that must observe/mutate state DURING the model call) and
 * `emptyRetriever`. No pg-boss: `registerTicketDraft` is thin and its enqueue seams are injected.
 *
 * One `it` per numbered job-behavior rule in the task brief.
 *
 * Every test gets a FRESH org fixture (`beforeEach`): `agent_runs` rows accumulate per org and two
 * of this job's inputs are org-wide counts over a time window — the draft concurrency gate and the
 * "≥ 12 drafts/hour → cache the agent blocks" rate — so a shared org would make several assertions
 * depend on the order the suite happens to run in.
 */
import { randomBytes } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import pino from 'pino'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { emptyRetriever, type DraftDecision } from '@aesa/agent'
import { DRAFT_EXPIRE_DAYS } from '@aesa/contracts'
import {
  agentCategoryPolicies, agentRunEvents, agentRuns, agents, auditLog, categories, createMeterSink,
  drafts, ensureDefaultCategories, llmCalls, llmCredentials, mailboxConnections, messages,
  notifications, orgSettings, outboundSends, platformState, resolvedAnswers, SEND_METERS, tickets,
  usageCounters, user, withOrg, withPlatform, workspaces,
} from '@aesa/db'
import type { ResolvedModelConfig } from '@aesa/db'
import { createDb } from '@aesa/db/raw'
import { createTestDatabase, createTestOrganization } from '@aesa/db/testing'
import type { DetailedRetriever } from '@aesa/knowledge'
import {
  createFakeProvider, LlmError, withMeta, withMetering,
  type Capabilities, type ChatRequest, type ChatResult, type LlmProvider,
} from '@aesa/llm'
import { runTicketDraft, STOP_LOSS_MICROS, type TicketDraftDeps } from '../src/jobs/ticket-draft.ts'
import { staticRefusal, staticResolver } from '../src/provider-resolver.ts'

const rand = () => randomBytes(4).toString('hex')
const NOW = new Date('2026-09-09T12:00:00Z')
const TODAY = '2026-09-09'
const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60_000)
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Most tests freeze the clock at `NOW` so timestamps can be asserted exactly. The happy path uses
 * this instead: the FIRST read is exactly `NOW` (so the claim stamp, the day string and `expires_at`
 * stay exact) and every later read advances a millisecond, which is what makes "the finish clock is
 * a fresh read, not the job-start one" an assertable difference rather than a coincidence.
 */
function monotonicClock(): () => Date {
  let tick = 0
  return () => new Date(NOW.getTime() + tick++)
}

/** Passes every guardrail screen: no markup, no link, no address, no number, no promise token. */
const CLEAN_BODY = 'Thanks for getting in touch. I have checked the details you gave us and everything looks correct on our side.'
/** Hard-fails `html_not_allowed` on every attempt. */
const HTML_BODY = '<b>Thanks for getting in touch.</b> I have checked the details you gave us.'

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
const ESCALATE: DraftDecision = { outcome: 'escalate', reason: 'legal_or_safety', rationale: 'The customer mentions a lawyer.' }
const NO_REPLY: DraftDecision = { outcome: 'no_reply', reason: 'already_answered', rationale: 'Nothing new was asked.' }

const SPY_CAPABILITIES: Capabilities = { structuredOutput: 'native', tools: true, effort: true, cacheMinTokens: 512 }

let t: Awaited<ReturnType<typeof createTestDatabase>>
let app: ReturnType<typeof createDb>
let userId: string

interface Fixture {
  orgId: string
  connectionId: string
  agentId: string
  categoryId: string
  otherCategoryId: string
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
  fx = await seedOrg()
})

async function seedOrg(): Promise<Fixture> {
  const orgId = await createTestOrganization(app)
  return withOrg(app.db, orgId, async (tx) => {
    await tx.insert(workspaces).values({
      orgId, businessName: 'Acme Dog Supplies', timezone: 'UTC', locale: 'en',
      description: 'Acme sells dog beds, leads and bowls online.',
      allowedUrlHosts: ['acme.test'], allowedEmailDomains: ['acme.test'],
      operatingGuidance: 'Always confirm the order number before quoting a delivery window.',
      agentEnabled: true,
    })
    await ensureDefaultCategories(tx)
    const [conn] = await tx
      .insert(mailboxConnections)
      .values({ orgId, provider: 'gmail', providerAccountId: `acct-${rand()}`, emailAddress: `support-${rand()}@acme.test`, status: 'connected', connectedByUserId: userId })
      .returning({ id: mailboxConnections.id })
    const [agent] = await tx
      .insert(agents)
      .values({
        orgId, connectionId: conn!.id, address: `support-${rand()}@acme.test`, domain: 'acme.test',
        displayName: 'Acme Support', status: 'active', priority: 0, signature: 'Acme Support',
        guidanceExtra: 'Keep replies to three sentences where you can.',
      })
      .returning({ id: agents.id })
    const cats = await tx.select({ id: categories.id, key: categories.key }).from(categories)
    return {
      orgId,
      connectionId: conn!.id,
      agentId: agent!.id,
      categoryId: cats.find((c) => c.key === 'order_status')!.id,
      otherCategoryId: cats.find((c) => c.key === 'other')!.id,
    }
  })
}

async function seedTicket(over: Partial<typeof tickets.$inferInsert> = {}): Promise<string> {
  const [row] = await withOrg(app.db, fx.orgId, (tx) =>
    tx
      .insert(tickets)
      .values({
        orgId: fx.orgId, connectionId: fx.connectionId, agentId: fx.agentId, providerThreadId: `thread-${rand()}`,
        status: 'triaged', categoryId: fx.categoryId, subject: 'Where is my order?', language: 'en', sentiment: 'neutral',
        customerEmail: 'customer@example.test', triageQuestions: ['Where is my order?'],
        lastInboundAt: minutesAgo(5), lastTriagedAt: minutesAgo(4),
        ...over,
      })
      .returning({ id: tickets.id }))
  return row!.id
}

async function seedInbound(ticketId: string, over: Partial<typeof messages.$inferInsert> = {}): Promise<void> {
  await withOrg(app.db, fx.orgId, (tx) =>
    tx.insert(messages).values({
      orgId: fx.orgId, ticketId, connectionId: fx.connectionId, providerMessageId: `msg-${rand()}`,
      direction: 'inbound', fromAddress: 'customer@example.test', bodyText: 'Hi, where is my order?',
      dmarcPass: true, sentAt: minutesAgo(5), ...over,
    }))
}

/** An `approved` draft plus the `queued` ledger row an approve creates, on a ticket the agent is
 *  still allowed to draft for (the re-approve-raced-by-a-new-inbound shape). */
async function seedApprovedDraftWithSend(ticketId: string): Promise<{ draftId: string; sendId: string }> {
  return withOrg(app.db, fx.orgId, async (tx) => {
    const [draft] = await tx
      .insert(drafts)
      .values({
        orgId: fx.orgId, ticketId, agentId: fx.agentId, categoryId: fx.categoryId, version: 1,
        body: CLEAN_BODY, finalBody: CLEAN_BODY, decision: 'review', decisionReason: 'below_threshold',
        status: 'approved', threadSnapshotAt: minutesAgo(5), expiresAt: new Date(NOW.getTime() + 86_400_000),
        decidedBy: userId, decidedAt: minutesAgo(1), decisionSource: 'app',
      })
      .returning({ id: drafts.id })
    const [send] = await tx
      .insert(outboundSends)
      .values({
        orgId: fx.orgId, draftId: draft!.id, ticketId, connectionId: fx.connectionId, agentId: fx.agentId,
        status: 'queued', sendAfter: new Date(NOW.getTime() + 15_000),
      })
      .returning({ id: outboundSends.id })
    return { draftId: draft!.id, sendId: send!.id }
  })
}

/** A triaged ticket with one authenticated inbound message — the ordinary starting point. */
async function seedDraftableTicket(over: Partial<typeof tickets.$inferInsert> = {}): Promise<string> {
  const ticketId = await seedTicket(over)
  await seedInbound(ticketId)
  return ticketId
}

async function getTicket(ticketId: string) {
  const [row] = await withOrg(app.db, fx.orgId, (tx) => tx.select().from(tickets).where(eq(tickets.id, ticketId)))
  return row!
}

async function draftsFor(ticketId: string) {
  return withOrg(app.db, fx.orgId, (tx) => tx.select().from(drafts).where(eq(drafts.ticketId, ticketId)).orderBy(drafts.version))
}

async function runsFor(ticketId: string) {
  return withOrg(app.db, fx.orgId, (tx) => tx.select().from(agentRuns).where(eq(agentRuns.ticketId, ticketId)).orderBy(agentRuns.startedAt))
}

async function eventsFor(runId: string) {
  return withOrg(app.db, fx.orgId, (tx) => tx.select().from(agentRunEvents).where(eq(agentRunEvents.runId, runId)).orderBy(agentRunEvents.seq))
}

async function auditRowsFor(ticketId: string, action: string) {
  return withOrg(app.db, fx.orgId, (tx) =>
    tx.select().from(auditLog).where(and(eq(auditLog.entityId, ticketId), eq(auditLog.action, action))))
}

async function notificationsWithPrefix(prefix: string) {
  const rows = await withOrg(app.db, fx.orgId, (tx) => tx.select().from(notifications))
  return rows.filter((r) => r.dedupeKey.startsWith(prefix))
}

async function setUsageCounter(meter: string, value: number): Promise<void> {
  await withOrg(app.db, fx.orgId, (tx) =>
    tx.insert(usageCounters).values({ orgId: fx.orgId, day: TODAY, meter, value })
      .onConflictDoUpdate({ target: [usageCounters.orgId, usageCounters.day, usageCounters.meter], set: { value } }))
}

async function seedRuns(n: number, over: Partial<typeof agentRuns.$inferInsert> = {}): Promise<void> {
  await withOrg(app.db, fx.orgId, (tx) =>
    tx.insert(agentRuns).values(
      Array.from({ length: n }, () => ({
        orgId: fx.orgId, kind: 'draft', agentId: fx.agentId, provider: 'fake', model: 'claude-opus-5',
        status: 'succeeded', startedAt: NOW, ...over,
      })),
    ))
}

/** A `DetailedRetriever` whose answers leg returns exactly one active answer (Phase 5's memory). */
function answerRetriever(answer: { id: string; score: number; approvals: number }): DetailedRetriever {
  const answers = [{ id: answer.id, question: 'where is my order', answer: 'It ships tomorrow.', score: answer.score, approvals: answer.approvals }]
  return {
    retrieve: async () => ({ chunks: [], answers }),
    retrieveDetailed: async () => ({ chunks: [], answers, knowledgeVersion: 3, mode: 'hybrid', degraded: false }),
  }
}

async function setPolicy(categoryId: string, values: { mode: 'off' | 'review' | 'auto'; autoSendMinConfidence?: number }): Promise<void> {
  await withOrg(app.db, fx.orgId, (tx) =>
    tx.insert(agentCategoryPolicies).values({ orgId: fx.orgId, agentId: fx.agentId, categoryId, ...values }))
}

async function setOrgSetting(key: string, value: unknown): Promise<void> {
  await withOrg(app.db, fx.orgId, (tx) =>
    tx.insert(orgSettings).values({ orgId: fx.orgId, key, value })
      .onConflictDoUpdate({ target: [orgSettings.orgId, orgSettings.key], set: { value } }))
}

/**
 * `n` drafts this agent+category already had a HUMAN decision on — what the cold-start lock counts.
 * They sit on their OWN resolved ticket in a non-live status, so they never occupy the one
 * live-draft slot of the ticket under test.
 */
async function seedHumanDecisions(n: number): Promise<void> {
  if (n === 0) return
  const ticketId = await seedTicket({ status: 'resolved' })
  await withOrg(app.db, fx.orgId, (tx) =>
    tx.insert(drafts).values(
      Array.from({ length: n }, (_, i) => ({
        orgId: fx.orgId, ticketId, agentId: fx.agentId, categoryId: fx.categoryId, version: i + 1,
        body: CLEAN_BODY, finalBody: CLEAN_BODY, decision: 'review', decisionReason: 'category_review',
        status: 'sent', threadSnapshotAt: minutesAgo(30), expiresAt: new Date(NOW.getTime() + 86_400_000),
        decidedBy: userId, decidedAt: minutesAgo(20), decisionSource: 'app',
      })),
    ))
}

/** A BYOK credential row the resolver's config can point at — what `markCredentialDead` flips. */
async function seedCredential(over: Partial<typeof llmCredentials.$inferInsert> = {}): Promise<string> {
  const [row] = await withOrg(app.db, fx.orgId, (tx) =>
    tx.insert(llmCredentials).values({
      orgId: fx.orgId, provider: 'custom', label: 'Acme local LLM', baseUrl: 'https://llm.acme.test/v1',
      keyFingerprint: 'abcd1234…7890', probeModel: 'qwen3:32b', healthStatus: 'healthy', createdBy: `user:${userId}`,
      ...over,
    }).returning({ id: llmCredentials.id }))
  return row!.id
}

/** What `resolveModelConfig` really returns for a byok agent — `credential` is never null there. */
function byokConfig(credentialId: string, over: Partial<ResolvedModelConfig> = {}): Partial<ResolvedModelConfig> {
  return {
    mode: 'byok', credentialId, provider: 'custom', model: 'qwen3:32b', tier: 'limited',
    credential: { label: 'Acme local LLM', baseUrl: 'https://llm.acme.test/v1', healthStatus: 'healthy', lastProbe: null },
    ...over,
  }
}

async function llmCallsFor(runId: string) {
  return withOrg(app.db, fx.orgId, (tx) =>
    tx.select().from(llmCalls).where(eq(llmCalls.runId, runId)).orderBy(llmCalls.createdAt))
}

async function credentialRow(credentialId: string) {
  const [row] = await withOrg(app.db, fx.orgId, (tx) => tx.select().from(llmCredentials).where(eq(llmCredentials.id, credentialId)))
  return row!
}

async function allNotifications() {
  return withOrg(app.db, fx.orgId, (tx) => tx.select().from(notifications))
}

async function sendsFor(draftId: string) {
  return withOrg(app.db, fx.orgId, (tx) => tx.select().from(outboundSends).where(eq(outboundSends.draftId, draftId)))
}

interface Harness {
  deps: TicketDraftDeps
  notified: string[]
  drafted: { orgId: string; ticketId: string; startAfter?: Date }[]
  sends: { orgId: string; sendId: string; startAfter: Date }[]
}

function makeDeps(provider: LlmProvider, over: Partial<TicketDraftDeps> = {}): Harness {
  const notified: string[] = []
  const drafted: { orgId: string; ticketId: string; startAfter?: Date }[] = []
  const sends: Harness['sends'] = []
  const deps: TicketDraftDeps = {
    db: app.db,
    providers: staticResolver(provider),
    retriever: emptyRetriever,
    logger: pino({ level: 'silent' }),
    enqueueNotify: async (_orgId, notificationId) => void notified.push(notificationId),
    enqueueDraft: async (orgId, ticketId, opts) => void drafted.push({ orgId, ticketId, ...(opts?.startAfter ? { startAfter: opts.startAfter } : {}) }),
    enqueueSend: async (orgId, sendId, opts) => void sends.push({ orgId, sendId, startAfter: opts.startAfter }),
    now: () => NOW,
    watchdogMs: 5_000,
    ...over,
  }
  return { deps, notified, drafted, sends }
}

const run = (deps: TicketDraftDeps, ticketId: string) => runTicketDraft(deps, { orgId: fx.orgId, ticketId }, new AbortController().signal)

/** Delegates to a scripted decision but runs `onCall` first — the only way to observe or mutate
 * state while the model call is "in flight". */
function hookedProvider(decisions: DraftDecision[], onCall: (attempt: number) => Promise<void>): LlmProvider {
  let attempt = 0
  return {
    kind: 'hooked',
    capabilities: () => SPY_CAPABILITIES,
    async chat<T>(req: ChatRequest<T>): Promise<ChatResult<T>> {
      attempt += 1
      await onCall(attempt)
      return {
        text: '', parsed: (decisions[Math.min(attempt - 1, decisions.length - 1)] as unknown) as T, parseStrategy: 'native',
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, apiCalls: 1 },
        finish: 'stop', provider: 'hooked', model: req.model, latencyMs: 0,
      }
    },
  }
}

describe('runTicketDraft', () => {
  it('1. the platform kill lever is a policy no-op: no stamp, no run row, no model call', async () => {
    await withPlatform(app.db, 'test:killswitch', (tx) =>
      tx.insert(platformState).values({ key: 'killswitch.global', value: true })
        .onConflictDoUpdate({ target: platformState.key, set: { value: true } }))
    const ticketId = await seedDraftableTicket()
    const provider = createFakeProvider([{ parsed: REPLY }])
    const { deps } = makeDeps(provider)

    try {
      await run(deps, ticketId)
    } finally {
      await withPlatform(app.db, 'test:killswitch', (tx) => tx.delete(platformState).where(eq(platformState.key, 'killswitch.global')))
    }

    expect(provider.calls).toHaveLength(0)
    const ticket = await getTicket(ticketId)
    expect(ticket.status).toBe('triaged')
    expect(ticket.lastAgentRunAt).toBeNull()
    expect(await runsFor(ticketId)).toHaveLength(0)
  })

  it('2. a ticket that is not `triaged` is skipped silently', async () => {
    const ticketId = await seedDraftableTicket({ status: 'awaiting_review' })
    const provider = createFakeProvider([{ parsed: REPLY }])
    const { deps } = makeDeps(provider)

    await run(deps, ticketId)

    expect(provider.calls).toHaveLength(0)
    expect((await getTicket(ticketId)).status).toBe('awaiting_review')
    expect(await runsFor(ticketId)).toHaveLength(0)
  })

  it('2b. no agent on the connection escalates needs_owner/no_agent and pages the owner', async () => {
    await withOrg(app.db, fx.orgId, (tx) => tx.update(agents).set({ status: 'disabled' }).where(eq(agents.id, fx.agentId)))
    const ticketId = await seedDraftableTicket({ agentId: null })
    const provider = createFakeProvider([{ parsed: REPLY }])
    const { deps, notified } = makeDeps(provider)

    await run(deps, ticketId)

    const ticket = await getTicket(ticketId)
    expect(ticket.status).toBe('needs_owner')
    expect(ticket.needsOwnerReason).toBe('no_agent')
    expect(ticket.lastAgentRunAt).toBeNull()
    expect(provider.calls).toHaveLength(0)
    expect(notified).toHaveLength(1)
  })

  it('3. the per-ticket daily cap escalates agent_run_cap WITHOUT stamping, and never calls the model', async () => {
    const ticketId = await seedDraftableTicket()
    await seedRuns(3, { ticketId })
    const provider = createFakeProvider([{ parsed: REPLY }])
    const { deps, notified } = makeDeps(provider)

    await run(deps, ticketId)

    const ticket = await getTicket(ticketId)
    expect(ticket.status).toBe('needs_owner')
    expect(ticket.needsOwnerReason).toBe('agent_run_cap')
    expect(ticket.lastAgentRunAt).toBeNull()
    expect(provider.calls).toHaveLength(0)
    expect(notified).toHaveLength(1)
    expect(await notificationsWithPrefix(`agent_run_cap:${ticketId}:`)).toHaveLength(1)
  })

  it('3b. the org spend cap leaves the ticket untouched and writes exactly one llm_cap notification per day', async () => {
    const ticketId = await seedDraftableTicket()
    await setUsageCounter('llm_cost_micros', 60_000_000)
    const provider = createFakeProvider([{ parsed: REPLY }])
    const { deps, notified } = makeDeps(provider)

    await run(deps, ticketId)
    await run(deps, ticketId)

    const ticket = await getTicket(ticketId)
    expect(ticket.status).toBe('triaged')
    expect(ticket.lastAgentRunAt).toBeNull()
    expect(provider.calls).toHaveLength(0)
    const capNotifications = await notificationsWithPrefix(`llm_cap:${fx.orgId}:`)
    expect(capNotifications).toHaveLength(1)
    expect(capNotifications[0]!.title).toBe('Daily AI budget reached')
    expect(capNotifications[0]!.payload).toEqual({})
    expect(notified).toEqual([capNotifications[0]!.id])
  })

  it('4. a CAS-rejected duplicate audits draft.run_skipped and writes no run row', async () => {
    // Claimed five minutes ago, nothing new inbound since: the watermark branch refuses it.
    const ticketId = await seedDraftableTicket({ lastAgentRunAt: minutesAgo(5), lastInboundAt: minutesAgo(30) })
    const provider = createFakeProvider([{ parsed: REPLY }])
    const { deps } = makeDeps(provider)

    await run(deps, ticketId)

    expect(provider.calls).toHaveLength(0)
    expect(await runsFor(ticketId)).toHaveLength(0)
    const skipped = await auditRowsFor(ticketId, 'draft.run_skipped')
    expect(skipped).toHaveLength(1)
    expect(skipped[0]!.detail).toMatchObject({ reason: 'watermark' })
  })

  it('5. org_busy unwinds the claim stamp and re-enqueues the job 30 s out', async () => {
    const ticketId = await seedDraftableTicket()
    await seedRuns(2, { status: 'running' })
    const provider = createFakeProvider([{ parsed: REPLY }])
    const { deps, drafted } = makeDeps(provider)

    try {
      await run(deps, ticketId)
    } finally {
      await withOrg(app.db, fx.orgId, (tx) => tx.delete(agentRuns).where(eq(agentRuns.status, 'running')))
    }

    const ticket = await getTicket(ticketId)
    expect(ticket.status).toBe('triaged')
    expect(ticket.lastAgentRunAt).toBeNull()
    expect(provider.calls).toHaveLength(0)
    expect(drafted).toHaveLength(1)
    expect(drafted[0]!.ticketId).toBe(ticketId)
    expect(drafted[0]!.startAfter!.getTime()).toBe(NOW.getTime() + 30_000)
  })

  it('6/14. the happy path: awaiting_review, one draft row, the draft_review push, a succeeded run and four events', async () => {
    const ticketId = await seedDraftableTicket()
    const provider = createFakeProvider([{ parsed: REPLY, usage: { inputTokens: 1200, outputTokens: 300 } }])
    const { deps, notified } = makeDeps(provider, { now: monotonicClock() })

    await run(deps, ticketId)

    const ticket = await getTicket(ticketId)
    expect(ticket.status).toBe('awaiting_review')
    // The finish watermark is a FRESH clock read: strictly after the claim stamp, never equal to it.
    expect(ticket.lastAgentRunAt?.toISOString()).toBe(NOW.toISOString())
    expect(ticket.lastAgentFinishedAt!.getTime()).toBeGreaterThan(ticket.lastAgentRunAt!.getTime())
    expect(ticket.lastAgentPromptedAt?.toISOString()).toBe(minutesAgo(5).toISOString())

    const [draft] = await draftsFor(ticketId)
    expect(draft).toBeDefined()
    expect(draft!.version).toBe(1)
    expect(draft!.status).toBe('pending')
    expect(draft!.body).toBe(CLEAN_BODY)
    expect(draft!.finalBody).toBeNull()
    expect(draft!.decision).toBe('review')
    expect(draft!.decisionReason).toBe('category_review')
    expect(draft!.categoryId).toBe(fx.categoryId)
    expect(draft!.agentId).toBe(fx.agentId)
    expect(draft!.modelConfidence).toBeCloseTo(0.82, 5)
    expect(draft!.confidence).toBeCloseTo(0.82, 5)
    expect(draft!.isRedraft).toBe(false)
    expect(draft!.customerLanguage).toBe('en')
    expect(draft!.rationale).toBe(REPLY.rationale)
    expect(draft!.threadSnapshotAt.toISOString()).toBe(minutesAgo(5).toISOString())
    expect(draft!.expiresAt.toISOString()).toBe(new Date(NOW.getTime() + DRAFT_EXPIRE_DAYS * 86_400_000).toISOString())
    expect(draft!.guardrailResult).toMatchObject({ ok: true })
    expect(draft!.confidenceBreakdown).toMatchObject({
      blockers: {
        tripwire: false, guardrail: false, dmarcFail: false, attachments: false, redraft: false, categoryOff: false,
        coldStart: true, memoryConflict: false, unresolvedQuestions: false, threadTooLong: false, autoSendCap: false,
      },
      // Nothing retrieved and nothing remembered: `max(0, 0) × 0.82` is 0, and a `review` category
      // has no threshold to compare it against.
      model: 0.82, memory: null, evidence: 0, threshold: null, warnings: [],
      // `emptyRetriever`: nothing retrieved, nothing cited, and no mode/version to record.
      grounding: { score: null, mode: null, knowledgeVersion: null, retrieved: 0, cited: 0 },
    })

    const [run1] = await runsFor(ticketId)
    expect(run1!.status).toBe('succeeded')
    expect(run1!.kind).toBe('draft')
    expect(run1!.model).toBe('claude-opus-5')
    expect(run1!.inputTokens).toBe(1200)
    expect(run1!.outputTokens).toBe(300)
    expect(run1!.apiCalls).toBe(1)
    expect(run1!.costMicros).toBe(1200 * 5 + 300 * 25)
    expect(run1!.output).toMatchObject({ outcome: 'reply', draftId: draft!.id, decision: 'review' })
    expect(draft!.agentRunId).toBe(run1!.id)
    expect(run1!.startedAt.toISOString()).toBe(NOW.toISOString())
    expect(run1!.finishedAt!.getTime()).toBeGreaterThan(run1!.startedAt.getTime())

    expect((await eventsFor(run1!.id)).map((e) => e.kind)).toEqual(['prompt', 'call', 'guardrail', 'decision'])

    const pushes = await notificationsWithPrefix(`draft_review:${draft!.id}`)
    expect(pushes).toHaveLength(1)
    expect(pushes[0]!.kind).toBe('draft_review')
    expect(pushes[0]!.title).toBe('Reply ready · Order status · 82%')
    expect(pushes[0]!.body).toBe(CLEAN_BODY.slice(0, 140))
    expect(pushes[0]!.payload).toEqual({ ticketId, draftId: draft!.id })
    expect(notified).toEqual([pushes[0]!.id])

    const created = await auditRowsFor(ticketId, 'draft.created')
    expect(created).toHaveLength(1)
    expect(created[0]!.actor).toBe(`agent:${run1!.id}`)
    expect(created[0]!.detail).toMatchObject({ draftId: draft!.id, version: 1, decision: 'review', reason: 'category_review', isRedraft: false })
  })

  it('14b. a second run after a new inbound supersedes the pending draft and stores version 2', async () => {
    const ticketId = await seedDraftableTicket()
    const { deps } = makeDeps(createFakeProvider([{ parsed: REPLY }]))
    await run(deps, ticketId)
    const [first] = await draftsFor(ticketId)

    // The owner has not decided; a new customer message arrives and re-opens the ticket for the agent.
    await withOrg(app.db, fx.orgId, (tx) =>
      tx.update(tickets).set({ status: 'triaged', lastInboundAt: new Date(NOW.getTime() + 60_000) }).where(eq(tickets.id, ticketId)))
    await run(deps, ticketId)

    const rows = await draftsFor(ticketId)
    expect(rows.map((r) => r.version)).toEqual([1, 2])
    expect(rows[0]!.status).toBe('superseded')
    expect(rows[1]!.status).toBe('pending')
    expect(rows.filter((r) => r.status === 'pending')).toHaveLength(1)

    const superseded = await withOrg(app.db, fx.orgId, (tx) =>
      tx.select().from(auditLog).where(and(eq(auditLog.entityId, first!.id), eq(auditLog.action, 'draft.superseded'))))
    expect(superseded).toHaveLength(1)
    expect(superseded[0]!.detail).toMatchObject({ supersededByRunId: rows[1]!.agentRunId })
  })

  it('14f. a new run supersedes an APPROVED draft (a re-approve raced by a new inbound) and holds its queued send', async () => {
    // Reachable since fix wave A3: `drafts.resume` puts a `failed` draft back to `pending` on a
    // ticket `landStale` already handed back to `triaged`, the owner re-approves it (draft
    // `approved` + a `queued` send), and the re-draft this ticket is owed lands here. Superseding
    // `pending` ONLY left the approved draft live, so the INSERT below hit
    // `drafts_live_per_ticket_uidx` — a raw 23505, not a `LostRaceError`, so the job rethrew, the
    // run stayed `running` until the stuck sweep aborted it, and every retry failed the same way.
    const ticketId = await seedDraftableTicket()
    const { draftId, sendId } = await seedApprovedDraftWithSend(ticketId)
    const { deps } = makeDeps(createFakeProvider([{ parsed: REPLY }]))

    await run(deps, ticketId)

    const rows = await draftsFor(ticketId)
    expect(rows.map((r) => r.status)).toEqual(['superseded', 'pending'])
    expect(rows[0]!.id).toBe(draftId)
    const [send] = await withOrg(app.db, fx.orgId, (tx) => tx.select().from(outboundSends).where(eq(outboundSends.id, sendId)))
    // The reply the owner approved must not go out on a thread that has moved on.
    expect(send!.status).toBe('held')
    expect(send!.lastError).toBe('held:superseded_by_redraft')
    const superseded = await withOrg(app.db, fx.orgId, (tx) =>
      tx.select().from(auditLog).where(and(eq(auditLog.entityId, draftId), eq(auditLog.action, 'draft.superseded'))))
    expect(superseded).toHaveLength(1)
    expect(superseded[0]!.detail).toMatchObject({ from: 'approved' })
  })

  it('6b. owner feedback rides into the prompt, raises effort to high and marks the draft a redraft', async () => {
    const ticketId = await seedDraftableTicket({ ownerRedraftFeedback: 'Say the parcel is with the courier, not shipped.', redraftCount: 1 })
    await withOrg(app.db, fx.orgId, (tx) =>
      tx.insert(drafts).values({
        orgId: fx.orgId, ticketId, agentId: fx.agentId, version: 1, body: 'The previous attempt at an answer.',
        decision: 'review', decisionReason: 'category_review', status: 'rejected', rejectReason: 'Too vague.',
        threadSnapshotAt: minutesAgo(30), expiresAt: new Date(NOW.getTime() + 86_400_000),
      }))
    const provider = createFakeProvider([{ parsed: REPLY }])
    const { deps } = makeDeps(provider)

    await run(deps, ticketId)

    expect(provider.calls).toHaveLength(1)
    const content = provider.calls[0]!.messages[0]!.content
    expect(content).toContain('Owner feedback on your previous draft')
    expect(content).toContain('Say the parcel is with the courier, not shipped.')
    expect(content).toContain('The previous attempt at an answer.')
    expect(provider.calls[0]!.effort).toBe('high')

    const rows = await draftsFor(ticketId)
    expect(rows[1]!.isRedraft).toBe(true)
    expect(rows[1]!.version).toBe(2)
  })

  it('13. a guardrail hard failure buys ONE automatic redraft; a clean second call stores a single draft', async () => {
    const ticketId = await seedDraftableTicket()
    const provider = createFakeProvider([{ parsed: reply({ body: HTML_BODY }) }, { parsed: REPLY }])
    const { deps } = makeDeps(provider)

    await run(deps, ticketId)

    expect(provider.calls).toHaveLength(2)
    expect(provider.calls[1]!.effort).toBe('high')
    expect(provider.calls[1]!.messages[0]!.content).toContain('Guardrail failure on your previous draft')
    expect(provider.calls[1]!.messages[0]!.content).toContain('html_not_allowed')
    expect(provider.calls[1]!.meta.idempotencyKey).toMatch(/:2$/)

    const rows = await draftsFor(ticketId)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.body).toBe(CLEAN_BODY)
    expect(rows[0]!.decision).toBe('review')
    expect((await getTicket(ticketId)).status).toBe('awaiting_review')

    const [run1] = await runsFor(ticketId)
    expect(run1!.apiCalls).toBe(2)
    expect((await eventsFor(run1!.id)).filter((e) => e.kind === 'call')).toHaveLength(2)
  })

  it('13b. both attempts failing the guardrails still stores the draft — pending, escalate/guardrail_failed', async () => {
    const ticketId = await seedDraftableTicket()
    const provider = createFakeProvider([{ parsed: reply({ body: HTML_BODY }) }])
    const { deps, notified } = makeDeps(provider)

    await run(deps, ticketId)

    expect(provider.calls).toHaveLength(2)
    const rows = await draftsFor(ticketId)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.status).toBe('pending')
    expect(rows[0]!.decision).toBe('escalate')
    expect(rows[0]!.decisionReason).toBe('guardrail_failed')
    expect(rows[0]!.body).toBe(HTML_BODY)
    expect(rows[0]!.guardrailResult).toMatchObject({ ok: false })

    const ticket = await getTicket(ticketId)
    expect(ticket.status).toBe('needs_owner')
    expect(ticket.needsOwnerReason).toBe('guardrail_failed')
    expect(ticket.lastAgentFinishedAt?.toISOString()).toBe(NOW.toISOString())
    expect(notified).toHaveLength(1)
    const [run1] = await runsFor(ticketId)
    expect(run1!.status).toBe('succeeded')
  })

  it('13c. the stop-loss skips the automatic redraft once the run has already spent $0.40', async () => {
    const ticketId = await seedDraftableTicket()
    // 16 000 output tokens on claude-opus-5 ($25/MTok) is exactly STOP_LOSS_MICROS.
    const provider = createFakeProvider([{ parsed: reply({ body: HTML_BODY }), usage: { outputTokens: 16_000 } }])
    const { deps } = makeDeps(provider)

    await run(deps, ticketId)

    expect(provider.calls).toHaveLength(1)
    const [run1] = await runsFor(ticketId)
    expect(run1!.costMicros).toBeGreaterThanOrEqual(STOP_LOSS_MICROS)
    const rows = await draftsFor(ticketId)
    expect(rows[0]!.decisionReason).toBe('guardrail_failed')
    expect((await getTicket(ticketId)).needsOwnerReason).toBe('guardrail_failed')
  })

  it('11. an escalate outcome hands the ticket over with a page and stores no draft', async () => {
    const ticketId = await seedDraftableTicket()
    const provider = createFakeProvider([{ parsed: ESCALATE }])
    const { deps, notified } = makeDeps(provider)

    await run(deps, ticketId)

    const ticket = await getTicket(ticketId)
    expect(ticket.status).toBe('needs_owner')
    expect(ticket.needsOwnerReason).toBe('agent_escalated')
    expect(ticket.lastAgentFinishedAt?.toISOString()).toBe(NOW.toISOString())
    expect(await draftsFor(ticketId)).toHaveLength(0)
    expect(notified).toHaveLength(1)

    const [run1] = await runsFor(ticketId)
    expect(run1!.status).toBe('succeeded')
    expect(run1!.output).toMatchObject({ outcome: 'escalate', reason: 'legal_or_safety' })
    const escalated = await auditRowsFor(ticketId, 'ticket.escalated')
    expect(escalated[0]!.detail).toMatchObject({ reason: 'agent_escalated', escalateReason: 'legal_or_safety' })
  })

  it('12. an idle no_reply leaves the ticket triaged with its claim stamp intact', async () => {
    const ticketId = await seedDraftableTicket()
    const provider = createFakeProvider([{ parsed: NO_REPLY }])
    const { deps } = makeDeps(provider)

    await run(deps, ticketId)

    const ticket = await getTicket(ticketId)
    expect(ticket.status).toBe('triaged')
    expect(ticket.lastAgentRunAt?.toISOString()).toBe(NOW.toISOString())
    expect(ticket.lastAgentFinishedAt?.toISOString()).toBe(NOW.toISOString())
    expect(await draftsFor(ticketId)).toHaveLength(0)
    const audits = await auditRowsFor(ticketId, 'draft.no_reply')
    expect(audits).toHaveLength(1)
    expect(audits[0]!.detail).toMatchObject({ reason: 'already_answered' })
  })

  it('12b. FR3: a no_reply that raced a newer inbound clears the claim stamp so the next cycle re-runs it', async () => {
    const ticketId = await seedDraftableTicket()
    const provider = hookedProvider([NO_REPLY], async () => {
      await withOrg(app.db, fx.orgId, (tx) =>
        tx.update(tickets).set({ lastInboundAt: new Date(NOW.getTime() + 30_000) }).where(eq(tickets.id, ticketId)))
    })
    const { deps } = makeDeps(provider)

    await run(deps, ticketId)

    const ticket = await getTicket(ticketId)
    expect(ticket.status).toBe('triaged')
    expect(ticket.lastAgentRunAt).toBeNull()
    expect(ticket.lastAgentFinishedAt?.toISOString()).toBe(NOW.toISOString())
  })

  it('12c. a no_reply that ignored owner feedback escalates redraft_unfulfilled and clears the redraft cycle', async () => {
    const ticketId = await seedDraftableTicket({ ownerRedraftFeedback: 'Mention the courier by name.', redraftCount: 1 })
    const provider = createFakeProvider([{ parsed: NO_REPLY }])
    const { deps, notified } = makeDeps(provider)

    await run(deps, ticketId)

    const ticket = await getTicket(ticketId)
    expect(ticket.status).toBe('needs_owner')
    expect(ticket.needsOwnerReason).toBe('redraft_unfulfilled')
    expect(ticket.ownerRedraftFeedback).toBeNull()
    expect(ticket.redraftCount).toBe(0)
    expect(ticket.lastAgentFinishedAt?.toISOString()).toBe(NOW.toISOString())
    expect(notified).toHaveLength(1)
  })

  it('10. a refusal is an escalation with the content_filtered detail', async () => {
    const ticketId = await seedDraftableTicket()
    const provider = createFakeProvider([{ finish: 'refusal', text: '' }])
    const { deps, notified } = makeDeps(provider)

    await run(deps, ticketId)

    const ticket = await getTicket(ticketId)
    expect(ticket.status).toBe('needs_owner')
    expect(ticket.needsOwnerReason).toBe('agent_escalated')
    expect(notified).toHaveLength(1)
    const [run1] = await runsFor(ticketId)
    expect(run1!.status).toBe('succeeded')
    const escalated = await auditRowsFor(ticketId, 'ticket.escalated')
    expect(escalated[0]!.detail).toMatchObject({ detail: 'content_filtered' })
  })

  it('9. a first LlmError counts a failure, clears the claim stamp, fails the run and rethrows for pg-boss', async () => {
    const ticketId = await seedDraftableTicket()
    const provider = createFakeProvider([{ error: new LlmError('rate limited', 'rate_limit', true) }])
    const { deps } = makeDeps(provider)

    await expect(run(deps, ticketId)).rejects.toThrow(/rate limited/)

    const ticket = await getTicket(ticketId)
    expect(ticket.status).toBe('triaged')
    expect(ticket.agentFailureCount).toBe(1)
    expect(ticket.lastAgentRunAt).toBeNull()
    expect(ticket.lastAgentFinishedAt).toBeNull()
    const [run1] = await runsFor(ticketId)
    expect(run1!.status).toBe('failed')
    expect(run1!.errorCode).toBe('llm_rate_limit')
    expect((await eventsFor(run1!.id)).map((e) => e.kind)).toContain('error')
    expect(await auditRowsFor(ticketId, 'draft.run_failed')).toHaveLength(1)
  })

  it('9b. the second failure escalates agent_failed and returns instead of throwing', async () => {
    const ticketId = await seedDraftableTicket({ agentFailureCount: 1 })
    const provider = createFakeProvider([{ error: new LlmError('rate limited', 'rate_limit', true) }])
    const { deps, notified } = makeDeps(provider)

    await run(deps, ticketId)

    const ticket = await getTicket(ticketId)
    expect(ticket.status).toBe('needs_owner')
    expect(ticket.needsOwnerReason).toBe('agent_failed')
    expect(ticket.agentFailureCount).toBe(2)
    expect(ticket.lastAgentFinishedAt).toBeNull()
    expect(notified).toHaveLength(1)
  })

  it('9c. the watchdog aborts the run and records the failure without a finish stamp', async () => {
    const ticketId = await seedDraftableTicket()
    const provider = createFakeProvider([{ parsed: REPLY, delayMs: 200 }])
    const { deps } = makeDeps(provider, { watchdogMs: 20 })

    await expect(run(deps, ticketId)).rejects.toThrow()

    const [run1] = await runsFor(ticketId)
    expect(run1!.status).toBe('aborted')
    expect(run1!.errorCode).toBe('watchdog')
    const ticket = await getTicket(ticketId)
    expect(ticket.agentFailureCount).toBe(1)
    expect(ticket.lastAgentFinishedAt).toBeNull()
  })

  it('14c. category mode `off` escalates quietly: the draft is stored, the owner is not paged', async () => {
    const ticketId = await seedDraftableTicket()
    await withOrg(app.db, fx.orgId, (tx) =>
      tx.insert(agentCategoryPolicies).values({ orgId: fx.orgId, agentId: fx.agentId, categoryId: fx.categoryId, mode: 'off' }))
    const provider = createFakeProvider([{ parsed: REPLY }])
    const { deps, notified } = makeDeps(provider)

    await run(deps, ticketId)

    const ticket = await getTicket(ticketId)
    expect(ticket.status).toBe('needs_owner')
    expect(ticket.needsOwnerReason).toBe('category_off')
    expect(ticket.escalationNotifiedAt?.toISOString()).toBe(NOW.toISOString())
    expect(notified).toHaveLength(0)
    const rows = await draftsFor(ticketId)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.decision).toBe('escalate')
    expect(rows[0]!.decisionReason).toBe('category_off')
  })

  it('14d. an owner resolving the ticket mid-call drops the draft and audits draft.propose_lost_race', async () => {
    const ticketId = await seedDraftableTicket()
    const provider = hookedProvider([REPLY], async () => {
      await withOrg(app.db, fx.orgId, (tx) => tx.update(tickets).set({ status: 'resolved' }).where(eq(tickets.id, ticketId)))
    })
    const { deps, notified } = makeDeps(provider)

    await run(deps, ticketId)

    expect(await draftsFor(ticketId)).toHaveLength(0)
    expect(await auditRowsFor(ticketId, 'draft.propose_lost_race')).toHaveLength(1)
    expect(notified).toHaveLength(0)
    const ticket = await getTicket(ticketId)
    expect(ticket.status).toBe('resolved')
    expect(ticket.lastAgentFinishedAt?.toISOString()).toBe(NOW.toISOString())
    const [run1] = await runsFor(ticketId)
    expect(run1!.status).toBe('succeeded')
    expect(run1!.output).toMatchObject({ lostRace: true })
  })

  it('6c. above 12 draft runs an hour the agent blocks get their own cache breakpoint', async () => {
    const idleTicket = await seedDraftableTicket()
    const idleProvider = createFakeProvider([{ parsed: REPLY }])
    const { deps: idleDeps } = makeDeps(idleProvider)
    await run(idleDeps, idleTicket)
    expect(idleProvider.calls[0]!.cache).toMatchObject({ agentBreakpoint: false })

    await seedRuns(12, { startedAt: new Date(NOW.getTime() - 10 * 60_000) })
    const ticketId = await seedDraftableTicket()
    const provider = createFakeProvider([{ parsed: REPLY }])
    const { deps } = makeDeps(provider)

    await run(deps, ticketId)

    expect(provider.calls[0]!.cache).toMatchObject({ agentBreakpoint: true })
  })

  it('9d. an unparsable envelope counts a failure and rethrows, exactly like a transport error', async () => {
    const ticketId = await seedDraftableTicket()
    // `finish: 'stop'` with nothing parseable: the structured-output ladder has already spent its
    // rungs by the time the job sees this, so it is the job's failure, not a refusal.
    const provider = createFakeProvider([{ text: 'sorry, plain prose', finish: 'stop' }])
    const { deps } = makeDeps(provider)

    await expect(run(deps, ticketId)).rejects.toThrow(/unparsable/)

    const ticket = await getTicket(ticketId)
    expect(ticket.status).toBe('triaged')
    expect(ticket.agentFailureCount).toBe(1)
    expect(ticket.lastAgentRunAt).toBeNull()
    expect(ticket.lastAgentFinishedAt).toBeNull()
    const [run1] = await runsFor(ticketId)
    expect(run1!.status).toBe('failed')
    expect(run1!.errorCode).toBe('unparsable')
    expect(await auditRowsFor(ticketId, 'draft.run_failed')).toHaveLength(1)
    expect(await draftsFor(ticketId)).toHaveLength(0)
  })

  it('7b. a retriever that throws fails the run and rethrows for pg-boss, without ever calling the model', async () => {
    const ticketId = await seedDraftableTicket()
    const provider = createFakeProvider([{ parsed: REPLY }])
    const { deps } = makeDeps(provider, {
      retriever: { retrieve: async () => { throw new Error('retriever exploded') } },
    })

    await expect(run(deps, ticketId)).rejects.toThrow(/retriever exploded/)

    expect(provider.calls).toHaveLength(0)
    const ticket = await getTicket(ticketId)
    expect(ticket.agentFailureCount).toBe(1)
    expect(ticket.lastAgentFinishedAt).toBeNull()
    const [run1] = await runsFor(ticketId)
    expect(run1!.status).toBe('failed')
    expect(run1!.errorCode).toBe('retrieval')
    // The trace still opens with the prompt event: a run whose ONLY event is `error` says nothing
    // about what was built, which is exactly what a failed retrieval needs to be debugged.
    const events = await eventsFor(run1!.id)
    expect(events.map((e) => e.kind)).toEqual(['prompt', 'error'])
    expect(events[0]!.payload).toMatchObject({ knowledge: { retrieved: 0, mode: null } })
  })

  it('7c. grounding: a detailed retriever fills score/mode/knowledgeVersion, and the prompt event records the retrieval', async () => {
    const ticketId = await seedDraftableTicket()
    const chunks = [
      { id: crypto.randomUUID(), heading: 'Returns', content: 'Returns are free within 30 days.', score: 0.41 },
      { id: crypto.randomUUID(), heading: 'Shipping', content: 'Orders ship the same working day.', score: 0.77 },
    ]
    const provider = createFakeProvider([{ parsed: reply({ citedChunkIds: [chunks[0]!.id, 'a-chunk-that-was-never-retrieved'] }) }])
    const retriever: DetailedRetriever = {
      retrieve: async () => { throw new Error('the job must use retrieveDetailed when it exists') },
      retrieveDetailed: async () => ({ chunks, answers: [], knowledgeVersion: 12, mode: 'lexical', degraded: true }),
    }
    const { deps } = makeDeps(provider, { retriever })

    await run(deps, ticketId)

    const [draft] = await draftsFor(ticketId)
    expect(draft!.retrievedChunkIds).toEqual([chunks[0]!.id, chunks[1]!.id])
    // The invented id never became a citation, so it can never raise the score either.
    expect(draft!.citedChunkIds).toEqual([chunks[0]!.id])
    expect(draft!.confidenceBreakdown).toMatchObject({
      grounding: { score: 0.41, mode: 'lexical', knowledgeVersion: 12, retrieved: 2, cited: 1 },
    })

    const [run1] = await runsFor(ticketId)
    const events = await eventsFor(run1!.id)
    expect(events.map((e) => e.kind)).toEqual(['prompt', 'call', 'guardrail', 'decision'])
    expect(events[0]!.payload).toMatchObject({ knowledge: { retrieved: 2, mode: 'lexical' } })
  })

  it('7d. grounding: a retrieval nothing was cited from leaves the score null but still records the mode', async () => {
    const ticketId = await seedDraftableTicket()
    const chunks = [{ id: crypto.randomUUID(), heading: 'Returns', content: 'Returns are free within 30 days.', score: 0.9 }]
    const provider = createFakeProvider([{ parsed: reply({ citedChunkIds: [] }) }])
    const retriever: DetailedRetriever = {
      retrieve: async () => ({ chunks, answers: [] }),
      retrieveDetailed: async () => ({ chunks, answers: [], knowledgeVersion: 3, mode: 'hybrid', degraded: false }),
    }
    const { deps } = makeDeps(provider, { retriever })

    await run(deps, ticketId)

    const [draft] = await draftsFor(ticketId)
    expect(draft!.confidenceBreakdown).toMatchObject({
      grounding: { score: null, mode: 'hybrid', knowledgeVersion: 3, retrieved: 1, cited: 0 },
    })
  })

  it('13d. an automatic redraft that THROWS still stores attempt 1 under guardrail_failed, and leaves an error event', async () => {
    const ticketId = await seedDraftableTicket()
    const provider = createFakeProvider([
      { parsed: reply({ body: HTML_BODY }) },
      { error: new LlmError('rate limited', 'rate_limit', true) },
    ])
    const { deps, notified } = makeDeps(provider)

    await run(deps, ticketId)

    expect(provider.calls).toHaveLength(2)
    const rows = await draftsFor(ticketId)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.status).toBe('pending')
    expect(rows[0]!.decision).toBe('escalate')
    expect(rows[0]!.decisionReason).toBe('guardrail_failed')
    expect(rows[0]!.body).toBe(HTML_BODY)
    expect((await getTicket(ticketId)).needsOwnerReason).toBe('guardrail_failed')
    expect(notified).toHaveLength(1)

    // The run itself succeeded — a failed redraft is not a failed run — but attempt 2 is on record.
    const [run1] = await runsFor(ticketId)
    expect(run1!.status).toBe('succeeded')
    expect(run1!.apiCalls).toBe(1) // the throwing call reported no usage
    const errors = (await eventsFor(run1!.id)).filter((e) => e.kind === 'error')
    expect(errors).toHaveLength(1)
    expect(errors[0]!.payload).toMatchObject({ attempt: 2, code: 'llm_rate_limit' })
  })

  it('13e. the escalate landing takes the ticket lock FIRST, so an owner racing it drops the draft too', async () => {
    const ticketId = await seedDraftableTicket()
    // Both attempts fail the guardrails, so this lands on the escalate branch — and the owner
    // resolves the ticket while the first call is in flight.
    const provider = hookedProvider([reply({ body: HTML_BODY })], async (attempt) => {
      if (attempt !== 1) return
      await withOrg(app.db, fx.orgId, (tx) => tx.update(tickets).set({ status: 'resolved' }).where(eq(tickets.id, ticketId)))
    })
    const { deps, notified } = makeDeps(provider)

    await run(deps, ticketId)

    expect(await draftsFor(ticketId)).toHaveLength(0)
    expect(await auditRowsFor(ticketId, 'draft.escalate_lost_race')).toHaveLength(1)
    expect(await auditRowsFor(ticketId, 'draft.propose_lost_race')).toHaveLength(0)
    expect(notified).toHaveLength(0)
    const ticket = await getTicket(ticketId)
    expect(ticket.status).toBe('resolved')
    expect(ticket.lastAgentFinishedAt?.toISOString()).toBe(NOW.toISOString())
    const [run1] = await runsFor(ticketId)
    expect(run1!.status).toBe('succeeded')
    expect(run1!.output).toMatchObject({ lostRace: true })
  })

  // The gate's own refusals (as opposed to rule 3's unlocked pre-claim exits) are only reachable
  // when something lands BETWEEN the job's unlocked read and its advisory-locked gate. A second
  // connection holding the ticket's row lock is exactly that window: the job blocks inside the
  // claim's `SELECT … FOR UPDATE` until the holder commits its own write.
  async function raceAtClaim(ticketId: string, duringClaim: (tx: Parameters<Parameters<typeof withOrg>[2]>[0]) => Promise<void>, body: () => Promise<void>): Promise<void> {
    const other = createDb(t.url)
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    try {
      const held = withOrg(other.db, fx.orgId, async (tx) => {
        await tx.select({ id: tickets.id }).from(tickets).where(eq(tickets.id, ticketId)).limit(1).for('update')
        await duringClaim(tx)
        await gate
      })
      await sleep(100) // the holder now owns the row lock
      const running = body()
      await sleep(100) // the job is blocked inside claimTicket's own FOR UPDATE
      release()
      await held
      await running
    } finally {
      await other.pool.end()
    }
  }

  it('5b. the LOCKED gate: an org draft cap tripped after the claim unwinds the stamp and pages once', async () => {
    const ticketId = await seedDraftableTicket()
    const provider = createFakeProvider([{ parsed: REPLY }])
    const { deps, notified } = makeDeps(provider)
    // The bump below is written but UNCOMMITTED while the job runs its unlocked pre-claim read, so
    // under READ COMMITTED that read provably does NOT see it — rule 3's pre-claim exit therefore
    // cannot be what fired, which is exactly what makes the LOCKED gate below the only explanation.
    const updatedBefore = (await getTicket(ticketId)).updatedAt

    await raceAtClaim(
      ticketId,
      // Another worker exhausts the org's daily draft allowance while this job is mid-claim.
      (tx) => tx
        .insert(usageCounters)
        .values({ orgId: fx.orgId, day: TODAY, meter: 'draft_runs', value: 999_999 })
        .onConflictDoUpdate({ target: [usageCounters.orgId, usageCounters.day, usageCounters.meter], set: { value: 999_999 } })
        .then(() => undefined),
      () => run(deps, ticketId),
    )

    const ticket = await getTicket(ticketId)
    expect(ticket.status).toBe('triaged')
    expect(ticket.lastAgentRunAt).toBeNull() // unwound back to its prior value
    // Decisive: rule 3's pre-claim exit never writes to the ticket at all, so a moved `updated_at`
    // is proof the claim stamped the row and the LOCKED gate is what unwound it.
    expect(ticket.updatedAt.getTime()).toBeGreaterThan(updatedBefore.getTime())
    expect(provider.calls).toHaveLength(0)
    expect(await runsFor(ticketId)).toHaveLength(0)
    const capNotifications = await notificationsWithPrefix(`llm_cap:${fx.orgId}:`)
    expect(capNotifications).toHaveLength(1)
    expect(notified).toEqual([capNotifications[0]!.id])
  })

  it('5c. the LOCKED gate: a per-ticket cap tripped after the claim escalates agent_run_cap and does NOT unwind', async () => {
    const ticketId = await seedDraftableTicket()
    const provider = createFakeProvider([{ parsed: REPLY }])
    const { deps, notified } = makeDeps(provider)

    await raceAtClaim(
      ticketId,
      // Three draft runs for THIS ticket land while the job is mid-claim.
      (tx) => tx
        .insert(agentRuns)
        .values(Array.from({ length: 3 }, () => ({
          orgId: fx.orgId, kind: 'draft', ticketId, agentId: fx.agentId, provider: 'fake',
          model: 'claude-opus-5', status: 'succeeded', startedAt: NOW,
        })))
        .then(() => undefined),
      () => run(deps, ticketId),
    )

    const ticket = await getTicket(ticketId)
    expect(ticket.status).toBe('needs_owner')
    expect(ticket.needsOwnerReason).toBe('agent_run_cap')
    // The stamp is left standing: the ticket is leaving `triaged`, so no claim predicate reads it again.
    expect(ticket.lastAgentRunAt?.toISOString()).toBe(NOW.toISOString())
    expect(provider.calls).toHaveLength(0)
    expect(await notificationsWithPrefix(`agent_run_cap:${ticketId}:`)).toHaveLength(1)
    expect(notified).toHaveLength(1)
  })

  it('14e. an unauthenticated sender still gets a draft, but the decision reason is dmarc_fail', async () => {
    const ticketId = await seedTicket()
    await seedInbound(ticketId, { dmarcPass: false })
    const provider = createFakeProvider([{ parsed: REPLY }])
    const { deps } = makeDeps(provider)

    await run(deps, ticketId)

    expect(provider.calls[0]!.messages[0]!.content).toContain('NOT verified')
    const rows = await draftsFor(ticketId)
    expect(rows[0]!.decision).toBe('review')
    expect(rows[0]!.decisionReason).toBe('dmarc_fail')
    expect(rows[0]!.confidenceBreakdown).toMatchObject({ blockers: { dmarcFail: true } })
    expect((await getTicket(ticketId)).status).toBe('awaiting_review')
  })
  // --- Phase 5: evidence, the new blockers and the auto landing -------------------------------

  it('15. evidence = max(memory, grounding) × model — memory from the best USED active answer, recorded on the breakdown', async () => {
    const answerId = crypto.randomUUID()
    const ticketId = await seedDraftableTicket()
    const provider = createFakeProvider([{ parsed: reply({ confidence: 0.9, usedAnswerIds: [answerId] }) }])
    const { deps } = makeDeps(provider, { retriever: answerRetriever({ id: answerId, score: 0.92, approvals: 3 }) })

    await run(deps, ticketId)

    const [draft] = await draftsFor(ticketId)
    // Deviation 1: `confidence` still means the model's own self-assessment; evidence is a breakdown field.
    expect(draft!.confidence).toBeCloseTo(0.9, 6)
    expect(draft!.confidenceBreakdown).toMatchObject({
      evidence: 0.9,
      memory: { score: 1, answerId, cosine: 0.92, approvals: 3 },
      // The category is `review`, so there is no threshold to compare against.
      threshold: null,
    })
    expect(draft!.usedAnswerIds).toEqual([answerId])
    expect(draft!.retrievedAnswerIds).toEqual([answerId])
  })

  it('15b. an answer the model did NOT cite contributes no memory (evidence falls back to grounding × model = 0 here)', async () => {
    const answerId = crypto.randomUUID()
    const ticketId = await seedDraftableTicket()
    const provider = createFakeProvider([{ parsed: reply({ confidence: 0.9, usedAnswerIds: [] }) }])
    const { deps } = makeDeps(provider, { retriever: answerRetriever({ id: answerId, score: 0.92, approvals: 3 }) })

    await run(deps, ticketId)

    const [draft] = await draftsFor(ticketId)
    expect(draft!.confidenceBreakdown).toMatchObject({ evidence: 0, memory: null })
    expect(draft!.usedAnswerIds).toEqual([])
  })

  it('15c. an id the model invented is not a used answer, so it lends no memory either', async () => {
    const answerId = crypto.randomUUID()
    const ticketId = await seedDraftableTicket()
    const provider = createFakeProvider([{ parsed: reply({ confidence: 0.9, usedAnswerIds: [crypto.randomUUID()] }) }])
    const { deps } = makeDeps(provider, { retriever: answerRetriever({ id: answerId, score: 0.92, approvals: 3 }) })

    await run(deps, ticketId)

    const [draft] = await draftsFor(ticketId)
    expect(draft!.usedAnswerIds).toEqual([])
    expect(draft!.confidenceBreakdown).toMatchObject({ evidence: 0, memory: null })
  })

  it('16. category auto and evidence ≥ threshold lands an auto-send: approved draft, queued send a hold window out, ticket auto_sending', async () => {
    await setPolicy(fx.categoryId, { mode: 'auto', autoSendMinConfidence: 80 })
    await seedHumanDecisions(10)
    const answerId = crypto.randomUUID()
    const ticketId = await seedDraftableTicket()
    const provider = createFakeProvider([{ parsed: reply({ confidence: 0.9, usedAnswerIds: [answerId] }) }])
    const { deps, sends, notified } = makeDeps(provider, { retriever: answerRetriever({ id: answerId, score: 0.95, approvals: 3 }) })

    await run(deps, ticketId)

    const [draft] = await draftsFor(ticketId)
    expect(draft).toMatchObject({
      status: 'approved', decision: 'send', decisionReason: 'ok', decisionSource: 'auto', finalBody: CLEAN_BODY,
      decidedBy: null, viewedAt: null,
    })
    expect(draft!.autoDecidedAt).not.toBeNull()
    expect(draft!.decidedAt).not.toBeNull()
    expect(draft!.confidenceBreakdown).toMatchObject({
      evidence: 0.9, threshold: 0.8,
      blockers: { memoryConflict: false, unresolvedQuestions: false, threadTooLong: false, autoSendCap: false, coldStart: false },
    })

    const [send] = await sendsFor(draft!.id)
    expect(send).toMatchObject({ status: 'queued', ticketId, connectionId: fx.connectionId, agentId: fx.agentId })
    // `agents.auto_send_delay_min` defaults to 2 minutes.
    expect(send!.sendAfter.getTime()).toBe(NOW.getTime() + 2 * 60_000)

    expect((await getTicket(ticketId)).status).toBe('auto_sending')
    expect(sends).toEqual([{ orgId: fx.orgId, sendId: send!.id, startAfter: send!.sendAfter }])
    // `notifications.push_auto_sends` is off by default.
    expect(await allNotifications()).toEqual([])
    expect(notified).toEqual([])

    const [run1] = await runsFor(ticketId)
    expect(run1!.output).toMatchObject({ outcome: 'reply', draftId: draft!.id, decision: 'send' })
    const created = await auditRowsFor(ticketId, 'draft.created')
    expect(created[0]!.detail).toMatchObject({ draftId: draft!.id, decision: 'send', reason: 'ok' })
    const events = await eventsFor(run1!.id)
    expect(events.at(-1)!.payload).toMatchObject({ action: 'send', reason: 'ok', evidence: 0.9, threshold: 0.8 })
  })

  it('16b. with notifications.push_auto_sends on, the auto landing inserts ONE auto_send push carrying the ticket and draft ids', async () => {
    await setPolicy(fx.categoryId, { mode: 'auto', autoSendMinConfidence: 80 })
    await seedHumanDecisions(10)
    await setOrgSetting('notifications.push_auto_sends', true)
    const answerId = crypto.randomUUID()
    const ticketId = await seedDraftableTicket()
    const provider = createFakeProvider([{ parsed: reply({ confidence: 0.9, usedAnswerIds: [answerId] }) }])
    const { deps, notified } = makeDeps(provider, { retriever: answerRetriever({ id: answerId, score: 0.95, approvals: 3 }) })

    await run(deps, ticketId)

    const [draft] = await draftsFor(ticketId)
    const pushes = await allNotifications()
    expect(pushes).toHaveLength(1)
    expect(pushes[0]!.kind).toBe('auto_send')
    expect(pushes[0]!.title).toBe('Auto-sending in 2 min · Order status · 90%')
    expect(pushes[0]!.body).toBe(CLEAN_BODY.slice(0, 140))
    expect(pushes[0]!.dedupeKey).toBe(`auto_send:${draft!.id}`)
    expect(pushes[0]!.payload).toEqual({ ticketId, draftId: draft!.id })
    expect(notified).toEqual([pushes[0]!.id])
  })

  interface AutoBlockerCase {
    cosine?: number
    approvals?: number
    conflict?: boolean
    unresolved?: string[]
    threadLength?: number
    dmarcPass?: boolean
    hasAttachments?: boolean
    autoSendsToday?: number
    humanDecisions?: number
  }

  const autoBlockers: [string, AutoBlockerCase, string][] = [
    ['below threshold', { cosine: 0.8, approvals: 1 }, 'below_threshold'],
    ['memory conflict', { conflict: true }, 'memory_conflict'],
    ['unresolved questions', { unresolved: ['Is it in stock?'] }, 'unresolved_questions'],
    ['thread longer than 6', { threadLength: 7 }, 'thread_too_long'],
    ['dmarc fail', { dmarcPass: false }, 'dmarc_fail'],
    ['attachments', { hasAttachments: true }, 'attachments'],
    ['auto-send cap reached', { autoSendsToday: 100 }, 'auto_send_cap'],
    ['cold start', { humanDecisions: 9 }, 'cold_start'],
  ]

  it.each(autoBlockers)('16c. category auto but %s → review landing with that reason (never a send)', async (_name, over, reason) => {
    await setPolicy(fx.categoryId, { mode: 'auto', autoSendMinConfidence: 80 })
    await seedHumanDecisions(over.humanDecisions ?? 10)
    if (over.autoSendsToday !== undefined) await setUsageCounter(SEND_METERS.autoSends, over.autoSendsToday)
    const answerId = crypto.randomUUID()
    const ticketId = await seedTicket({ hasAttachments: over.hasAttachments ?? false })
    for (let i = 0; i < (over.threadLength ?? 1); i++) {
      await seedInbound(ticketId, { dmarcPass: over.dmarcPass ?? true })
    }
    const provider = createFakeProvider([{
      parsed: reply({
        confidence: 0.9,
        usedAnswerIds: [answerId],
        memoryConflictIds: over.conflict ? [answerId] : [],
        unresolvedQuestions: over.unresolved ?? [],
      }),
    }])
    const { deps, sends } = makeDeps(provider, {
      retriever: answerRetriever({ id: answerId, score: over.cosine ?? 0.95, approvals: over.approvals ?? 3 }),
    })

    await run(deps, ticketId)

    const [draft] = await draftsFor(ticketId)
    expect(draft).toMatchObject({ status: 'pending', decision: 'review', decisionReason: reason, decisionSource: null, finalBody: null })
    expect(draft!.autoDecidedAt).toBeNull()
    expect(await sendsFor(draft!.id)).toEqual([])
    expect((await getTicket(ticketId)).status).toBe('awaiting_review')
    expect(sends).toEqual([])
  })

  it('16d. a memory conflict the model flags parks that answer in needs_review at landing time', async () => {
    const [answer] = await withOrg(app.db, fx.orgId, (tx) =>
      tx.insert(resolvedAnswers).values({
        orgId: fx.orgId, agentId: fx.agentId, categoryId: fx.categoryId,
        questionText: 'where is my order', answerBody: 'It ships tomorrow.', status: 'active', approvals: 3,
        expiresAt: new Date(NOW.getTime() + 365 * 86_400_000),
      }).returning({ id: resolvedAnswers.id }))
    const ticketId = await seedDraftableTicket()
    const provider = createFakeProvider([{ parsed: reply({ usedAnswerIds: [], memoryConflictIds: [answer!.id] }) }])
    const { deps } = makeDeps(provider, { retriever: answerRetriever({ id: answer!.id, score: 0.92, approvals: 3 }) })

    await run(deps, ticketId)

    const [row] = await withOrg(app.db, fx.orgId, (tx) =>
      tx.select().from(resolvedAnswers).where(eq(resolvedAnswers.id, answer!.id)))
    expect(row!.status).toBe('needs_review')
    expect(row!.reviewReason).toBe('model_conflict')
    const [draft] = await draftsFor(ticketId)
    expect(draft!.memoryConflictIds).toEqual([answer!.id])
    expect(draft!.confidenceBreakdown).toMatchObject({ blockers: { memoryConflict: true } })
  })

  // --- Phase 6: the resolved provider, the quality-tier cap, and the two provider failures -------

  it('17. byok/limited: confidence_breakdown.model is the CAPPED term, .modelRaw the model own number, the run row carries the credential provider/model, and drafts.confidence is still raw', async () => {
    const ticketId = await seedDraftableTicket()
    const chunkId = crypto.randomUUID()
    const provider = createFakeProvider([{ parsed: reply({ confidence: 0.95, citedChunkIds: [chunkId] }) }])
    const retriever: DetailedRetriever = {
      retrieve: async () => ({ chunks: [{ id: chunkId, heading: null, content: 'Orders ship next day.', score: 0.9 }], answers: [] }),
      retrieveDetailed: async () => ({
        chunks: [{ id: chunkId, heading: null, content: 'Orders ship next day.', score: 0.9 }],
        answers: [], knowledgeVersion: 7, mode: 'hybrid', degraded: false,
      }),
    }
    const { deps } = makeDeps(provider, {
      retriever,
      providers: staticResolver(provider, {
        mode: 'byok', credentialId: crypto.randomUUID(), provider: 'custom', model: 'qwen3:32b',
        tier: 'limited', modelGeneration: 3,
      }),
    })

    await run(deps, ticketId)

    const [draft] = await draftsFor(ticketId)
    // Deviation 1: `drafts.confidence` is still the model's own uncapped self-assessment.
    expect(draft!.confidence).toBeCloseTo(0.95, 6)
    expect(draft!.confidenceBreakdown).toMatchObject({
      model: 0.6, modelRaw: 0.95, modelCap: 0.6, tier: 'limited',
      provider: 'custom', modelId: 'qwen3:32b', mode: 'byok', modelGeneration: 3,
      evidence: 0.54,
    })
    const [run1] = await runsFor(ticketId)
    expect(run1!.provider).toBe('custom')
    expect(run1!.model).toBe('qwen3:32b')
  })

  it('17b. config.effort overrides the run first effort', async () => {
    const ticketId = await seedDraftableTicket()
    const provider = createFakeProvider([{ parsed: REPLY }])
    const { deps } = makeDeps(provider, { providers: staticResolver(provider, { effort: 'high' }) })

    await run(deps, ticketId)

    expect(provider.calls[0]!.effort).toBe('high')
    expect(provider.calls[0]!.model).toBe('claude-opus-5')
  })

  it('17c. a resolver refusal before the claim: needs_owner/provider_unavailable, ONE page, no run row, no stamp, no model call', async () => {
    const ticketId = await seedDraftableTicket()
    const provider = createFakeProvider([{ parsed: REPLY }])
    const { deps, notified } = makeDeps(provider, { providers: staticRefusal('credential_dead', { mode: 'byok', provider: 'openai', model: 'gpt-5' }) })

    await run(deps, ticketId)
    await run(deps, ticketId)      // a second attempt the same day pages nobody twice

    const ticket = await getTicket(ticketId)
    expect(ticket.status).toBe('needs_owner')
    expect(ticket.needsOwnerReason).toBe('provider_unavailable')
    expect(ticket.lastAgentRunAt).toBeNull()
    expect(provider.calls).toHaveLength(0)
    expect(await runsFor(ticketId)).toHaveLength(0)
    expect(await notificationsWithPrefix(`provider_unavailable:${ticketId}:`)).toHaveLength(1)
    expect(notified).toHaveLength(1)
    const [audited] = await auditRowsFor(ticketId, 'ticket.escalated')
    expect(audited!.detail).toMatchObject({ reason: 'provider_unavailable', refusal: 'credential_dead' })
  })

  it('17d. llm auth on a byok primary with no fallback: the credential goes dead, ONE provider_health page, ticket needs_owner/provider_unavailable, no rethrow', async () => {
    const credentialId = await seedCredential()
    const ticketId = await seedDraftableTicket()
    const provider = createFakeProvider([{ error: new LlmError('401 invalid api key', 'auth', false) }])
    const { deps, notified } = makeDeps(provider, { providers: staticResolver(provider, byokConfig(credentialId)) })

    await run(deps, ticketId)     // does NOT throw: a dead key is not something pg-boss can retry

    const cred = await credentialRow(credentialId)
    expect(cred.healthStatus).toBe('dead')
    expect(cred.consecutiveFailures).toBe(1)
    const ticket = await getTicket(ticketId)
    expect(ticket.status).toBe('needs_owner')
    expect(ticket.needsOwnerReason).toBe('provider_unavailable')
    const [run1] = await runsFor(ticketId)
    expect(run1!.status).toBe('failed')
    expect(run1!.errorCode).toBe('llm_auth')
    const health = await notificationsWithPrefix(`provider_health:${credentialId}:`)
    expect(health).toHaveLength(1)
    expect(await notificationsWithPrefix(`provider_unavailable:${ticketId}:`)).toHaveLength(1)
    expect(notified).toHaveLength(2)
  })

  it('17e. llm auth WITH fallback: the second call goes to the managed provider, the run records the fallback and the breakdown says managed', async () => {
    const credentialId = await seedCredential()
    const ticketId = await seedDraftableTicket()
    const byok = createFakeProvider([{ error: new LlmError('401 invalid api key', 'auth', false) }])
    const managed = createFakeProvider([{ parsed: REPLY }])
    const { deps } = makeDeps(byok, { providers: staticResolver(byok, byokConfig(credentialId, { fallbackToManaged: true }), managed) })

    await run(deps, ticketId)

    expect(byok.calls).toHaveLength(1)
    expect(managed.calls).toHaveLength(1)
    expect(managed.calls[0]!.model).toBe('claude-opus-5')
    expect(managed.calls[0]!.meta.mode).toBe('managed')
    const [draft] = await draftsFor(ticketId)
    expect(draft!.status).toBe('pending')
    expect(draft!.confidenceBreakdown).toMatchObject({ mode: 'managed', provider: 'anthropic', modelId: 'claude-opus-5', tier: 'limited' })
    // The credential is NOT killed: the fallback covered this call and the probe owns health.
    expect((await credentialRow(credentialId)).healthStatus).toBe('healthy')
    const [run1] = await runsFor(ticketId)
    const fallbackEvents = (await eventsFor(run1!.id)).filter((e) => (e.payload as { fallback?: boolean }).fallback === true)
    expect(fallbackEvents).toHaveLength(1)
    expect(fallbackEvents[0]!.payload).toMatchObject({ from: 'custom', code: 'auth' })
  })

  it('17f. rate_limit WITH fallback recovers; without one it is the ordinary failure path (rethrow)', async () => {
    const withFallbackTicket = await seedDraftableTicket()
    const byok = createFakeProvider([{ error: new LlmError('429', 'rate_limit', true) }])
    const managed = createFakeProvider([{ parsed: REPLY }])
    const { deps } = makeDeps(byok, {
      providers: staticResolver(byok, { mode: 'byok', credentialId: crypto.randomUUID(), provider: 'openai', model: 'gpt-5', fallbackToManaged: true }, managed),
    })
    await run(deps, withFallbackTicket)
    expect(managed.calls).toHaveLength(1)
    expect((await draftsFor(withFallbackTicket))[0]!.status).toBe('pending')

    const plainTicket = await seedDraftableTicket()
    const byok2 = createFakeProvider([{ error: new LlmError('429 again', 'rate_limit', true) }])
    const { deps: deps2 } = makeDeps(byok2, {
      providers: staticResolver(byok2, { mode: 'byok', credentialId: crypto.randomUUID(), provider: 'openai', model: 'gpt-5' }),
    })
    await expect(run(deps2, plainTicket)).rejects.toThrow(/429 again/)
    const [run2] = await runsFor(plainTicket)
    expect(run2!.errorCode).toBe('llm_rate_limit')
    expect((await getTicket(plainTicket)).agentFailureCount).toBe(1)
  })

  it('17g. the fallback call is METERED under its own idempotency key: two llm_calls rows for the run — the tenant\'s error row and the managed success row', async () => {
    const credentialId = await seedCredential()
    const ticketId = await seedDraftableTicket()
    // The real stack: metering innermost, and `withMeta` is what `createByokProvider` uses to stamp
    // `mode`/`credentialId` on the tenant's calls. Without the `:fallback` suffix on the second
    // call's key, the sink's ON CONFLICT DO NOTHING silently drops the managed row (the primary's
    // ERROR row already claimed the key), and the managed spend is invisible to every cap and screen.
    const sink = createMeterSink(app.db, { onError: (err) => { throw err } })
    const byokRaw = createFakeProvider([{ error: new LlmError('502 bad gateway', 'transient', true) }])
    const byok = withMeta(withMetering(byokRaw, sink, { cacheTtl: '5m' }), { mode: 'byok', credentialId })
    const managedRaw = createFakeProvider([{ parsed: REPLY, usage: { inputTokens: 1000, outputTokens: 100 } }])
    const managed = withMetering(managedRaw, sink, { cacheTtl: '1h' })
    const { deps } = makeDeps(byok, { providers: staticResolver(byok, byokConfig(credentialId, { fallbackToManaged: true }), managed) })

    await run(deps, ticketId)

    const [run1] = await runsFor(ticketId)
    const calls = await llmCallsFor(run1!.id)
    expect(calls).toHaveLength(2)
    expect(calls[0]).toMatchObject({ mode: 'byok', credentialId, errorCode: 'transient', finish: 'error' })
    expect(calls[1]).toMatchObject({ mode: 'managed', credentialId: null, errorCode: null, model: 'claude-opus-5' })
    expect(calls[1]!.inputTokens).toBe(1000)
    // Two DIFFERENT keys — that is the whole point.
    expect(new Set(calls.map((c) => c.idempotencyKey)).size).toBe(2)
    expect(calls[1]!.idempotencyKey).toBe(`${calls[0]!.idempotencyKey}:fallback`)
  })

  it('17h. the breakdown\'s provenance is the ATTEMPT whose body landed: a fallback on attempt 1 and a tenant success on attempt 2 reads byok', async () => {
    const credentialId = await seedCredential()
    const ticketId = await seedDraftableTicket()
    // Attempt 1: the tenant's provider throws, the managed fallback answers with a body the
    // guardrails hard-fail. Attempt 2 (the automatic redraft) goes back to the tenant's own
    // provider and comes back clean — so the STORED body is the tenant's, not Managed AI's.
    const byok = createFakeProvider([{ error: new LlmError('502', 'transient', true) }, { parsed: REPLY }])
    const managed = createFakeProvider([{ parsed: reply({ body: HTML_BODY }) }])
    const { deps } = makeDeps(byok, { providers: staticResolver(byok, byokConfig(credentialId, { fallbackToManaged: true }), managed) })

    await run(deps, ticketId)

    expect(byok.calls).toHaveLength(2)
    expect(managed.calls).toHaveLength(1)
    const [draft] = await draftsFor(ticketId)
    expect(draft!.body).toBe(CLEAN_BODY)
    expect(draft!.confidenceBreakdown).toMatchObject({ provider: 'custom', modelId: 'qwen3:32b', mode: 'byok' })
  })
})
