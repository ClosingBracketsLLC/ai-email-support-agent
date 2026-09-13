/**
 * `runMemoryCapture` against real Postgres with the deterministic hash embedder — no pg-boss. One
 * `it` per behavior in the task brief's `memory.capture` bullet list.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import pino from 'pino'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { MEMORY_EXPIRY_DAYS } from '@aesa/core'
import {
  agents, auditLog, categories, customerHash, drafts, ensureCustomerHashSalt, ensureDefaultCategories,
  KNOWLEDGE_METERS, mailboxConnections, messages, orgSettings, resolvedAnswers, tickets, usageCounters,
  user, withOrg, workspaces,
} from '@aesa/db'
import { createDb } from '@aesa/db/raw'
import { createTestDatabase, createTestOrganization } from '@aesa/db/testing'
import { createHashEmbedder, scrubForMemory, type Embedder } from '@aesa/knowledge'
import { MemoryCapturePayload, runMemoryCapture, type MemoryCaptureDeps } from '../src/jobs/memory-capture.ts'

const rand = () => randomBytes(4).toString('hex')
const NOW = new Date('2026-09-11T12:00:00Z')
const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60_000)

let t: Awaited<ReturnType<typeof createTestDatabase>>
let app: ReturnType<typeof createDb>
let userId: string

interface Fixture { orgId: string; connectionId: string; agentId: string; categoryId: string }
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
beforeEach(async () => { fx = await seedOrg() })

async function seedOrg(): Promise<Fixture> {
  const orgId = await createTestOrganization(app)
  return withOrg(app.db, orgId, async (tx) => {
    await tx.insert(workspaces).values({ orgId, businessName: 'Acme Dog Supplies', timezone: 'UTC' })
    await ensureDefaultCategories(tx)
    const [conn] = await tx.insert(mailboxConnections)
      .values({ orgId, provider: 'gmail', providerAccountId: `acct-${rand()}`, emailAddress: `support-${rand()}@acme.test`, status: 'connected', connectedByUserId: userId })
      .returning({ id: mailboxConnections.id })
    const [agent] = await tx.insert(agents)
      .values({ orgId, connectionId: conn!.id, address: `support-${rand()}@acme.test`, domain: 'acme.test', displayName: 'Acme Support', status: 'active', priority: 0, signature: 'Acme Support' })
      .returning({ id: agents.id })
    const cats = await tx.select({ id: categories.id, key: categories.key }).from(categories)
    return { orgId, connectionId: conn!.id, agentId: agent!.id, categoryId: cats.find((c) => c.key === 'order_status')!.id }
  })
}

const DEFAULT_BODY = 'Hi Casey,\n\nYour order ships within two business days.\n\nThanks,\nAcme Support'

interface SeedOpts {
  decisionSource?: 'app' | 'email' | 'auto'
  editDistanceRatio?: number
  usedAnswerIds?: string[]
  citedChunkIds?: string[]
  knowledgeVersion?: number
  body?: string
  customerEmail?: string | null
  customerName?: string | null
  questions?: string[]
  inboundBody?: string
  memoryCapturedAt?: Date | null
}

/** A `sent` draft, a `waiting_on_customer` ticket carrying `triageQuestions`, and one inbound message. */
async function seedSentDraft(opts: SeedOpts = {}): Promise<{ draftId: string; ticketId: string }> {
  const {
    decisionSource = 'app', editDistanceRatio = 0, usedAnswerIds = [], citedChunkIds = [],
    knowledgeVersion = 4, body = DEFAULT_BODY, customerEmail = 'casey@customer.test', customerName = 'Casey',
    questions = ['Where is my order?'], inboundBody = questions.join('\n') || 'Hi,',
    memoryCapturedAt = null,
  } = opts
  return withOrg(app.db, fx.orgId, async (tx) => {
    const [ticket] = await tx.insert(tickets).values({
      orgId: fx.orgId, connectionId: fx.connectionId, agentId: fx.agentId, providerThreadId: `thread-${rand()}`,
      status: 'waiting_on_customer', categoryId: fx.categoryId, subject: 'Where is my order?',
      customerEmail, customerName, triageQuestions: questions, lastInboundAt: minutesAgo(5),
    }).returning({ id: tickets.id })
    await tx.insert(messages).values({
      orgId: fx.orgId, ticketId: ticket!.id, connectionId: fx.connectionId, providerMessageId: `msg-${rand()}`,
      direction: 'inbound', fromAddress: customerEmail ?? 'unknown@example.test', bodyText: inboundBody,
      dmarcPass: true, sentAt: minutesAgo(5),
    })
    const [draft] = await tx.insert(drafts).values({
      orgId: fx.orgId, ticketId: ticket!.id, agentId: fx.agentId, categoryId: fx.categoryId, version: 1,
      body, finalBody: body, decision: 'review', decisionReason: 'below_threshold', status: 'sent',
      threadSnapshotAt: minutesAgo(5), expiresAt: new Date(NOW.getTime() + 86_400_000),
      decidedBy: userId, decidedAt: minutesAgo(1), decisionSource, editDistanceRatio,
      usedAnswerIds, citedChunkIds, confidenceBreakdown: { grounding: { knowledgeVersion } },
      memoryCapturedAt,
    }).returning({ id: drafts.id })
    return { draftId: draft!.id, ticketId: ticket!.id }
  })
}

