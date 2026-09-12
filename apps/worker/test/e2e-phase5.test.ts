/**
 * Phase 5 close-out: the spec's Phase-5 verification list driven end-to-end through the REAL
 * pg-boss jobs (`mailbox.sync` → `ticket.triage` → `ticket.draft` carrying the REAL
 * `createRetriever`, then `send.execute` → `memory.capture`) and the REAL api services
 * (`@aesa/api/drafts`'s approve/hold/reject and `@aesa/api/memory`'s sampling and erasure, wired to
 * `createApiFacade`/`createEnqueue` from `@aesa/api/deps`). The unit suites — `ticket-draft.test.ts`,
 * `send-execute.test.ts`, `memory-capture.test.ts`, `stats-rollup.test.ts`,
 * `packages/core/test/{autonomy,evidence}.test.ts`, `packages/knowledge/test/retrieval-answers.test.ts`
 * and `apps/api/test/{drafts,memory,agents}-router.test.ts` — own the branch-by-branch rules; this
 * file exists to prove the WIRING between them: three approvals really teach one answer, that answer
 * really raises the next draft's evidence, the evidence really crosses the category's threshold, the
 * auto-send really goes out and really becomes an unsampled candidate, and every human correction
 * really reaches back into the memory and the policy.
 *
 * Shape ported from `e2e-phase4.test.ts`: one throwaway database (`createTestDatabase`) for every
 * business table, one pg-boss instance on the shared dev `DATABASE_URL` under a schema unique to
 * THIS run (`pgboss_e2e5_<hex>`, dropped in `afterAll`) — never `pgboss_test`, which other spec
 * files poll concurrently. `createMockMailbox` (`@aesa/mail`) is plugged into `mailbox.sync` AND
 * `send.execute` through their `clientFactory` seams; a `createFakeProvider` (`@aesa/llm`) wrapped in
 * the real `withMetering`/`createMeterSink` pair stands in for every model call (so `llm_calls` rows
 * are real); ONE `createHashEmbedder()` is shared by the retriever's answers leg and by
 * `memory.capture`'s write — exactly the production invariant `agent-role.ts` exists to keep (the
 * model that WROTE a workspace's answer vectors must be the model that queries them).
 *
 * FOUR harness-level seams, all arrangement rather than assertion:
 *
 *  1. **The draft script names answers by MARKER, not by id.** A fake script is a static object, but
 *     the `resolved_answers` ids it must name are minted by `memory.capture` at run time. So the
 *     provider is wrapped: a `usedAnswerIds` (or `memoryConflictIds`) entry of `use:<needle>` is
 *     replaced, at call time, by the id of the retrieved ANSWER whose `Q:` line carries `<needle>`,
 *     read out of the request's OWN knowledge block (`knowledgeBlock` renders each answer as
 *     `[<uuid>] Q: …` / `A: …`) with a regex over `[<uuid>]`. It mirrors `e2e-phase4.test.ts`'s
 *     `cite:` wrapper exactly, and it means every `used_answer_ids` assertion below is an assertion
 *     about the real prompt.
 *  2. **The hold window is collapsed by the `enqueueSend` seam** (plan deviation 4). An auto landing
 *     writes a `queued` send due `agent.auto_send_delay_min` (2) minutes out; rather than sleep that
 *     out, this file's `TicketDraftDeps.enqueueSend` rewrites that ONE row's `send_after` to now and
 *     enqueues `send.execute` immediately. The production contract is untouched — no 0-minute delay
 *     is invented, and the delay itself is unit-tested in `ticket-draft.test.ts`.
 *  3. **That seam is gateable.** `gateSends()` parks the seam on a promise the test resolves, which
 *     is what makes scenarios 2 and 3 assert the *pre-send* state (`auto_sending` + a `queued`
 *     send) without racing the delivery — and what lets scenario 3's `holdDraft` provably run BEFORE
 *     `send.execute` is ever enqueued. The job blocks inside its own handler for the fraction of a
 *     second the assertions take; `DRAFT_JOB_EXPIRE_SECONDS` is 600, so nothing is at risk.
 *  4. **The send job's clock runs `SEND_CLOCK_SKEW_MS` (16 s) ahead** — `e2e-phase3.test.ts`'s note 1,
 *     for the same reason: an owner approve writes `send_after = now + APPROVE_UNDO_SECONDS` and the
 *     15 s undo window is real wall time. Each scenario triggers its own run with `rawSend`.
 *
 * NO wall-clock sleeps anywhere: every wait polls the database (or the recorded log lines) for the
 * state it expects under a bounded deadline (`waitFor`), the discipline `e2e-phase3/4` keep. Cleanup
 * is scoped to this file's own throwaway database and its own pg-boss schema.
 */
import { randomBytes } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import pg from 'pg'
import type PgBoss from 'pg-boss'
import pino from 'pino'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { DraftDecision } from '@aesa/agent'
import { createApiFacade, createEnqueue } from '@aesa/api/deps'
import { approveDraft, holdDraft, markViewed, rejectDraft, type DraftActor, type DraftServiceDeps } from '@aesa/api/drafts'
import { confirmCandidate, deleteByCustomer, type MemoryActor, type MemoryServiceDeps } from '@aesa/api/memory'
import { INVARIANTS } from '@aesa/core'
import { encrypt, hashToken, loadKekRing, Secret, type KekRing } from '@aesa/crypto'
import {
  agentCategoryPolicies, agents, auditLog, categories, countHumanDecisions, createMeterSink, drafts,
  ensureDefaultCategories, loadOrgDek, mailboxConnections, mailboxCredentials, member,
  notificationDevices, notifications, outboundSends, provisionOrgKeys, resolvedAnswers, SEND_METERS,
  tickets, usageCounters, user, withOrg, withPlatform, workspaces,
} from '@aesa/db'
import { createDb } from '@aesa/db/raw'
import { createTestDatabase, createTestOrganization } from '@aesa/db/testing'
import { createHashEmbedder, createRetriever } from '@aesa/knowledge'
import { createFakeProvider, withMetering, type ChatRequest, type ChatResult, type FakeScript, type LlmProvider } from '@aesa/llm'
import { createMailLimiter, createMockMailbox, MARKER_HEADER, type MailboxProvider, type MockMailbox } from '@aesa/mail'
import { enqueue, JOB_NAMES, startBoss } from '@aesa/queue'
import type { WorkerConfig } from '../src/config.ts'
import { mailboxSyncJob, registerMailboxSync } from '../src/jobs/mailbox-sync.ts'
import { enqueueMemoryCapture, registerMemoryCapture } from '../src/jobs/memory-capture.ts'
import { enqueueNotifyDispatch, registerNotifyDispatch } from '../src/jobs/notify-dispatch.ts'
import { registerSendExecute, type SendExecuteDeps } from '../src/jobs/send-execute.ts'
import { enqueueTicketDraft, registerTicketDraft } from '../src/jobs/ticket-draft.ts'
import { registerTicketTriage } from '../src/jobs/ticket-triage.ts'
import { maybeRegisterSendRole } from '../src/send-role.ts'
import type { PushMessage, SendPush } from '../src/push.ts'