/** A pre-existing answer, `active` unless overridden — the fixture the reinforce/supersede tests reuse. */
async function seedAnswer(over: Partial<typeof resolvedAnswers.$inferInsert> = {}): Promise<string> {
  const [row] = await withOrg(app.db, fx.orgId, (tx) =>
    tx.insert(resolvedAnswers).values({
      orgId: fx.orgId, agentId: fx.agentId, categoryId: fx.categoryId,
      questionText: 'where is my order', answerBody: 'It ships within two business days.',
      status: 'active', approvals: 3, reuseCount: 1, strikes: 0,
      lastApprovedAt: minutesAgo(60 * 24), expiresAt: new Date(NOW.getTime() + 300 * 86_400_000),
      ...over,
    }).returning({ id: resolvedAnswers.id }))
  return row!.id
}

const getDraft = async (draftId: string) =>
  (await withOrg(app.db, fx.orgId, (tx) => tx.select().from(drafts).where(eq(drafts.id, draftId))))[0]!
const getAnswer = async (id: string) =>
  (await withOrg(app.db, fx.orgId, (tx) => tx.select().from(resolvedAnswers).where(eq(resolvedAnswers.id, id))))[0]!
const allAnswers = async () => withOrg(app.db, fx.orgId, (tx) => tx.select().from(resolvedAnswers))
const auditRows = async (entityId: string, action: string) =>
  withOrg(app.db, fx.orgId, (tx) => tx.select().from(auditLog).where(and(eq(auditLog.entityId, entityId), eq(auditLog.action, action))))

function makeDeps(over: Partial<MemoryCaptureDeps> = {}): MemoryCaptureDeps {
  return { db: app.db, embedder: createHashEmbedder(), logger: pino({ level: 'silent' }), now: () => NOW, ...over }
}

const run = (deps: MemoryCaptureDeps, draftId: string) =>
  runMemoryCapture(deps, { orgId: fx.orgId, draftId }, new AbortController().signal)
const runRemember = (deps: MemoryCaptureDeps, messageId: string) =>
  runMemoryCapture(deps, { orgId: fx.orgId, messageId }, new AbortController().signal)

const TODAY = NOW.toISOString().slice(0, 10)

interface OutboundOpts {
  customerEmail?: string | null
  customerName?: string | null
  inboundBody?: string | null
  outboundBody?: string
  /** false seeds an outbound reply with NO inbound message before it on the ticket. */
  withInbound?: boolean
}

/** A ticket, an optional inbound message, and one outbound (already-sent) reply after it —
 *  "Remember this reply"'s own source shape, with no draft anywhere behind it. */