const rand = () => randomBytes(4).toString('hex')
const DB_URL = process.env.DATABASE_URL ?? 'postgres://aesa:aesa@localhost:5434/aesa_dev'
const SCHEMA = `pgboss_e2e5_${randomBytes(4).toString('hex')}`
const CUSTOMER_DOMAIN = 'example.test'

/** See the file header, note 4. */
const SEND_CLOCK_SKEW_MS = 16_000

/**
 * A raw trigger, bypassing `enqueue()`'s `${orgId}:${entityId}` key on purpose: `send.execute` ships
 * `policy: 'short'`, whose unique index is over `COALESCE(singleton_key, '')`, so two keyless sends
 * on that queue would collapse into one job while the first is still `created`.
 */
const rawSend = (boss: PgBoss, name: string, data: unknown) =>
  boss.send(name, data as object, { singletonKey: `e2e5-${randomBytes(8).toString('hex')}` })

/** The one question every customer in this file asks, and the one triage extracts from it. */
const QUESTION = 'Where is my order?'
const CUSTOMER_TEXT = 'Where is my order? It was due yesterday.'
/** The `use:` marker's needle — a substring of the stored answer's scrubbed `Q:` line. */
const ANSWER_NEEDLE = 'Where is my order'
/** The sentinel prefix the scenario scripts use in `usedAnswerIds`/`memoryConflictIds` (header, note 1). */
const USE = 'use:'

/** Every triage call in this file resolves to the same plain, non-escalating verdict. */
const BASE_VERDICT = {
  categoryKey: 'order_status',
  language: 'en',
  sentiment: 'neutral' as const,
  isSpam: false,
  isAutomated: false,
  escalationFlags: [] as ('legal_threat' | 'chargeback_threat' | 'injury' | 'recall_mention')[],
  questions: [QUESTION],
}

/**
 * Passes every guardrail screen: no markup, no link, no address, no number, no promise token — and
 * therefore `warningCount: 0`, which an auto-send needs (`decide()`'s `guardrail_warning` gate).
 *
 * It does not open with "Thanks" — which was once load-bearing and no longer is: `scrubForMemory`
 * used to cut from the last sign-off-shaped line in the message's trailing HALF onward, and a
 * one-line reply's only line IS its trailing half, so `e2e-phase3/4`'s own `CLEAN_BODY` ("Thanks for
 * getting in touch. …") scrubbed to the empty string and nothing was learned from it
 * (`memory.skipped`, `empty_after_scrub`). That defect is FIXED (final fix wave): the sign-off cut
 * never removes the first content line, and `packages/knowledge/test/scrub.test.ts` pins that exact
 * body. This body stays as it is because the scenarios' stored `A:` assertions read against it.
 */
const CLEAN_BODY = 'I have checked the details you gave us and everything looks correct on our side.'

/**
 * `confidence: 0.9` is load-bearing, not decoration: `evidence = max(memory, grounding) × model`, so
 * scenario 1's third draft is `(2/3) × 0.9` and scenario 2's fourth is `1 × 0.9 = 0.9`, which is what
 * clears the category's 80% bar.
 */
const REPLY: DraftDecision = {
  outcome: 'reply',
  categoryKey: 'order_status',
  body: CLEAN_BODY,
  confidence: 0.9,
  citedChunkIds: [],
  usedAnswerIds: [],
  memoryConflictIds: [],
  unresolvedQuestions: [],
  customerLanguage: 'en',
  rationale: 'The thread and the answers this business has given before agree on what to say.',
}
const reply = (over: Partial<Extract<DraftDecision, { outcome: 'reply' }>> = {}): DraftDecision => ({ ...REPLY, ...over })

const UUID_IN_BRACKETS = /\[([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\]/

/**
 * The knowledge block's entries, as the MODEL saw them. `knowledgeBlock` renders each retrieved
 * chunk as `[<uuid>] <heading>` and each retrieved past answer as `[<uuid>] Q: …` / `A: …`, so
 * splitting the block on the bracketed uuid yields `[prefix, id1, text1, id2, text2, …]`.
 */
function knowledgeEntries(system: { id: string; text: string }[]): { id: string; text: string }[] {
  const block = system.find((b) => b.id === 'knowledge.retrieved')
  if (!block) return []
  const parts = block.text.split(new RegExp(UUID_IN_BRACKETS.source, 'g'))
  const out: { id: string; text: string }[] = []
  for (let i = 1; i < parts.length; i += 2) out.push({ id: parts[i]!, text: parts[i + 1] ?? '' })
  return out
}

/** vitest's own waitFor, tuned for pg-boss's ~2 s poll cadence with headroom for the longest chain
 *  here (sync → triage → draft → send → memory.capture). */
function waitFor<T>(fn: () => T | Promise<T>): Promise<T> {
  return vi.waitFor(fn, { timeout: 40_000, interval: 200 })
}

/** Never actually reached: every fixture seeds a FRESH access token, so `getAccessToken` returns
 *  straight from the row and the client always comes from `clientFactory`. */
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
}

interface Breakdown {
  evidence: number | null
  threshold: number | null
  memory: { score: number; answerId: string; cosine: number; approvals: number } | null
}

describe('Phase 5 close-out E2E (real pg-boss autonomy + learning jobs, the real api draft/memory services and the real retriever)', () => {
  let t: Awaited<ReturnType<typeof createTestDatabase>>
  let app: ReturnType<typeof createDb>
  let boss: PgBoss
  let service: DraftServiceDeps
  let memoryDeps: MemoryServiceDeps

  /** Every job's logger writes here and nowhere else: scenario 3 asserts on a line
   *  (`send.execute_not_claimable`, logged at `info`) and the suite's output stays pristine. */
  const logLines: string[] = []
  const logger = pino({ level: 'info' }, { write: (line: string) => { logLines.push(line) } })

  const ring: KekRing = loadKekRing({ AESA_KEK_V1: randomBytes(32).toString('base64'), AESA_KEK_ACTIVE: '1' })
  const mailboxesByAddress = new Map<string, MockMailbox>()
  const pushCalls: PushMessage[] = []

  /** ONE embedder, shared by the retriever's answers leg and by `memory.capture` (header). */
  const embedder = createHashEmbedder()

  // ---- the `enqueueSend` seam and its gate (header, notes 2 and 3) ----------

  let sendGate: Promise<void> | null = null
  let releaseSendGate: (() => void) | null = null
  /** Parks every auto-send enqueue until the returned release is called (idempotent). */
  function gateSends(): () => void {
    sendGate = new Promise<void>((resolve) => {
      releaseSendGate = () => { sendGate = null; releaseSendGate = null; resolve() }
    })
    return () => releaseSendGate?.()
  }
  /**
   * A failed assertion between `gateSends()` and its release would leave the seam parked FOREVER:
   * every later scenario's auto-send enqueue awaits that promise, so one real failure turned the
   * remaining scenarios into 240-second timeouts and buried it. Releasing here costs nothing when
   * the scenario already released (the release is idempotent and the gate is per-scenario).
   */
  afterEach(() => { releaseSendGate?.() })

  const enqueueSendSeam = async (orgId: string, sendId: string): Promise<void> => {
    if (sendGate) await sendGate
    // Collapse the agent's hold window for THIS send only — one row, one column.
    await withOrg(app.db, orgId, (tx) =>
      tx.update(outboundSends).set({ sendAfter: new Date() }).where(eq(outboundSends.id, sendId)))
    await rawSend(boss, JOB_NAMES.sendExecute, { orgId, sendId })
  }

  // ---- the model ------------------------------------------------------------

  const draftScripts: FakeScript[] = []
  const fake = createFakeProvider([], { byRole: { triage: [{ parsed: BASE_VERDICT }], draft: draftScripts } })
  let provider: LlmProvider

  /** Rewrites the tail from the CURRENT call index, so each scenario's scripts are consumed by that
   *  scenario's own calls (`createFakeProvider` repeats the last script once a queue is exhausted). */
  function scriptDraft(...scripts: FakeScript[]): void {
    const at = fake.callsFor('draft').length
    draftScripts.length = at
    draftScripts.push(...scripts)
  }
  const draftCallCount = () => fake.callsFor('draft').length

  /** The marker wrapper (header, note 1): the fake answers, then every `use:<needle>` entry in
   *  `usedAnswerIds`/`memoryConflictIds` becomes the id of the retrieved ANSWER whose `Q:` line
   *  carries `<needle>`. Chunk entries are excluded by the `Q:` shape, so an org that also had
   *  knowledge chunks could not accidentally satisfy the needle. */
  function answerMarkingProvider(inner: LlmProvider & { calls: unknown[] }): LlmProvider {
    return {
      ...inner,
      async chat<T>(req: ChatRequest<T>): Promise<ChatResult<T>> {
        const result = await inner.chat(req)
        if (req.meta.role !== 'draft' || result.parsed === null) return result
        const parsed = result.parsed as DraftDecision
        if (parsed.outcome !== 'reply') return result
        const answers = knowledgeEntries(req.system).filter((entry) => /^\s*Q:/.test(entry.text))
        const resolveIds = (ids: string[]): string[] =>
          ids.flatMap((raw) => {
            if (!raw.startsWith(USE)) return [raw]
            const needle = raw.slice(USE.length)
            const hit = answers.find((a) => a.text.includes(needle))
            return hit ? [hit.id] : []
          })
        return {
          ...result,
          parsed: {
            ...parsed,
            usedAnswerIds: resolveIds(parsed.usedAnswerIds),
            memoryConflictIds: resolveIds(parsed.memoryConflictIds),
          } as unknown as T,
        }
      },
    } as LlmProvider
  }

  const push: SendPush = async (msg) => {
    pushCalls.push(msg)
    return { ok: true, invalidTokens: [] }
  }

  function workerConfig(): WorkerConfig {
    return {
      env: 'test',
      databaseUrl: 'unused',
      roles: new Set(['sync', 'agent', 'send']),
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
      voyageApiKey: null,
      knowledgeEmbedModel: 'voyage-4',
      knowledgeRerank: false,
      s3: null,
      platformSender: 'no-reply@aesa.test',
    }
  }

  beforeAll(async () => {
    t = await createTestDatabase()
    app = createDb(t.url)
    boss = await startBoss(DB_URL, SCHEMA)

    provider = withMetering(answerMarkingProvider(fake), createMeterSink(app.db), { cacheTtl: '1h' })
    const limiter = createMailLimiter()
    const clientFactory = (_provider: 'gmail' | 'microsoft', _token: string, addr: string) => mailboxesByAddress.get(addr)!

    // The REAL retriever, built exactly the way `agent-role.ts` builds it: the same db, the same
    // embedder `memory.capture` writes with, no reranker.
    const retriever = createRetriever({ db: app.db, embedder, logger })

    await registerMailboxSync(boss, { db: app.db, ring, config: workerConfig(), limiter, logger, clientFactory })
    await registerTicketTriage(boss, {
      db: app.db, provider, logger,
      enqueueNotify: (orgId, notificationId) => enqueueNotifyDispatch(boss, orgId, notificationId),
      enqueueDraft: (orgId, ticketId) => enqueueTicketDraft(boss, orgId, ticketId),
    })
    await registerTicketDraft(boss, {
      db: app.db, provider, retriever, logger,
      enqueueNotify: (orgId, notificationId) => enqueueNotifyDispatch(boss, orgId, notificationId),
      enqueueDraft: (orgId, ticketId, opts) => enqueueTicketDraft(boss, orgId, ticketId, opts),
      enqueueSend: enqueueSendSeam,
    })
    await registerMemoryCapture(boss, { db: app.db, embedder, logger })
    await registerNotifyDispatch(boss, { db: app.db, push, logger })
    // The production role gate, with only the client/provider/clock seams swapped in through its own
    // `register` argument — `maybeRegisterSendRole`'s ring/OAuth checks still run for real, and the
    // `onSent` seam is wired exactly as `index.ts` wires it.
    await maybeRegisterSendRole(
      {
        boss, db: app.db, config: workerConfig(), limiter, logger,
        enqueueNotify: (orgId, notificationId) => enqueueNotifyDispatch(boss, orgId, notificationId),
        enqueueDraft: (orgId, ticketId) => enqueueTicketDraft(boss, orgId, ticketId),
        onSent: (p) => enqueueMemoryCapture(boss, p.orgId, p.draftId),
      },
      (b, deps: SendExecuteDeps) =>
        registerSendExecute(b, {
          ...deps,
          clientFactory,
          providerFactory: () => stubProvider(),
          now: () => new Date(Date.now() + SEND_CLOCK_SKEW_MS),
        }),
    )

    // Retry CADENCE only (`e2e-phase3.test.ts`'s note 2): the limits, the queue POLICY and every
    // recovery path are the shipped ones; the production 30 s backoff would just make a transient
    // failure cost minutes.
    await boss.updateQueue(JOB_NAMES.ticketDraft, {
      name: JOB_NAMES.ticketDraft, policy: 'short',
      retryLimit: 1, retryDelay: 1, retryBackoff: false, expireInSeconds: INVARIANTS.DRAFT_JOB_EXPIRE_SECONDS,
    })
    await boss.updateQueue(JOB_NAMES.sendExecute, {
      name: JOB_NAMES.sendExecute, policy: 'short',
      retryLimit: 5, retryDelay: 1, retryBackoff: false, expireInSeconds: INVARIANTS.SEND_QUEUE_EXPIRE_SECONDS,
    })

    const api = createApiFacade({ db: app.db, pool: app.pool })
    service = { api, enqueue: createEnqueue(boss), logger }
    memoryDeps = { api, enqueue: createEnqueue(boss), logger }
  }, 120_000)

  afterAll(async () => {
    await boss.stop({ graceful: false, wait: true })
    const admin = new pg.Client({ connectionString: DB_URL })
    await admin.connect()
    await admin.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`)
    await admin.end()
    await app.pool.end()
    await t.drop()
  })

  // ---- fixtures -------------------------------------------------------------

  async function createOrg(): Promise<Org> {
    const domain = 'acme.test'
    const orgId = await createTestOrganization(app)
    const [owner] = await app.db.insert(user).values({ name: 'Owner', email: `owner-${rand()}@example.com` }).returning({ id: user.id })
    await app.db.insert(member).values({ organizationId: orgId, userId: owner!.id, role: 'owner' })
    const selfAddress = `support-${rand()}@${domain}`

    const base = await withOrg(app.db, orgId, async (tx) => {
      await tx.insert(workspaces).values({
        orgId, businessName: 'Acme Dog Supplies', timezone: 'UTC', locale: 'en',
        description: 'Acme sells dog beds, leads and bowls online.',
        allowedUrlHosts: [domain], allowedEmailDomains: [domain],
        operatingGuidance: 'Always confirm the order number before quoting a delivery window.',
        agentEnabled: true,
      })
      await provisionOrgKeys(tx, ring)
      await ensureDefaultCategories(tx)
      const [conn] = await tx.insert(mailboxConnections).values({
        orgId, provider: 'gmail', providerAccountId: `acct-${rand()}`,
        emailAddress: selfAddress, status: 'connected', connectedByUserId: owner!.id,
      }).returning({ id: mailboxConnections.id })
      const [agent] = await tx.insert(agents).values({
        orgId, connectionId: conn!.id, address: selfAddress, domain, displayName: 'Acme Support',
        status: 'active', priority: 0, signature: 'Acme Support',
        guidanceExtra: 'Keep replies to three sentences where you can.',
        autoSendDelayMin: 2,
      }).returning({ id: agents.id })
      await tx.insert(notificationDevices).values({
        orgId, userId: owner!.id, expoPushToken: `ExponentPushToken[${rand()}]`, platform: 'ios',
      })
      const cats = await tx.select({ id: categories.id, key: categories.key }).from(categories)
      // Exactly what `mailboxes.addAddress` seeds when an owner adds an address: one policy row per
      // category, every one in Review.
      await tx.insert(agentCategoryPolicies).values(
        cats.map((c) => ({ orgId, agentId: agent!.id, categoryId: c.id, mode: 'review' })),
      )
      return { connectionId: conn!.id, agentId: agent!.id, categoryId: cats.find((c) => c.key === 'order_status')!.id }
    })

    await seedCredential(orgId, base.connectionId)
    const mailbox = createMockMailbox({ mode: 'gmail', selfAddress })
    mailboxesByAddress.set(selfAddress, mailbox)
    const org: Org = { orgId, ...base, selfAddress, domain, mailbox, ownerUserId: owner!.id }

    // Seed-on-null: the first sync remembers where to start and ingests nothing.
    await triggerSync(org)
    await waitFor(async () => {
      const [row] = await withOrg(app.db, orgId, (tx) => tx.select().from(mailboxConnections).where(eq(mailboxConnections.id, base.connectionId)))
      expect(row!.cursor).not.toBeNull()
    })
    return org
  }

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

  const triggerSync = (org: Org) =>
    enqueue(boss, mailboxSyncJob, { orgId: org.orgId, connectionId: org.connectionId }, { entityId: org.connectionId })

  const actorFor = (org: Org): DraftActor => ({ userId: org.ownerUserId, actor: `user:${org.ownerUserId}`, source: 'app' })
  const memoryActorFor = (org: Org): MemoryActor => ({ userId: org.ownerUserId, actor: `user:${org.ownerUserId}` })

  // ---- reads ----------------------------------------------------------------

  const allDrafts = (org: Org) =>
    withOrg(app.db, org.orgId, (tx) => tx.select().from(drafts).where(eq(drafts.orgId, org.orgId)))
  const draftsForTicket = (org: Org, ticketId: string) =>
    withOrg(app.db, org.orgId, (tx) => tx.select().from(drafts).where(eq(drafts.ticketId, ticketId)).orderBy(drafts.version))
  async function getDraft(org: Org, draftId: string) {
    const [row] = await withOrg(app.db, org.orgId, (tx) => tx.select().from(drafts).where(eq(drafts.id, draftId)))
    return row!
  }
  async function getTicket(org: Org, ticketId: string) {
    const [row] = await withOrg(app.db, org.orgId, (tx) => tx.select().from(tickets).where(eq(tickets.id, ticketId)))
    return row!
  }
  async function sendFor(org: Org, draftId: string) {
    const [row] = await withOrg(app.db, org.orgId, (tx) => tx.select().from(outboundSends).where(eq(outboundSends.draftId, draftId)))
    return row!
  }
  const answersFor = (org: Org) =>
    withOrg(app.db, org.orgId, (tx) =>
      tx.select().from(resolvedAnswers).where(eq(resolvedAnswers.orgId, org.orgId)).orderBy(resolvedAnswers.createdAt))
  async function getAnswer(org: Org, answerId: string) {
    const [row] = await withOrg(app.db, org.orgId, (tx) => tx.select().from(resolvedAnswers).where(eq(resolvedAnswers.id, answerId)))
    return row!
  }
  async function policyFor(org: Org) {
    const [row] = await withOrg(app.db, org.orgId, (tx) =>
      tx.select().from(agentCategoryPolicies)
        .where(and(eq(agentCategoryPolicies.agentId, org.agentId), eq(agentCategoryPolicies.categoryId, org.categoryId))))
    return row!
  }
  const notificationsFor = (org: Org) =>
    withOrg(app.db, org.orgId, (tx) => tx.select().from(notifications).where(eq(notifications.orgId, org.orgId)))
  const auditRowsFor = (org: Org, entityId: string, action: string) =>
    withOrg(app.db, org.orgId, (tx) =>
      tx.select().from(auditLog).where(and(eq(auditLog.entityId, entityId), eq(auditLog.action, action))))
  async function metersFor(org: Org): Promise<Record<string, number>> {
    const rows = await withOrg(app.db, org.orgId, (tx) => tx.select().from(usageCounters).where(eq(usageCounters.orgId, org.orgId)))
    const out: Record<string, number> = {}
    for (const r of rows) out[r.meter] = (out[r.meter] ?? 0) + r.value
    return out
  }
  const breakdownOf = (draft: { confidenceBreakdown: unknown }): Breakdown => draft.confidenceBreakdown as Breakdown

  // ---- arrangement helpers --------------------------------------------------

  /** Inbound → the real sync walk → `ticket.triage` → `ticket.draft`, waiting for a NEW draft row of
   *  ANY status: an auto landing writes an `approved` draft, not a `pending` one. */
  async function inboundToDraft(org: Org, opts: { from: string; subject: string; body?: string; authenticationResults?: string }) {
    const before = new Set((await allDrafts(org)).map((r) => r.id))
    org.mailbox.receiveInbound({
      from: opts.from, to: [org.selfAddress], subject: opts.subject,
      bodyText: opts.body ?? CUSTOMER_TEXT,
      ...(opts.authenticationResults ? { authenticationResults: opts.authenticationResults } : {}),
    })
    await triggerSync(org)
    return waitFor(async () => {
      const fresh = (await allDrafts(org)).filter((r) => !before.has(r.id))
      expect(fresh).toHaveLength(1)
      return fresh[0]!
    })
  }

  /** Inbound → the real sync walk, waiting for the NEW ticket alone (the tripwire path never drafts). */
  async function inboundToTicket(org: Org, opts: { from: string; subject: string; body: string }): Promise<string> {
    const before = new Set((await withOrg(app.db, org.orgId, (tx) => tx.select({ id: tickets.id }).from(tickets))).map((r) => r.id))
    org.mailbox.receiveInbound({ from: opts.from, to: [org.selfAddress], subject: opts.subject, bodyText: opts.body })
    await triggerSync(org)
    return waitFor(async () => {
      const rows = await withOrg(app.db, org.orgId, (tx) => tx.select().from(tickets))
      const fresh = rows.filter((r) => !before.has(r.id))
      expect(fresh).toHaveLength(1)
      expect(fresh[0]!.status).not.toBe('new')
      return fresh[0]!.id
    })
  }

  /** Marks viewed, approves through the real gate, triggers the ledger row's `send.execute` (header,
   *  note 4) and waits for the delivery to land. */
  async function approveAndSend(org: Org, draftId: string): Promise<string> {
    expect(await markViewed(service, org.orgId, draftId, actorFor(org))).toBe(true)
    const approved = await approveDraft(service, org.orgId, { draftId }, actorFor(org))
    expect(approved.ok).toBe(true)
    const sendId = (approved as { ok: true; sendId: string }).sendId
    await rawSend(boss, JOB_NAMES.sendExecute, { orgId: org.orgId, sendId })
    await waitFor(async () => {
      expect((await sendFor(org, draftId)).status).toBe('sent')
    })
    return sendId
  }

  /** Seven more owner-decided drafts on this agent+category, so `countHumanDecisions` reaches the
   *  cold-start floor of 10. They ride scenario 1's own ticket — `sent` is outside the one-live-draft
   *  partial unique, so a ticket may carry any number of them. */
  async function seedHumanDecisions(org: Org, ticketId: string, n: number): Promise<void> {
    const now = new Date()
    await withOrg(app.db, org.orgId, (tx) =>
      tx.insert(drafts).values(
        Array.from({ length: n }, (_unused, i) => ({
          orgId: org.orgId, ticketId, agentId: org.agentId, categoryId: org.categoryId,
          version: 100 + i, body: CLEAN_BODY, finalBody: CLEAN_BODY,
          confidence: 0.9, modelConfidence: 0.9,
          decision: 'review', decisionReason: 'category_review', status: 'sent',
          threadSnapshotAt: now, expiresAt: new Date(now.getTime() + 30 * 86_400_000),
          decidedBy: org.ownerUserId, decidedAt: now, decisionSource: 'app', editDistanceRatio: 0,
        })),
      ))
  }

  async function setPolicy(org: Org, patch: Partial<typeof agentCategoryPolicies.$inferInsert>): Promise<void> {
    await withOrg(app.db, org.orgId, (tx) =>
      tx.update(agentCategoryPolicies).set(patch)
        .where(and(eq(agentCategoryPolicies.agentId, org.agentId), eq(agentCategoryPolicies.categoryId, org.categoryId))))
  }

  /** The knowledge block of the draft call at `index`, as the model saw it. */
  function knowledgeBlockOf(index: number): string {
    const call = fake.callsFor('draft')[index]!
    return call.system.find((b) => b.id === 'knowledge.retrieved')!.text
  }

  // ---- shared state across the scenarios ------------------------------------

  let org: Org
  let customer1: string
  /** Scenario 1's answer: the one three approvals teach. */
  let mainAnswerId: string
  /** Scenario 1's first ticket, which scenario 2 hangs its seeded decisions on. */
  let firstTicketId: string
  /** Scenario 2's auto-sent reply and the unsampled candidate it produced. */
  let autoDraftId: string
  let candidateAnswerId: string

  // ---- 1: three approvals teach ONE answer -----------------------------------

  it('1. three customers ask the same question and three plain approvals teach ONE resolved answer: approvals 1 → 3, reuse_count 2, and the memory score it lends the next draft rises 0 → 1/3 → 2/3', async () => {
    org = await createOrg()
    customer1 = `customer-one-${rand()}@${CUSTOMER_DOMAIN}`
    const customers = [customer1, `customer-two-${rand()}@${CUSTOMER_DOMAIN}`, `customer-three-${rand()}@${CUSTOMER_DOMAIN}`]

    // --- the first: nothing has been learned yet, so nothing is retrieved and nothing is reused.
    scriptDraft({ parsed: reply() })
    const firstCall = draftCallCount()
    const first = await inboundToDraft(org, { from: customers[0]!, subject: QUESTION })
    firstTicketId = first.ticketId
    expect(first.status).toBe('pending')
    expect(first.decision).toBe('review')
    expect(first.decisionReason).toBe('category_review')
    expect(first.retrievedAnswerIds).toEqual([])
    expect(first.usedAnswerIds).toEqual([])
    expect(breakdownOf(first).memory).toBeNull()
    expect(breakdownOf(first).evidence).toBe(0)
    expect(breakdownOf(first).threshold).toBeNull()     // only an `auto` category has a bar at all
    expect(knowledgeBlockOf(firstCall)).not.toContain('Answers this business has given before')

    await approveAndSend(org, first.id)

    const [answer] = await waitFor(async () => {
      const rows = await answersFor(org)
      expect(rows).toHaveLength(1)
      return rows
    })
    mainAnswerId = answer!.id
    expect(answer!.status).toBe('active')
    expect(answer!.approvals).toBe(1)
    expect(answer!.reuseCount).toBe(0)
    expect(answer!.strikes).toBe(0)
    expect(answer!.wasEdited).toBe(false)
    expect(answer!.agentId).toBe(org.agentId)
    expect(answer!.categoryId).toBe(org.categoryId)
    expect(answer!.sourceDraftId).toBe(first.id)
    expect(answer!.sourceTicketId).toBe(first.ticketId)
    expect(answer!.embeddingModel).toBe('hash-v1')
    expect(answer!.questionEmbedding).not.toBeNull()
    // Stored SCRUBBED (`scrubForMemory`, unit-tested in `packages/knowledge/test/scrub.test.ts`):
    // the triage question and the approved body, with no address and no greeting anywhere in them.
    expect(answer!.questionText).toBe(QUESTION)
    expect(answer!.answerBody).toBe(CLEAN_BODY)
    expect(answer!.questionText).not.toContain('@')
    expect(answer!.answerBody).not.toContain('@')
    expect(answer!.questionText.toLowerCase().startsWith('hi')).toBe(false)
    // The customer is a salted hash on the row, never the address — this is what scenario 8 erases by.
    expect(answer!.sourceCustomerHash).toMatch(/^[0-9a-f]{64}$/)
    expect(answer!.sourceCustomerHash).not.toContain(customer1)
    // 365 days from the decision that set it; a reinforcing approval re-sets it from ITS own clock,
    // so the third approval below can only move it forward (asserted there).
    const capturedExpiry = answer!.expiresAt.getTime()

    // --- the second and the third: the answer is retrieved, reused, and reinforced.
    for (const round of [1, 2] as const) {
      scriptDraft({ parsed: reply({ usedAnswerIds: [`${USE}${ANSWER_NEEDLE}`] }) })
      const at = draftCallCount()
      const draft = await inboundToDraft(org, { from: customers[round]!, subject: `${QUESTION} (${round})` })

      // Still ONE row: a reuse reinforces, it never inserts.
      expect(await answersFor(org)).toHaveLength(1)
      expect(draft.retrievedAnswerIds).toEqual([mainAnswerId])
      expect(draft.usedAnswerIds).toEqual([mainAnswerId])
      // The model really saw it: the request's own knowledge block carries the `[id] Q:` line.
      expect(knowledgeBlockOf(at)).toContain(`[${mainAnswerId}] Q: ${QUESTION}`)
      expect(knowledgeBlockOf(at)).toContain(`A: ${CLEAN_BODY}`)

      // `memoryScore(cosine, approvals)` = band(≈1.0) × min(approvals, 3)/3, at the approvals the
      // answer carried WHEN THE PROMPT WAS BUILT: 1/3 on the second, 2/3 on the third.
      const memory = breakdownOf(draft).memory!
      expect(memory.answerId).toBe(mainAnswerId)
      expect(memory.approvals).toBe(round)
      expect(memory.cosine).toBeGreaterThan(0.99)
      expect(memory.score).toBeCloseTo(round / 3, 10)
      expect(breakdownOf(draft).evidence).toBeCloseTo((round / 3) * 0.9, 10)
      // A `review` category has no threshold, so nothing could auto-send here whatever the evidence.
      expect(breakdownOf(draft).threshold).toBeNull()
      expect(draft.status).toBe('pending')

      await approveAndSend(org, draft.id)
      await waitFor(async () => {
        expect((await getAnswer(org, mainAnswerId)).approvals).toBe(round + 1)
      })
    }

    const taught = await getAnswer(org, mainAnswerId)
    expect(taught.status).toBe('active')
    expect(taught.approvals).toBe(3)
    expect(taught.reuseCount).toBe(2)
    expect(taught.expiresAt.getTime()).toBeGreaterThanOrEqual(capturedExpiry)
    // …and still a year out, not two: every write is `now + 365 d`, never an accumulation.
    expect(taught.expiresAt.getTime()).toBeLessThan(Date.now() + 366 * 86_400_000)
    expect(await answersFor(org)).toHaveLength(1)

    // Three owner-reviewed sends, no auto-sends.
    const meters = await metersFor(org)
    expect(meters[SEND_METERS.reviewSends]).toBe(3)
    expect(meters[SEND_METERS.autoSends]).toBeUndefined()
  }, 240_000)

  // ---- 2: the fourth auto-sends once the category is Auto ---------------------

  it('2. with ten human decisions behind it and the category on Auto at 80%, the fourth identical question lands approved/decision send/decision_source auto, waits on auto_sending, goes out marked and signed, meters auto_sends, and becomes an UNSAMPLED candidate', async () => {
    // The cold-start floor is ten HUMAN decisions for this agent+category; scenario 1 made three.
    await seedHumanDecisions(org, firstTicketId, 7)
    const decisions = await withOrg(app.db, org.orgId, (tx) => countHumanDecisions(tx, org.agentId, org.categoryId))
    expect(decisions).toBe(10)

    await setPolicy(org, { mode: 'auto', autoSendMinConfidence: 80, graduatedAt: new Date() })

    const release = gateSends()
    const customer4 = `customer-four-${rand()}@${CUSTOMER_DOMAIN}`
    scriptDraft({ parsed: reply({ usedAnswerIds: [`${USE}${ANSWER_NEEDLE}`] }) })
    const draft = await inboundToDraft(org, { from: customer4, subject: `${QUESTION} (4)` })
    autoDraftId = draft.id

    // The landing itself: an APPROVED draft nobody looked at, beside a `queued` send, on a ticket
    // parked in the hold window.
    expect(draft.status).toBe('approved')
    expect(draft.decision).toBe('send')
    expect(draft.decisionReason).toBe('ok')
    expect(draft.decisionSource).toBe('auto')
    expect(draft.decidedBy).toBeNull()
    expect(draft.viewedAt).toBeNull()
    expect(draft.autoDecidedAt).not.toBeNull()
    expect(draft.finalBody).toBe(CLEAN_BODY)
    expect(draft.usedAnswerIds).toEqual([mainAnswerId])
    // memory = band(≈1.0) × min(3,3)/3 = 1; evidence = max(1, grounding 0) × 0.9 = 0.9 ≥ 0.80.
    expect(breakdownOf(draft).memory!.score).toBeCloseTo(1, 10)
    expect(breakdownOf(draft).evidence).toBeCloseTo(0.9, 10)
    expect(breakdownOf(draft).threshold).toBeCloseTo(0.8, 10)

    expect((await getTicket(org, draft.ticketId)).status).toBe('auto_sending')
    const queued = await sendFor(org, draft.id)
    expect(queued.status).toBe('queued')
    expect(queued.agentId).toBe(org.agentId)
    // The hold window is the agent's own two minutes (collapsed by the seam only once released).
    expect(queued.sendAfter.getTime()).toBeGreaterThan(Date.now() + 60_000)
    // `push_auto_sends` is off by default, so the owner gets no page for a reply they trust.
    expect((await notificationsFor(org)).filter((n) => n.kind === 'auto_send')).toHaveLength(0)

    release()

    const sent = await waitFor(async () => {
      const row = await sendFor(org, draft.id)
      expect(row.status).toBe('sent')
      return row
    })
    const delivered = org.mailbox.sentMessages().find((m) => m.markerDraftId === draft.id)!
    expect(delivered).toBeDefined()
    expect(delivered.bodyText.endsWith('\n\nAcme Support')).toBe(true)
    expect(Buffer.from(delivered.raw!, 'base64url').toString()).toContain(`${MARKER_HEADER}: ${draft.id}`)
    expect(sent.providerMessageId).toBeTruthy()

    expect((await getDraft(org, draft.id)).status).toBe('sent')
    expect((await getTicket(org, draft.ticketId)).status).toBe('waiting_on_customer')

    const meters = await metersFor(org)
    expect(meters[SEND_METERS.autoSends]).toBe(1)
    expect(meters[SEND_METERS.reviewSends]).toBe(3)   // unchanged: an auto-send is billed separately

    // `memory.capture` on an auto-send inserts a CANDIDATE — never retrieved until a human samples it.
    const candidate = await waitFor(async () => {
      const rows = await answersFor(org)
      expect(rows).toHaveLength(2)
      const fresh = rows.find((r) => r.sourceDraftId === draft.id)
      expect(fresh).toBeDefined()
      return fresh!
    })
    candidateAnswerId = candidate.id
    expect(candidate.status).toBe('candidate')
    expect(candidate.approvals).toBe(0)
    expect(candidate.lastApprovedAt).toBeNull()
    expect(candidate.questionText).toBe(QUESTION)
    // The reuse did NOT reinforce the active answer: an auto-send is not a human approval.
    expect((await getAnswer(org, mainAnswerId)).approvals).toBe(3)
  }, 240_000)

  // ---- 3: Hold cancels -------------------------------------------------------

  it('3. Hold inside the window cancels an auto-send: the ledger row goes held, the draft comes back to pending with auto_held_at, the ticket returns to awaiting_review, and send.execute then finds nothing claimable', async () => {
    const sentBefore = org.mailbox.sentMessages().length
    const release = gateSends()

    scriptDraft({ parsed: reply({ usedAnswerIds: [`${USE}${ANSWER_NEEDLE}`] }) })
    const draft = await inboundToDraft(org, { from: `customer-five-${rand()}@${CUSTOMER_DOMAIN}`, subject: `${QUESTION} (5)` })
    expect(draft.status).toBe('approved')
    expect(draft.decisionSource).toBe('auto')
    expect((await getTicket(org, draft.ticketId)).status).toBe('auto_sending')
    const sendId = (await sendFor(org, draft.id)).id

    // The owner pulls it back BEFORE anything could have claimed it — the seam is still parked.
    expect(await holdDraft(service, org.orgId, draft.id, actorFor(org))).toEqual({ ok: true })

    const held = await sendFor(org, draft.id)
    expect(held.status).toBe('held')
    const pulled = await getDraft(org, draft.id)
    expect(pulled.status).toBe('pending')
    expect(pulled.autoHeldAt).not.toBeNull()
    expect(pulled.autoDecidedAt).not.toBeNull()      // the durable "this was an auto-send" mark survives
    expect((await getTicket(org, draft.ticketId)).status).toBe('awaiting_review')
    expect(await auditRowsFor(org, draft.id, 'draft.held')).toHaveLength(1)

    // Now let the send through: it has nothing to claim, says so, and completes successfully.
    release()
    await waitFor(() => {
      expect(logLines.some((line) => line.includes('send.execute_not_claimable') && line.includes(sendId))).toBe(true)
    })
    expect((await sendFor(org, draft.id)).status).toBe('held')
    expect((await sendFor(org, draft.id)).attempts).toBe(0)
    expect(org.mailbox.sentMessages()).toHaveLength(sentBefore)
    expect((await metersFor(org))[SEND_METERS.autoSends]).toBe(1)
  }, 240_000)

  // ---- 4: candidates stay out of the prompt until sampled ---------------------

  it('4. the unsampled candidate is invisible to retrieval — the sixth request carries the ACTIVE answer and not the candidate; confirmCandidate makes it active with one approval and the seventh request carries both', async () => {
    expect((await getAnswer(org, candidateAnswerId)).status).toBe('candidate')

    scriptDraft({ parsed: reply() })
    const sixthCall = draftCallCount()
    const sixth = await inboundToDraft(org, { from: `customer-six-${rand()}@${CUSTOMER_DOMAIN}`, subject: `${QUESTION} (6)` })
    expect(knowledgeBlockOf(sixthCall)).toContain(`[${mainAnswerId}]`)
    expect(knowledgeBlockOf(sixthCall)).not.toContain(`[${candidateAnswerId}]`)
    expect(sixth.retrievedAnswerIds).toEqual([mainAnswerId])
    // With no answer USED, the evidence is 0 — so an Auto category still routes this one to review.
    expect(sixth.status).toBe('pending')
    expect(sixth.decisionReason).toBe('below_threshold')

    expect(await confirmCandidate(memoryDeps, org.orgId, candidateAnswerId, memoryActorFor(org))).toEqual({ ok: true })
    const confirmed = await getAnswer(org, candidateAnswerId)
    expect(confirmed.status).toBe('active')
    expect(confirmed.approvals).toBe(1)
    expect(confirmed.lastApprovedAt).not.toBeNull()
    expect(await auditRowsFor(org, candidateAnswerId, 'memory.confirmed')).toHaveLength(1)

    scriptDraft({ parsed: reply() })
    const seventhCall = draftCallCount()
    const seventh = await inboundToDraft(org, { from: `customer-seven-${rand()}@${CUSTOMER_DOMAIN}`, subject: `${QUESTION} (7)` })
    expect(knowledgeBlockOf(seventhCall)).toContain(`[${mainAnswerId}]`)
    expect(knowledgeBlockOf(seventhCall)).toContain(`[${candidateAnswerId}]`)
    expect([...seventh.retrievedAnswerIds].sort()).toEqual([mainAnswerId, candidateAnswerId].sort())
  }, 240_000)

  // ---- 5: a contradiction parks the answer -----------------------------------

  it('5. a draft that flags a retrieved answer as contradicting the guidance parks that answer at needs_review/model_conflict and lands itself in awaiting_review with decision_reason memory_conflict, even though the category is on Auto', async () => {
    expect((await policyFor(org)).mode).toBe('auto')

    scriptDraft({ parsed: reply({ memoryConflictIds: [`${USE}${ANSWER_NEEDLE}`] }) })
    const draft = await inboundToDraft(org, { from: `customer-eight-${rand()}@${CUSTOMER_DOMAIN}`, subject: `${QUESTION} (8)` })

    expect(draft.status).toBe('pending')
    expect(draft.decision).toBe('review')
    expect(draft.decisionReason).toBe('memory_conflict')
    expect((await getTicket(org, draft.ticketId)).status).toBe('awaiting_review')
    expect(breakdownOf(draft).threshold).toBeCloseTo(0.8, 10)   // Auto's bar was there; the blocker won
    expect(draft.memoryConflictIds).toHaveLength(1)

    // The conflicted answer — the one the model actually named, read back off the row — is parked for
    // the owner's Verify list; nothing else is touched.
    const conflictedId = draft.memoryConflictIds[0]!
    expect([mainAnswerId, candidateAnswerId]).toContain(conflictedId)
    const parked = await getAnswer(org, conflictedId)
    expect(parked.status).toBe('needs_review')
    expect(parked.reviewReason).toBe('model_conflict')
    const others = (await answersFor(org)).filter((a) => a.id !== conflictedId)
    expect(others).toHaveLength(1)
    expect(others[0]!.status).toBe('active')
  }, 240_000)

  // ---- 6: two rejects in Auto demote the category ----------------------------

  it('6. two rejections of the same category inside a day take it off Autopilot — mode review, demoted_reason rejections, ONE demotion notification — and the answers those drafts reused carry a strike each, retiring at the second', async () => {
    const activeBefore = (await answersFor(org)).filter((a) => a.status === 'active')
    expect(activeBefore).toHaveLength(1)
    const reusedId = activeBefore[0]!.id
    expect(activeBefore[0]!.strikes).toBe(0)

    const rejectable: string[] = []
    for (const round of [1, 2] as const) {
      // `unresolved_questions` is a Phase-5 blocker: it routes an Auto category's draft to review
      // WITHOUT clearing `usedAnswerIds`, which is what makes the reject below a memory signal.
      scriptDraft({ parsed: reply({ usedAnswerIds: [`${USE}${ANSWER_NEEDLE}`], unresolvedQuestions: ['Which courier has it?'] }) })
      const draft = await inboundToDraft(org, { from: `customer-reject-${round}-${rand()}@${CUSTOMER_DOMAIN}`, subject: `${QUESTION} (reject ${round})` })
      expect(draft.status).toBe('pending')
      expect(draft.decisionReason).toBe('unresolved_questions')
      expect(draft.usedAnswerIds).toEqual([reusedId])
      rejectable.push(draft.id)
    }

    // Reject one: one strike, no demotion yet (the rule is two inside seven days).
    expect(await rejectDraft(service, org.orgId, { draftId: rejectable[0]!, action: 'handle', reason: 'wrong', addToGuidance: false }, actorFor(org)))
      .toEqual({ ok: true, resolution: 'escalate_terminal', guidanceAdded: false })
    expect((await policyFor(org)).mode).toBe('auto')
    const onceStruck = await getAnswer(org, reusedId)
    expect(onceStruck.strikes).toBe(1)
    expect(onceStruck.status).toBe('active')
    expect((await notificationsFor(org)).filter((n) => n.kind === 'demotion')).toHaveLength(0)

    // Reject two: the category comes off Autopilot, inline, in the rejecting transaction.
    expect(await rejectDraft(service, org.orgId, { draftId: rejectable[1]!, action: 'handle', reason: 'wrong', addToGuidance: false }, actorFor(org)))
      .toEqual({ ok: true, resolution: 'escalate_terminal', guidanceAdded: false })
    const policy = await policyFor(org)
    expect(policy.mode).toBe('review')
    expect(policy.demotedReason).toBe('rejections')
    expect(policy.demotedAt).not.toBeNull()
    const demotions = (await notificationsFor(org)).filter((n) => n.kind === 'demotion')
    expect(demotions).toHaveLength(1)
    expect(demotions[0]!.title).toMatch(/^Autopilot paused for /)
    expect(await auditRowsFor(org, org.agentId, 'autonomy.demoted')).toHaveLength(1)

    // Two strikes is the retirement ceiling: the answer both rejected drafts leant on is retired.
    const twiceStruck = await getAnswer(org, reusedId)
    expect(twiceStruck.strikes).toBe(2)
    expect(twiceStruck.status).toBe('retired')
    expect(twiceStruck.retiredReason).toBe('strikes')
  }, 240_000)

  // ---- 7: the deterministic floors still win in Auto --------------------------

  it('7. back on Autopilot, a tripwire phrase still parks the ticket at needs_owner/tripwire with no draft at all, and an inbound that fails DMARC still lands its draft in awaiting_review with decision_reason dmarc_fail — neither is auto-sent', async () => {
    await setPolicy(org, { mode: 'auto', autoSendMinConfidence: 80, graduatedAt: new Date(), demotedAt: null, demotedReason: null })
    const sentBefore = org.mailbox.sentMessages().length
    const callsBefore = draftCallCount()

    // (a) the tripwire, evaluated at ingest before any model runs.
    const trippedTicketId = await inboundToTicket(org, {
      from: `customer-tripwire-${rand()}@${CUSTOMER_DOMAIN}`,
      subject: 'Order dispute',
      body: 'I am filing a chargeback with my bank today unless this is fixed.',
    })
    const tripped = await getTicket(org, trippedTicketId)
    expect(tripped.status).toBe('needs_owner')
    expect(tripped.needsOwnerReason).toBe('tripwire')
    expect(await draftsForTicket(org, trippedTicketId)).toHaveLength(0)
    expect(draftCallCount()).toBe(callsBefore)   // no model call at all for a tripwired ticket

    // (b) DMARC. `decide()` screens it before it ever looks at the category's mode.
    scriptDraft({ parsed: reply() })
    const spoofed = await inboundToDraft(org, {
      from: `customer-spoof-${rand()}@${CUSTOMER_DOMAIN}`,
      subject: `${QUESTION} (spoofed)`,
      authenticationResults: 'mock; dmarc=fail',
    })
    expect(spoofed.status).toBe('pending')
    expect(spoofed.decision).toBe('review')
    expect(spoofed.decisionReason).toBe('dmarc_fail')
    expect((await getTicket(org, spoofed.ticketId)).status).toBe('awaiting_review')
    expect((breakdownOf(spoofed) as unknown as { blockers: { dmarcFail: boolean } }).blockers.dmarcFail).toBe(true)

    // Nothing went out for either, and the auto-send meter is still scenario 2's single reply.
    expect(org.mailbox.sentMessages()).toHaveLength(sentBefore)
    expect((await metersFor(org))[SEND_METERS.autoSends]).toBe(1)
  }, 240_000)

  // ---- 8: delete-by-customer -------------------------------------------------

  it('8. delete-by-customer erases exactly the answers learned from that one customer, leaves every other answer standing, and audits a COUNT rather than the address', async () => {
    const before = await answersFor(org)
    expect(before.length).toBeGreaterThanOrEqual(2)
    expect(before.map((a) => a.id)).toContain(mainAnswerId)

    const result = await deleteByCustomer(memoryDeps, org.orgId, customer1, memoryActorFor(org))
    expect(result.deleted).toBeGreaterThanOrEqual(1)
    expect(result.deleted).toBe(1)

    const after = await answersFor(org)
    expect(after).toHaveLength(before.length - 1)
    expect(after.map((a) => a.id)).not.toContain(mainAnswerId)
    // Everything learned from a DIFFERENT customer is untouched.
    expect(after.map((a) => a.id)).toContain(candidateAnswerId)

    const audits = await auditRowsFor(org, org.orgId, 'memory.deleted_by_customer')
    expect(audits).toHaveLength(1)
    expect(audits[0]!.detail).toEqual({ count: 1 })
    expect(JSON.stringify(audits[0]!.detail)).not.toContain(customer1)

    // A second pass finds nothing left to forget, and says so.
    expect(await deleteByCustomer(memoryDeps, org.orgId, customer1, memoryActorFor(org))).toEqual({ deleted: 0 })
    expect(await answersFor(org)).toHaveLength(after.length)

    // The file's own closing ledger: four owner-reviewed sends and exactly ONE auto-send, the
    // auto-sent draft stamped captured (so a redelivery of `memory.capture` is a no-op), and every
    // escalation of this run really reached the push dispatcher.
    expect((await getDraft(org, autoDraftId)).memoryCapturedAt).not.toBeNull()
    const meters = await metersFor(org)
    expect(meters[SEND_METERS.reviewSends]).toBe(3)
    expect(meters[SEND_METERS.autoSends]).toBe(1)
    expect(pushCalls.length).toBeGreaterThan(0)
  }, 240_000)
})