async function seedOutboundReply(opts: OutboundOpts = {}): Promise<{ messageId: string; ticketId: string }> {
  const {
    customerEmail = 'casey@customer.test', customerName = 'Casey', inboundBody = 'Where is my order?',
    outboundBody = DEFAULT_BODY, withInbound = true,
  } = opts
  return withOrg(app.db, fx.orgId, async (tx) => {
    const [ticket] = await tx.insert(tickets).values({
      orgId: fx.orgId, connectionId: fx.connectionId, agentId: fx.agentId, providerThreadId: `thread-${rand()}`,
      status: 'waiting_on_customer', categoryId: fx.categoryId, subject: 'Where is my order?',
      customerEmail, customerName, lastInboundAt: withInbound ? minutesAgo(10) : null,
    }).returning({ id: tickets.id })
    if (withInbound) {
      await tx.insert(messages).values({
        orgId: fx.orgId, ticketId: ticket!.id, connectionId: fx.connectionId, providerMessageId: `msg-in-${rand()}`,
        direction: 'inbound', fromAddress: customerEmail ?? 'unknown@example.test', bodyText: inboundBody,
        dmarcPass: true, sentAt: minutesAgo(10),
      })
    }
    const [outbound] = await tx.insert(messages).values({
      orgId: fx.orgId, ticketId: ticket!.id, connectionId: fx.connectionId, providerMessageId: `msg-out-${rand()}`,
      direction: 'outbound', fromAddress: 'support@acme.test', bodyText: outboundBody, sentAt: minutesAgo(1),
    }).returning({ id: messages.id })
    return { messageId: outbound!.id, ticketId: ticket!.id }
  })
}

async function setOrgSetting(key: string, value: unknown): Promise<void> {
  await withOrg(app.db, fx.orgId, (tx) =>
    tx.insert(orgSettings).values({ orgId: fx.orgId, key, value })
      .onConflictDoUpdate({ target: [orgSettings.orgId, orgSettings.key], set: { value } }))
}

async function setEmbedTokens(value: number): Promise<void> {
  await withOrg(app.db, fx.orgId, (tx) =>
    tx.insert(usageCounters).values({ orgId: fx.orgId, day: TODAY, meter: KNOWLEDGE_METERS.embedTokens, value })
      .onConflictDoUpdate({ target: [usageCounters.orgId, usageCounters.day, usageCounters.meter], set: { value } }))
}

async function embedTokens(): Promise<number> {
  const [row] = await withOrg(app.db, fx.orgId, (tx) =>
    tx.select().from(usageCounters).where(and(eq(usageCounters.day, TODAY), eq(usageCounters.meter, KNOWLEDGE_METERS.embedTokens))))
  return row?.value ?? 0
}

describe('memory.capture', () => {
  it('a human-approved, unchanged draft that used no answer becomes ONE active answer: scrubbed question and body, embedded, approvals 1, expires in 365 d, customer hash set, knowledge_version from the grounding', async () => {
    const { draftId } = await seedSentDraft({ decisionSource: 'app', editDistanceRatio: 0, usedAnswerIds: [], knowledgeVersion: 7 })
    const deps = makeDeps()

    const outcome = await run(deps, draftId)

    expect(outcome).toBe('captured')
    const rows = await allAnswers()
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row.questionText).toBe(scrubForMemory('Where is my order?'))
    expect(row.answerBody).toBe(scrubForMemory(DEFAULT_BODY, { customerName: 'Casey', customerEmail: 'casey@customer.test' }))
    expect(row.answerBody).not.toContain('Hi Casey')
    expect(row.questionEmbedding).not.toBeNull()
    expect(row.questionEmbedding).toHaveLength(1024)
    expect(row.embeddingModel).toBe('hash-v1')
    expect(row.status).toBe('active')
    expect(row.approvals).toBe(1)
    expect(row.lastApprovedAt).toEqual(NOW)
    expect(row.expiresAt).toEqual(new Date(NOW.getTime() + MEMORY_EXPIRY_DAYS * 86_400_000))
    expect(row.knowledgeVersion).toBe(7)

    const salt = await withOrg(app.db, fx.orgId, (tx) => ensureCustomerHashSalt(tx, fx.orgId))
    expect(row.sourceCustomerHash).toBe(customerHash(salt, 'casey@customer.test'))

    const draft = await getDraft(draftId)
    expect(draft.memoryCapturedAt).toEqual(NOW)

    const captured = await auditRows(draftId, 'memory.captured')
    expect(captured).toHaveLength(1)
  })

  it('a second delivery of the same job is a no-op (memory_captured_at is the gate)', async () => {
    const { draftId } = await seedSentDraft()
    const deps = makeDeps()

    expect(await run(deps, draftId)).toBe('captured')
    expect(await run(deps, draftId)).toBe('skipped')

    expect(await allAnswers()).toHaveLength(1)
  })

  it('an unchanged approval that USED an active answer reinforces it instead of inserting: approvals +1, reuse_count +1, last_approved_at and expires_at moved', async () => {
    const answerId = await seedAnswer({ approvals: 3, reuseCount: 1 })
    const { draftId } = await seedSentDraft({ decisionSource: 'app', editDistanceRatio: 0, usedAnswerIds: [answerId] })
    const deps = makeDeps()

    const outcome = await run(deps, draftId)

    expect(outcome).toBe('reinforced')
    expect(await allAnswers()).toHaveLength(1)
    const row = await getAnswer(answerId)
    expect(row.approvals).toBe(4)
    expect(row.reuseCount).toBe(2)
    expect(row.lastApprovedAt).toEqual(NOW)
    expect(row.expiresAt).toEqual(new Date(NOW.getTime() + MEMORY_EXPIRY_DAYS * 86_400_000))

    const reinforced = await auditRows(draftId, 'memory.reinforced')
    expect(reinforced).toHaveLength(1)
  })

  it('an EDITED approval that used an answer inserts a superseding answer (was_edited, supersedes_id) and parks the old one in needs_review with one strike (deviation 9)', async () => {
    const answerId = await seedAnswer({ approvals: 1, strikes: 0 })
    const { draftId } = await seedSentDraft({ decisionSource: 'app', editDistanceRatio: 0.4, usedAnswerIds: [answerId] })
    const deps = makeDeps()

    const outcome = await run(deps, draftId)

    expect(outcome).toBe('captured')
    const rows = await allAnswers()
    expect(rows).toHaveLength(2)
    const inserted = rows.find((r) => r.id !== answerId)!
    expect(inserted.wasEdited).toBe(true)
    expect(inserted.supersedesId).toBe(answerId)
    expect(inserted.status).toBe('active')
    expect(inserted.approvals).toBe(1)

    const old = await getAnswer(answerId)
    expect(old.status).toBe('needs_review')
    expect(old.reviewReason).toBe('edited_reuse')
    expect(old.strikes).toBe(1)
  })

  it('a second strike retires an answer (retired_reason strikes)', async () => {
    const answerId = await seedAnswer({ approvals: 2, strikes: 1 })
    const { draftId } = await seedSentDraft({ decisionSource: 'app', editDistanceRatio: 0.4, usedAnswerIds: [answerId] })
    const deps = makeDeps()

    const outcome = await run(deps, draftId)

    expect(outcome).toBe('captured')
    const old = await getAnswer(answerId)
    expect(old.status).toBe('retired')
    expect(old.retiredReason).toBe('strikes')
    expect(old.strikes).toBe(2)
  })

  it('an auto-sent draft becomes a candidate (approvals 0), never active; its customer hash is still set', async () => {
    const { draftId } = await seedSentDraft({ decisionSource: 'auto', editDistanceRatio: 0, usedAnswerIds: [] })
    const deps = makeDeps()

    const outcome = await run(deps, draftId)

    expect(outcome).toBe('captured')
    const rows = await allAnswers()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.status).toBe('candidate')
    expect(rows[0]!.approvals).toBe(0)
    expect(rows[0]!.lastApprovedAt).toBeNull()
    expect(rows[0]!.sourceCustomerHash).not.toBeNull()
  })

  it('an empty scrubbed question (a greeting-only message) captures nothing and stamps the draft anyway', async () => {
    const { draftId } = await seedSentDraft({ questions: [], inboundBody: 'Hi,' })
    const deps = makeDeps()

    const outcome = await run(deps, draftId)

    expect(outcome).toBe('skipped')
    expect(await allAnswers()).toHaveLength(0)
    const draft = await getDraft(draftId)
    expect(draft.memoryCapturedAt).toEqual(NOW)

    const skipped = await auditRows(draftId, 'memory.skipped')
    expect(skipped).toHaveLength(1)
    expect(skipped[0]!.detail).toMatchObject({ reason: 'empty_after_scrub' })
  })

  it('the embedder throwing leaves the draft unstamped so the retry captures later', async () => {
    const { draftId } = await seedSentDraft()
    const failingEmbedder: Embedder = {
      model: 'hash-v1', version: 1, dimensions: 1024,
      embed: async () => { throw new Error('voyage: 500') },
    }
    const deps = makeDeps({ embedder: failingEmbedder })

    await expect(run(deps, draftId)).rejects.toThrow('voyage: 500')

    const draft = await getDraft(draftId)
    expect(draft.memoryCapturedAt).toBeNull()
    expect(await allAnswers()).toHaveLength(0)
  })

  it('P6 a successful capture bumps the embed_tokens meter by the embed\'s own tokens', async () => {
    const { draftId } = await seedSentDraft()
    const counting: Embedder = {
      model: 'hash-v1', version: 1, dimensions: 1024,
      embed: async () => ({ vectors: [Array.from({ length: 1024 }, () => 0.01)], tokens: 137 }),
    }

    expect(await run(makeDeps({ embedder: counting }), draftId)).toBe('captured')

    expect(await embedTokens()).toBe(137)
  })

  it('P6 at knowledge.daily_embed_tokens_cap the draft is stamped and audited memory.skipped/embed_cap, with no embed and no answer', async () => {
    await setOrgSetting('knowledge.daily_embed_tokens_cap', 1000)
    await setEmbedTokens(1000)
    const { draftId } = await seedSentDraft()
    let embedded = 0
    const counting: Embedder = {
      model: 'hash-v1', version: 1, dimensions: 1024,
      embed: async () => { embedded += 1; return { vectors: [[]], tokens: 1 } },
    }

    expect(await run(makeDeps({ embedder: counting }), draftId)).toBe('skipped')

    expect(embedded).toBe(0)
    expect(await allAnswers()).toHaveLength(0)
    expect((await getDraft(draftId)).memoryCapturedAt).toEqual(NOW)
    const skipped = await auditRows(draftId, 'memory.skipped')
    expect(skipped).toHaveLength(1)
    expect(skipped[0]!.detail).toMatchObject({ reason: 'embed_cap' })
    // The cap was not moved by a capture that never happened.
    expect(await embedTokens()).toBe(1000)
  })
})

describe('memory.capture — "Remember this reply" (messageId)', () => {
  it('an outbound message whose ticket has an earlier inbound becomes an active answer: approvals 1, was_edited false, source_message_id/source_ticket_id set, source_draft_id null, scrubbed texts, customer hash', async () => {
    const { messageId, ticketId } = await seedOutboundReply()
    const deps = makeDeps()

    const outcome = await runRemember(deps, messageId)

    expect(outcome).toBe('captured')
    const rows = await allAnswers()
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row.status).toBe('active')
    expect(row.approvals).toBe(1)
    expect(row.wasEdited).toBe(false)
    expect(row.sourceMessageId).toBe(messageId)
    expect(row.sourceTicketId).toBe(ticketId)
    expect(row.sourceDraftId).toBeNull()
    expect(row.questionText).toBe(scrubForMemory('Where is my order?'))
    expect(row.answerBody).toBe(scrubForMemory(DEFAULT_BODY, { customerName: 'Casey', customerEmail: 'casey@customer.test' }))
    expect(row.answerBody).not.toContain('Hi Casey')
    expect(row.questionEmbedding).not.toBeNull()

    const salt = await withOrg(app.db, fx.orgId, (tx) => ensureCustomerHashSalt(tx, fx.orgId))
    expect(row.sourceCustomerHash).toBe(customerHash(salt, 'casey@customer.test'))

    const captured = await auditRows(messageId, 'memory.captured')
    expect(captured).toHaveLength(1)
  })

  it('a second run of the SAME message is a no-op through the partial unique index, and audits memory.skipped/already_remembered', async () => {
    const { messageId } = await seedOutboundReply()
    const deps = makeDeps()

    expect(await runRemember(deps, messageId)).toBe('captured')
    expect(await runRemember(deps, messageId)).toBe('skipped')

    expect(await allAnswers()).toHaveLength(1)
    const skipped = await auditRows(messageId, 'memory.skipped')
    expect(skipped).toHaveLength(1)
    expect(skipped[0]!.detail).toMatchObject({ reason: 'already_remembered' })
  })

  it('an outbound message with no inbound before it on the ticket is skipped (no_question)', async () => {
    const { messageId } = await seedOutboundReply({ withInbound: false })
    const deps = makeDeps()

    const outcome = await runRemember(deps, messageId)

    expect(outcome).toBe('skipped')
    expect(await allAnswers()).toHaveLength(0)
    const skipped = await auditRows(messageId, 'memory.skipped')
    expect(skipped).toHaveLength(1)
    expect(skipped[0]!.detail).toMatchObject({ reason: 'no_question' })
  })

  it('every load-time refusal audits its own reason — an inbound id, a purged body, a never-sent reply and an unknown id (ruling R20)', async () => {
    // Task 7's review and Task 8's own concern found the same hole from both sides: these four all
    // landed a silent `skipped` with no record at all, on a path a human just tapped. The api's
    // `rememberReply` refuses the first three at request time, so reaching the job means something
    // changed underneath the tap — which is exactly when the audit row earns its keep.
    const deps = makeDeps()

    const { ticketId } = await seedOutboundReply()
    const [inbound] = await withOrg(app.db, fx.orgId, (tx) =>
      tx.select({ id: messages.id }).from(messages)
        .where(and(eq(messages.ticketId, ticketId), eq(messages.direction, 'inbound'))))
    expect(await runRemember(deps, inbound!.id)).toBe('skipped')
    expect((await auditRows(inbound!.id, 'memory.skipped'))[0]!.detail).toMatchObject({ reason: 'not_outbound' })

    const purged = await seedOutboundReply()
    await withOrg(app.db, fx.orgId, (tx) =>
      tx.update(messages).set({ bodyText: null, bodyPurgedAt: NOW }).where(eq(messages.id, purged.messageId)))
    expect(await runRemember(deps, purged.messageId)).toBe('skipped')
    expect((await auditRows(purged.messageId, 'memory.skipped'))[0]!.detail).toMatchObject({ reason: 'empty' })

    const unsent = await seedOutboundReply()
    await withOrg(app.db, fx.orgId, (tx) =>
      tx.update(messages).set({ sentAt: null }).where(eq(messages.id, unsent.messageId)))
    expect(await runRemember(deps, unsent.messageId)).toBe('skipped')
    expect((await auditRows(unsent.messageId, 'memory.skipped'))[0]!.detail).toMatchObject({ reason: 'not_sent' })

    const unknown = randomUUID()
    expect(await runRemember(deps, unknown)).toBe('skipped')
    expect((await auditRows(unknown, 'memory.skipped'))[0]!.detail).toMatchObject({ reason: 'not_found' })

    expect(await allAnswers()).toHaveLength(0)
  })

  it('the payload refine rejects both-or-neither ids', () => {
    expect(MemoryCapturePayload.safeParse({ orgId: fx.orgId }).success).toBe(false)
    expect(MemoryCapturePayload.safeParse({ orgId: fx.orgId, draftId: 'd1', messageId: 'm1' }).success).toBe(false)
    expect(MemoryCapturePayload.safeParse({ orgId: fx.orgId, draftId: 'd1' }).success).toBe(true)
    expect(MemoryCapturePayload.safeParse({ orgId: fx.orgId, messageId: 'm1' }).success).toBe(true)
  })

  it('respects the embed-tokens cap the same way the draft path does', async () => {
    await setOrgSetting('knowledge.daily_embed_tokens_cap', 1000)
    await setEmbedTokens(1000)
    const { messageId } = await seedOutboundReply()

    const outcome = await runRemember(makeDeps(), messageId)

    expect(outcome).toBe('skipped')
    expect(await allAnswers()).toHaveLength(0)
    const skipped = await auditRows(messageId, 'memory.skipped')
    expect(skipped).toHaveLength(1)
    expect(skipped[0]!.detail).toMatchObject({ reason: 'embed_cap' })
  })
})
