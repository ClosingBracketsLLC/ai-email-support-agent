/**
 * Phase 6 close-out: provider choice driven end to end — the REAL api service (`@aesa/api/llm`'s
 * `addCredential` / `probeCredential` / `setAgentModel` / `removeCredential`, wired to
 * `createApiFacade`/`createEnqueue` from `@aesa/api/deps`), the REAL `llm.probe` job, the REAL
 * `createProviderResolver`, and the REAL `ticket.triage` / `ticket.draft` jobs calling a REAL
 * `createByokProvider` — whose only stub is the socket: `test/helpers/mock-openai.ts` is a
 * `fetch`-shaped OpenAI-compatible server, so the adapter, the structured-output ladder and the
 * metering wrapper above it are all the shipped ones.
 *
 * The unit suites — `provider-resolver.test.ts`, `llm-probe.test.ts`, `ticket-draft.test.ts`,
 * `ticket-triage.test.ts`, `packages/llm/test/{openai-compatible,structured,probe}.test.ts` and
 * `apps/api/test/llm-{service,router}.test.ts` — own the branch-by-branch rules. This file exists to
 * prove the WIRING between them: an owner's pasted key really reaches the worker sealed, the probe
 * really writes what the endpoint can do, the resolver really builds a provider from that verdict,
 * the ladder really lands on the rung the probe found, the quality cap really holds Autopilot back,
 * a rejected key really goes dead and stops the next ticket before it spends anything, and
 * disconnecting really puts every agent back on Managed AI.
 *
 * Shape ported from `e2e-phase5.test.ts`: one throwaway database (`createTestDatabase`), one
 * pg-boss instance on the shared dev `DATABASE_URL` under a schema unique to THIS run
 * (`pgboss_e2e6_<hex>`, dropped in `afterAll`), `createMockMailbox` plugged into `mailbox.sync` and
 * `send.execute` through their `clientFactory` seams, and `waitFor` polling the database with NO
 * wall-clock sleeps anywhere.
 *
 * FIVE harness-level seams, all arrangement rather than assertion:
 *
 *  1. **The managed provider is a `createFakeProvider`** wrapped in the real
 *     `withMetering`/`createMeterSink` pair — the platform has no `ANTHROPIC_API_KEY` here. It is
 *     what `fallback_to_managed` falls back TO (scenario 5) and nothing else ever reaches it, which
 *     is exactly what the `llm_cost_micros` / `llm_cost_micros_byok` split is asserted on.
 *  2. **The BYOK side is entirely real**, down to `createByokProvider`; only `fetchFn` is the mock.
 *     The SSRF-pinned transport the resolver would otherwise build is bypassed HERE ALONE, and it is
 *     unit-tested in `@aesa/crypto`. The mock 404s any base URL it was not told to serve, so a
 *     credential whose validated base URL never reached the adapter fails its probe — which is how
 *     the URL plumbing is asserted through the database rather than through the mock's records.
 *  3. **`llm.probe`'s enqueue is deferrable** (`holdProbes()`): `addCredential` enqueues the sealed
 *     key as the LAST statement of its own transaction, and the WORKER is what stores it — so
 *     without holding that ONE send back there is no way to observe either the pre-probe row
 *     (`unknown`, with no secret row anywhere) or the sealed blob the api handed over. The held
 *     payload is the api's own, sent verbatim a moment later — the job that runs is the real one.
 *     It is a deferral, never a block: nothing is awaited inside a `withOrg` transaction.
 *  4. **`ticket.triage`'s hand-off to `ticket.draft` is gateable** (`gateDrafts()`). Triage calls it
 *     POST-COMMIT, so parking it leaves the ticket committed on `triaged` and lets a scenario change
 *     what the endpoint does between the triage call and the draft call — which is what makes
 *     scenario 4's dead key a DRAFT-time refusal (triage's own retry policy is a different job's
 *     rule, unit-tested in `ticket-triage.test.ts`) and scenario 3's refusal rung reachable at all.
 *  5. **The retriever is a stub** (`stubChunks`), because this file is about providers, not
 *     retrieval: `e2e-phase4.test.ts` owns the real one. Scenario 6 needs ONE grounded citation
 *     scoring 0.9 and nothing else, so the stub hands back exactly that when a scenario asks for it.
 *
 * TWO things about the capability model this file leans on, both spec rules (§LLM provider adapter,
 * "presets are overridden by the stored probe result") and both worth stating because a reader will
 * otherwise expect the preset to decide:
 *
 *  - **The PRESET never decides which rung a BYOK credential runs.** An unlisted model on a `custom`
 *    endpoint seeds as json_mode-only, but that seed is a guess about someone else's server, so
 *    `probeProvider` attempts `native` anyway on every OpenAI-compatible kind and stores what the
 *    endpoint actually did; `createByokProvider` then applies that verdict in BOTH directions. That
 *    is why scenario 1's `custom` credential lands `structured: 'native'` and scenario 2's draft
 *    runs the native rung on a model no catalog has ever heard of.
 *  - **The quality TIER is a different question, and the rung does not move it.** A tier is
 *    `limited` exactly when the model is absent from its provider's `suggestedModels`
 *    (`qualityTierFor`), and only a probe verdict of `none` downgrades it further. So scenario 2 is
 *    `limited` (cap 0.6) while running the native rung, and scenario 6 is what that cap costs.
 */
import { randomBytes } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import pg from 'pg'
import type PgBoss from 'pg-boss'
import pino from 'pino'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { DraftDecision, RetrievedChunk, Retriever } from '@aesa/agent'
import { createApiFacade, createEnqueue, type EnqueueFn } from '@aesa/api/deps'
import {
  addCredential, probeCredential, removeCredential, setAgentModel,
  type LlmActor, type LlmServiceDeps,
} from '@aesa/api/llm'
import { INVARIANTS, QUALITY_CAPS } from '@aesa/core'
import { MANAGED_MODELS, PROVIDER_PRESETS, type AddCredentialInput } from '@aesa/contracts'
import { encrypt, hashToken, loadKekRing, Secret, type KekRing, type Resolver } from '@aesa/crypto'
import {
  agentCategoryPolicies, agentModelConfig, agentRunEvents, agentRuns, agents, auditLog, categories,
  createMeterSink, drafts, ensureDefaultCategories, llmCalls, llmCredentials, llmCredentialSecrets,
  LLM_METERS, loadOrgDek, mailboxConnections, mailboxCredentials, member, notificationDevices,
  notifications, outboundSends, provisionOrgKeys, resolveModelConfig, tickets, usageCounters, user,
  withOrg, withPlatform, workspaces,
} from '@aesa/db'
import { createDb } from '@aesa/db/raw'
import { createTestDatabase, createTestOrganization } from '@aesa/db/testing'
import { createFakeProvider, withMetering, type LlmProvider } from '@aesa/llm'
import { createMailLimiter, createMockMailbox, type MailboxProvider, type MockMailbox } from '@aesa/mail'
import { enqueue, JOB_NAMES, startBoss } from '@aesa/queue'
import type { WorkerConfig } from '../src/config.ts'
import { mailboxSyncJob, registerMailboxSync } from '../src/jobs/mailbox-sync.ts'
import { registerLlmProbe } from '../src/jobs/llm-probe.ts'
import { enqueueNotifyDispatch, registerNotifyDispatch } from '../src/jobs/notify-dispatch.ts'
import { registerSendExecute, type SendExecuteDeps } from '../src/jobs/send-execute.ts'
import { enqueueTicketDraft, registerTicketDraft } from '../src/jobs/ticket-draft.ts'
import { registerTicketTriage } from '../src/jobs/ticket-triage.ts'
import { createProviderResolver } from '../src/provider-resolver.ts'
import { maybeRegisterSendRole } from '../src/send-role.ts'
import type { PushMessage, SendPush } from '../src/push.ts'
import { createMockOpenAi } from './helpers/mock-openai.ts'

const rand = (): string => randomBytes(4).toString('hex')
const DB_URL = process.env.DATABASE_URL ?? 'postgres://aesa:aesa@localhost:5434/aesa_dev'
const SCHEMA = `pgboss_e2e6_${randomBytes(4).toString('hex')}`
const CUSTOMER_DOMAIN = 'example.test'

/** Credential A: the owner's own OpenAI-compatible endpoint, and the model they run on it. */
const CUSTOM_BASE = 'https://llm.example.test/v1'
const CUSTOM_MODEL = 'qwen3:32b'
const CUSTOM_KEY = 'sk-local-qwen-NEVERLOGTHIS-ab12'
/** Credential B: a preset, whose catalog model is the only way to reach the ladder's `native` rung. */
const OPENAI_BASE = PROVIDER_PRESETS.openai.baseUrl!
const OPENAI_MODEL = 'gpt-5'
const OPENAI_KEY = 'sk-openai-NEVERLOGTHIS-cd34'
/** What the mock's `GET /models` lists — `last_probe.models` is asserted against it verbatim. */
const MOCK_MODELS = [CUSTOM_MODEL, 'qwen3:8b', OPENAI_MODEL]

/**
 * What the endpoint honours unless a scenario says otherwise, and what `afterEach` puts it back to:
 * everything, `json_schema` included — which is the verdict scenario 1's probe stores for credential
 * A. Every scenario therefore starts against an endpoint its agent's stored capabilities agree with,
 * and a scenario that wants a weaker server degrades it deliberately.
 */
const DEFAULT_MODE = 'native' as const

/** The hostname scenario 7's DNS stub resolves to loopback; every other host resolves public. */
const LOOPBACK_HOST = 'metadata.internal.example.test'

/** Passes every guardrail screen — no markup, no link, no address, no number, no promise token —
 *  and therefore `warningCount: 0` (`e2e-phase5.test.ts`'s `CLEAN_BODY`, verbatim). */
const CLEAN_BODY = 'I have checked the details you gave us and everything looks correct on our side.'

const QUESTION = 'Where is my order?'
const CUSTOMER_TEXT = 'Where is my order? It was due yesterday.'

/** The one chunk scenario 6 grounds on. A fixed id, because the mock's decision is a constant: an
 *  id retrieval did not return is filtered out by `computeEvidence`, so citing it costs nothing in
 *  every other scenario (where `stubChunks` is empty and grounding is null). */
const GROUNDED_CHUNK_ID = '11111111-2222-4333-8444-555555555555'

/** Every triage call in this file resolves to the same plain, non-escalating verdict. */
const TRIAGE_VERDICT = {
  categoryKey: 'order_status',
  language: 'en',
  sentiment: 'neutral' as const,
  isSpam: false,
  isAutomated: false,
  escalationFlags: [] as string[],
  questions: [QUESTION],
}

/**
 * Every draft call resolves to this. `confidence: 0.95` is load-bearing twice over: it is what
 * `drafts.confidence` stores RAW (plan deviation 1) and what the quality cap clamps — to 0.6 on a
 * `limited` model (scenarios 2 and 6) and 0.9 on a `standard` one (scenario 3).
 */
const DRAFT_DECISION: DraftDecision = {
  outcome: 'reply',
  categoryKey: 'order_status',
  body: CLEAN_BODY,
  confidence: 0.95,
  citedChunkIds: [GROUNDED_CHUNK_ID],
  usedAnswerIds: [],
  memoryConflictIds: [],
  unresolvedQuestions: [],
  customerLanguage: 'en',
  rationale: 'The thread and what this business has published agree on what to say.',
}

/** vitest's own waitFor, tuned for pg-boss's ~2 s poll cadence with headroom for the longest chain
 *  here (sync → triage → draft). */
function waitFor<T>(fn: () => T | Promise<T>): Promise<T> {
  return vi.waitFor(fn, { timeout: 40_000, interval: 200 })
}

/**
 * A raw trigger, bypassing `enqueue()`'s `${orgId}:${entityId}` key on purpose: `llm.probe` ships
 * `policy: 'short'`, whose unique index is over `COALESCE(singleton_key, '')`.
 */
const rawSend = (boss: PgBoss, name: string, data: unknown): Promise<string | null> =>
  boss.send(name, data as object, { singletonKey: `e2e6-${randomBytes(8).toString('hex')}` })

/** Never actually reached: the fixture seeds a FRESH access token, so `getAccessToken` returns
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
  model: number | null
  modelRaw: number | null
  modelCap: number
  tier: string
  provider: string
  modelId: string
  mode: string
  modelGeneration: number
  grounding: { score: number | null; mode: string | null; retrieved: number; cited: number }
  blockers: Record<string, boolean>
}

describe('Phase 6 close-out E2E (the real llm service, the real llm.probe job, the real resolver and a real OpenAI-compatible adapter over a mock endpoint)', () => {
  let t: Awaited<ReturnType<typeof createTestDatabase>>
  let app: ReturnType<typeof createDb>
  let boss: PgBoss
  let llmDeps: LlmServiceDeps

  const logLines: string[] = []
  const logger = pino({ level: 'info' }, { write: (line: string) => { logLines.push(line) } })

  const ring: KekRing = loadKekRing({ AESA_KEK_V1: randomBytes(32).toString('base64'), AESA_KEK_ACTIVE: '1' })
  const mailboxesByAddress = new Map<string, MockMailbox>()
  const pushCalls: PushMessage[] = []

  // ---- the endpoint, the managed fallback and the retrieval stub ------------

  const mock = createMockOpenAi({
    mode: DEFAULT_MODE,
    models: MOCK_MODELS,
    baseUrls: [CUSTOM_BASE, OPENAI_BASE],
    triage: TRIAGE_VERDICT,
    draft: DRAFT_DECISION,
  })

  /** Seam 1: the platform's own model, for `fallback_to_managed` alone. The usage is non-zero on
   *  purpose — a fallback that cost nothing could not move `llm_cost_micros` (scenario 5). */
  const managedFake = createFakeProvider([], {
    kind: 'anthropic',
    byRole: {
      triage: [{ parsed: TRIAGE_VERDICT, usage: { inputTokens: 1200, outputTokens: 180 } }],
      draft: [{ parsed: DRAFT_DECISION, usage: { inputTokens: 1200, outputTokens: 180 } }],
    },
  })
  let managed: LlmProvider

  /** Seam 5: retrieval, stubbed. Empty except where a scenario asks for grounding. */
  let stubChunks: RetrievedChunk[] = []
  const retriever: Retriever = {
    retrieve: async () => ({ chunks: stubChunks, answers: [] }),
  }

  // ---- seam 3: the deferrable `llm.probe` enqueue ---------------------------

  let heldProbes: Record<string, unknown>[] | null = null
  /** Parks every `llm.probe` send, exposing the api's own payloads, until `release` sends them in order. */
  function holdProbes(): { payloads: Record<string, unknown>[]; release: () => Promise<void> } {
    const payloads: Record<string, unknown>[] = []
    heldProbes = payloads
    return { payloads, release: flushHeldProbes }
  }
  async function flushHeldProbes(): Promise<void> {
    const held = heldProbes
    heldProbes = null
    for (const data of held ?? []) await rawSend(boss, JOB_NAMES.llmProbe, data)
  }

  // ---- seam 4: the gateable triage → draft hand-off -------------------------

  let draftGate: Promise<void> | null = null
  let releaseDraftGate: (() => void) | null = null
  /** Parks every `ticket.draft` enqueue until the returned release is called (idempotent). */
  function gateDrafts(): () => void {
    draftGate = new Promise<void>((resolve) => {
      releaseDraftGate = () => { draftGate = null; releaseDraftGate = null; resolve() }
    })
    return () => releaseDraftGate?.()
  }
  /** A failed assertion between `gateDrafts()`/`holdProbes()` and its release would park that seam
   *  FOREVER — every later scenario would then time out on work that was never enqueued, burying the
   *  one real failure. Both releases are idempotent and cost nothing when the scenario released. */
  afterEach(async () => {
    releaseDraftGate?.()
    await flushHeldProbes()
    // …and the endpoint goes back to the file's default behaviour. Without this, one scenario's
    // deliberate degradation — or a failed assertion that left it half-applied — decides what the
    // NEXT scenario's endpoint does, and the cascade reads as a second, unrelated failure.
    mock.setMode(DEFAULT_MODE)
    mock.setStatus(null)
  })

  const enqueueDraftSeam = async (orgId: string, ticketId: string, opts?: { startAfter?: Date }): Promise<void> => {
    if (draftGate) await draftGate
    await enqueueTicketDraft(boss, orgId, ticketId, opts)
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

    const sink = createMeterSink(app.db)
    managed = withMetering(managedFake, sink, { cacheTtl: '1h' })

    // The REAL resolver, built exactly the way `agent-role.ts` builds it — one instance for the
    // whole file, shared by every job AND by `llm.probe`, so the cache the probe invalidates is the
    // cache the next draft reads. Only `fetchFn` is the seam.
    const providers = createProviderResolver({
      db: app.db, ring, managed, sink, logger, fetchFn: mock.fetchFn,
    })

    const limiter = createMailLimiter()
    const clientFactory = (_provider: 'gmail' | 'microsoft', _token: string, addr: string): MockMailbox =>
      mailboxesByAddress.get(addr)!

    await registerMailboxSync(boss, { db: app.db, ring, config: workerConfig(), limiter, logger, clientFactory })
    await registerLlmProbe(boss, {
      db: app.db, ring, sink, logger, resolver: providers, fetchFn: mock.fetchFn,
      enqueueNotify: (orgId, notificationId) => enqueueNotifyDispatch(boss, orgId, notificationId),
    })
    await registerTicketTriage(boss, {
      db: app.db, providers, logger,
      enqueueNotify: (orgId, notificationId) => enqueueNotifyDispatch(boss, orgId, notificationId),
      enqueueDraft: enqueueDraftSeam,
    })
    await registerTicketDraft(boss, {
      db: app.db, providers, retriever, logger,
      enqueueNotify: (orgId, notificationId) => enqueueNotifyDispatch(boss, orgId, notificationId),
      enqueueDraft: enqueueDraftSeam,
      // Nothing in this file may auto-send (scenario 6's whole point is that the cap holds), so the
      // seam throws rather than collapsing a hold window: an auto landing would fail loudly here.
      enqueueSend: async () => { throw new Error('unexpected auto-send in the Phase 6 E2E') },
    })
    await registerNotifyDispatch(boss, { db: app.db, push, logger })
    // The production role gate, with only the client/provider seams swapped in. Nothing should ever
    // send here — the mailbox's own `sentMessages()` is asserted empty in scenario 6 — but the role
    // is registered so an accidental send would really be delivered and really be caught.
    await maybeRegisterSendRole(
      {
        boss, db: app.db, config: workerConfig(), limiter, logger,
        enqueueNotify: (orgId, notificationId) => enqueueNotifyDispatch(boss, orgId, notificationId),
        enqueueDraft: enqueueDraftSeam,
        onSent: async () => {},
      },
      (b, deps: SendExecuteDeps) =>
        registerSendExecute(b, { ...deps, clientFactory, providerFactory: () => stubProvider() }),
    )

    // Retry CADENCE only (`e2e-phase3.test.ts`'s note 2): the limits, the queue POLICY and every
    // recovery path are the shipped ones; the production 30 s backoff would just make a transient
    // failure cost minutes.
    await boss.updateQueue(JOB_NAMES.ticketDraft, {
      name: JOB_NAMES.ticketDraft, policy: 'short',
      retryLimit: 1, retryDelay: 1, retryBackoff: false, expireInSeconds: INVARIANTS.DRAFT_JOB_EXPIRE_SECONDS,
    })

    const api = createApiFacade({ db: app.db, pool: app.pool })
    const realEnqueue = createEnqueue(boss)
    const enqueueSeam: EnqueueFn = async (name, data, opts) => {
      if (heldProbes && name === JOB_NAMES.llmProbe) {
        heldProbes.push(data)
        return `held-${heldProbes.length}`
      }
      return realEnqueue(name, data, opts)
    }
    // Seam: the `custom` endpoint's DNS check. Everything resolves to a public address except the
    // ONE hostname scenario 7 points at loopback.
    const dnsStub: Resolver = async (hostname) =>
      hostname === LOOPBACK_HOST ? [{ address: '127.0.0.1', family: 4 }] : [{ address: '93.184.216.34', family: 4 }]
    llmDeps = { api, enqueue: enqueueSeam, logger, resolver: dnsStub }
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
      await tx.insert(agentCategoryPolicies).values(
        cats.map((c) => ({ orgId, agentId: agent!.id, categoryId: c.id, mode: 'review' })),
      )
      return { connectionId: conn!.id, agentId: agent!.id, categoryId: cats.find((c) => c.key === 'order_status')!.id }
    })

    await seedMailboxCredential(orgId, base.connectionId)
    const mailbox = createMockMailbox({ mode: 'gmail', selfAddress })
    mailboxesByAddress.set(selfAddress, mailbox)
    const created: Org = { orgId, ...base, selfAddress, domain, mailbox, ownerUserId: owner!.id }

    // Seed-on-null: the first sync remembers where to start and ingests nothing.
    await triggerSync(created)
    await waitFor(async () => {
      const [row] = await withOrg(app.db, orgId, (tx) => tx.select().from(mailboxConnections).where(eq(mailboxConnections.id, base.connectionId)))
      expect(row!.cursor).not.toBeNull()
    })
    return created
  }

  async function seedMailboxCredential(orgId: string, connectionId: string): Promise<void> {
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

  const triggerSync = (o: Org): Promise<string | null> =>
    enqueue(boss, mailboxSyncJob, { orgId: o.orgId, connectionId: o.connectionId }, { entityId: o.connectionId })

  // ---- reads ----------------------------------------------------------------

  const credentialsFor = (o: Org) =>
    withOrg(app.db, o.orgId, (tx) => tx.select().from(llmCredentials).where(eq(llmCredentials.orgId, o.orgId)))
  async function credential(o: Org, credentialId: string) {
    const [row] = await withOrg(app.db, o.orgId, (tx) => tx.select().from(llmCredentials).where(eq(llmCredentials.id, credentialId)))
    return row
  }
  /** `llm_credential_secrets` is platform-role-only (migration 0020 REVOKEs `aesa_app` outright). */
  const secretsFor = (o: Org) =>
    withPlatform(app.db, 'test:read-llm-secrets', (tx) =>
      tx.select().from(llmCredentialSecrets).where(eq(llmCredentialSecrets.orgId, o.orgId)))
  const callsFor = (o: Org) =>
    withOrg(app.db, o.orgId, (tx) => tx.select().from(llmCalls).where(eq(llmCalls.orgId, o.orgId)).orderBy(llmCalls.createdAt))
  const callsForRun = (o: Org, runId: string) =>
    withOrg(app.db, o.orgId, (tx) => tx.select().from(llmCalls).where(eq(llmCalls.runId, runId)).orderBy(llmCalls.createdAt))
  const runsForTicket = (o: Org, ticketId: string) =>
    withOrg(app.db, o.orgId, (tx) => tx.select().from(agentRuns).where(eq(agentRuns.ticketId, ticketId)).orderBy(agentRuns.startedAt))
  const eventsForRun = (o: Org, runId: string) =>
    withOrg(app.db, o.orgId, (tx) => tx.select().from(agentRunEvents).where(eq(agentRunEvents.runId, runId)).orderBy(agentRunEvents.seq))
  const draftsForTicket = (o: Org, ticketId: string) =>
    withOrg(app.db, o.orgId, (tx) => tx.select().from(drafts).where(eq(drafts.ticketId, ticketId)).orderBy(drafts.version))
  async function getTicket(o: Org, ticketId: string) {
    const [row] = await withOrg(app.db, o.orgId, (tx) => tx.select().from(tickets).where(eq(tickets.id, ticketId)))
    return row!
  }
  const notificationsOf = (o: Org, kind: string) =>
    withOrg(app.db, o.orgId, (tx) =>
      tx.select().from(notifications).where(and(eq(notifications.orgId, o.orgId), eq(notifications.kind, kind))))
  const auditRowsFor = (o: Org, entityId: string, action: string) =>
    withOrg(app.db, o.orgId, (tx) =>
      tx.select().from(auditLog).where(and(eq(auditLog.entityId, entityId), eq(auditLog.action, action))))
  async function policyFor(o: Org) {
    const [row] = await withOrg(app.db, o.orgId, (tx) =>
      tx.select().from(agentCategoryPolicies)
        .where(and(eq(agentCategoryPolicies.agentId, o.agentId), eq(agentCategoryPolicies.categoryId, o.categoryId))))
    return row!
  }
  async function metersFor(o: Org): Promise<Record<string, number>> {
    const rows = await withOrg(app.db, o.orgId, (tx) => tx.select().from(usageCounters).where(eq(usageCounters.orgId, o.orgId)))
    const out: Record<string, number> = {}
    for (const r of rows) out[r.meter] = (out[r.meter] ?? 0) + r.value
    return out
  }
  const modelConfig = (o: Org, role: 'draft' | 'triage') =>
    withOrg(app.db, o.orgId, (tx) => resolveModelConfig(tx, o.agentId, role))
  const breakdownOf = (draft: { confidenceBreakdown: unknown }): Breakdown => draft.confidenceBreakdown as Breakdown

  // ---- arrangement helpers --------------------------------------------------

  const actor = (o: Org): LlmActor => ({ userId: o.ownerUserId, actor: `user:${o.ownerUserId}` })

  const connect = (o: Org, input: AddCredentialInput) => addCredential(llmDeps, o.orgId, input, actor(o))

  async function chooseModel(
    o: Org, over: { credentialId: string | null; draftModel?: string | null; triageModel?: string | null; fallbackToManaged?: boolean },
  ) {
    return setAgentModel(llmDeps, o.orgId, {
      agentId: o.agentId,
      mode: over.credentialId === null ? 'managed' : 'byok',
      credentialId: over.credentialId,
      draftModel: over.draftModel ?? null,
      triageModel: over.triageModel ?? null,
      effort: null,
      fallbackToManaged: over.fallbackToManaged ?? false,
    }, actor(o))
  }

  /** One inbound through the REAL sync walk; resolves with the new ticket's id. */
  async function inbound(o: Org, opts: { subject: string; body?: string }): Promise<string> {
    const before = new Set((await withOrg(app.db, o.orgId, (tx) => tx.select({ id: tickets.id }).from(tickets))).map((r) => r.id))
    o.mailbox.receiveInbound({
      from: `customer-${rand()}@${CUSTOMER_DOMAIN}`, to: [o.selfAddress], subject: opts.subject,
      bodyText: opts.body ?? CUSTOMER_TEXT,
    })
    await triggerSync(o)
    return waitFor(async () => {
      const rows = await withOrg(app.db, o.orgId, (tx) => tx.select({ id: tickets.id }).from(tickets))
      const fresh = rows.filter((r) => !before.has(r.id))
      expect(fresh).toHaveLength(1)
      return fresh[0]!.id
    })
  }

  /** Inbound → sync → triage → draft, waiting for the ONE draft row on the new ticket. */
  async function inboundToDraft(o: Org, opts: { subject: string; body?: string }) {
    const ticketId = await inbound(o, opts)
    const draft = await waitFor(async () => {
      const rows = await draftsForTicket(o, ticketId)
      if (rows.length === 1) return rows[0]!
      throw new Error(await whyNoDraft(o, ticketId, rows.length))
    })
    return { ticketId, draft }
  }

  /**
   * A drafting chain that does not arrive has to say WHY on the spot. "expected 1, got 0" after a
   * 40-second wait costs a whole re-run to diagnose, and half the reasons (a refused provider, a
   * capped org, a failed run) are already written down — in the ticket, in the run row, or in the
   * job's own log line.
   */
  async function whyNoDraft(o: Org, ticketId: string, found: number): Promise<string> {
    const ticket = await getTicket(o, ticketId)
    const runs = await runsForTicket(o, ticketId)
    const lines = logLines.filter((line) => line.includes(ticketId)).slice(-4)
    return [
      `no draft on ticket ${ticketId} (found ${found}); ticket ${ticket.status}/${ticket.needsOwnerReason ?? '-'}`,
      `runs: ${JSON.stringify(runs.map((r) => [r.kind, r.status, r.errorCode, r.errorMessage?.slice(0, 160) ?? null]))}`,
      `log: ${lines.join(' | ')}`,
    ].join('\n')
  }

  /** Inbound → sync → triage, stopping at `triaged`. Used with `gateDrafts()`. */
  async function inboundToTriaged(o: Org, opts: { subject: string }): Promise<string> {
    const ticketId = await inbound(o, opts)
    await waitFor(async () => {
      expect((await getTicket(o, ticketId)).status).toBe('triaged')
    })
    return ticketId
  }

  async function waitForNeedsOwner(o: Org, ticketId: string, reason: string): Promise<void> {
    await waitFor(async () => {
      const ticket = await getTicket(o, ticketId)
      expect(ticket.status).toBe('needs_owner')
      expect(ticket.needsOwnerReason).toBe(reason)
    })
  }

  /** The probe verdict this credential's row carries, once the job has landed one. */
  async function waitForProbe(o: Org, credentialId: string, structured: 'native' | 'json_mode' | 'none' | null) {
    return waitFor(async () => {
      const row = await credential(o, credentialId)
      const probe = row!.lastProbe as { structured: string | null } | null
      expect(probe?.structured ?? null).toBe(structured)
      return row!
    })
  }

  /** The draft-role `llm_calls` rows of the one draft run on this ticket, newest run last. */
  async function draftRunOf(o: Org, ticketId: string) {
    const runs = (await runsForTicket(o, ticketId)).filter((r) => r.kind === 'draft')
    expect(runs).toHaveLength(1)
    const run = runs[0]!
    const rows = (await callsForRun(o, run.id)).filter((r) => r.role === 'draft')
    return { run, rows }
  }

  /** The rung suffix an `llm_calls` row's idempotency key ends in (`draft:<runId>:<attempt>:<rung>`). */
  const rungOf = (row: { idempotencyKey: string }): string => row.idempotencyKey.split(':').pop()!

  async function seedHumanDecisions(o: Org, ticketId: string, n: number): Promise<void> {
    const now = new Date()
    await withOrg(app.db, o.orgId, (tx) =>
      tx.insert(drafts).values(
        Array.from({ length: n }, (_unused, i) => ({
          orgId: o.orgId, ticketId, agentId: o.agentId, categoryId: o.categoryId,
          version: 100 + i, body: CLEAN_BODY, finalBody: CLEAN_BODY,
          confidence: 0.9, modelConfidence: 0.9,
          decision: 'review', decisionReason: 'category_review', status: 'sent',
          threadSnapshotAt: now, expiresAt: new Date(now.getTime() + 30 * 86_400_000),
          decidedBy: o.ownerUserId, decidedAt: now, decisionSource: 'app', editDistanceRatio: 0,
        })),
      ))
  }

  // ---- shared state across the scenarios ------------------------------------

  let org: Org
  /** Credential A — the owner's own OpenAI-compatible endpoint (`custom`). */
  let credA: string
  /** Credential B — an `openai` preset, the only way to reach the ladder's `native` rung. */
  let credB: string
  /** Scenario 2's ticket, which scenario 6 hangs its seeded human decisions on. */
  let firstTicketId: string

  // ---- 1: connect + probe ----------------------------------------------------

  it('1. addCredential seals the owner’s key onto the llm.probe payload and nothing else: the row lands unknown with no secret anywhere, and the REAL probe job turns it into healthy + the endpoint’s model list + the native rung it turns out to honour, re-wrapped under the org DEK', async () => {
    org = await createOrg()
    mock.setMode(DEFAULT_MODE)

    // The probe's send is held so the PRE-probe state is observable at all (seam 3).
    const held = holdProbes()
    const added = await connect(org, {
      provider: 'custom', label: 'Local qwen', apiKey: CUSTOM_KEY, baseUrl: CUSTOM_BASE, probeModel: CUSTOM_MODEL,
    })
    expect(added.ok).toBe(true)
    credA = (added as { ok: true; credentialId: string }).credentialId

    const fresh = await credential(org, credA)
    expect(fresh!.provider).toBe('custom')
    expect(fresh!.baseUrl).toBe(CUSTOM_BASE)
    expect(fresh!.probeModel).toBe(CUSTOM_MODEL)
    expect(fresh!.healthStatus).toBe('unknown')
    expect(fresh!.lastProbe).toBeNull()
    // Display only, and never enough to reconstruct — and the key itself is nowhere on the row.
    expect(fresh!.keyFingerprint).toMatch(/^[0-9a-f]{8}…ab12$/)
    expect(JSON.stringify(fresh)).not.toContain(CUSTOM_KEY)

    // The key is NOT in the database yet, and the api is not the one that will put it there:
    // `llm_credential_secrets` is platform-role-only, so the api's ONE path out is the sealed blob
    // on this job payload — which is a sealed box only the worker's KEK ring can open.
    expect(await secretsFor(org)).toHaveLength(0)
    expect(held.payloads).toHaveLength(1)
    expect(held.payloads[0]).toMatchObject({ orgId: org.orgId, credentialId: credA, reason: 'connect' })
    const sealedBlob = Buffer.from(held.payloads[0]!.sealed as string, 'base64')
    expect(sealedBlob.length).toBeGreaterThan(CUSTOM_KEY.length)
    expect(sealedBlob.toString('utf8')).not.toContain(CUSTOM_KEY)

    // The api audits the connection without the key, and has made no model call of any kind.
    expect(await auditRowsFor(org, credA, 'llm.credential_added')).toHaveLength(1)
    expect(JSON.stringify((await auditRowsFor(org, credA, 'llm.credential_added'))[0]!.detail)).not.toContain(CUSTOM_KEY)
    expect(await callsFor(org)).toHaveLength(0)

    await held.release()

    const probed = await waitFor(async () => {
      const row = await credential(org, credA)
      expect(row!.healthStatus).toBe('healthy')
      return row!
    })
    const probe = probed.lastProbe as { ok: boolean; models: string[]; chat: string; structured: string; error: unknown }
    expect(probe.ok).toBe(true)
    expect(probe.chat).toBe('ok')
    expect(probe.models).toEqual(MOCK_MODELS)
    expect(probe.error).toBeNull()
    // `native` on a model no catalog has ever heard of: the preset's json_mode-only seed is a GUESS
    // about someone else's server, so the probe asks for `json_schema` anyway and records what this
    // endpoint actually did (spec §LLM provider adapter; file header).
    expect(probe.structured).toBe('native')
    expect(probed.consecutiveFailures).toBe(0)
    expect(probed.lastError).toBeNull()
    expect(probed.lastProbedAt).not.toBeNull()

    // The worker is what stores the key at all, and it re-wraps what the api could only seal: the
    // long-lived shape is the org DEK's, so a cold resolve costs no box-open and no second format
    // stays alive beside it.
    const stored = await secretsFor(org)
    expect(stored).toHaveLength(1)
    expect(stored[0]!.encryption).toBe('dek')
    expect(stored[0]!.dataKeyVersion).toBe(1)
    expect(stored[0]!.keyCiphertext.toString('utf8')).not.toContain(CUSTOM_KEY)

    // TWO calls: the chat step plus the FIRST structured rung, which this endpoint honoured — the
    // json_mode rung is never reached (the loop breaks on the first rung that parses), so a probe
    // costs three calls only against a server that refuses `json_schema`. Both are the tenant's own
    // spend, and both name the credential.
    const probeCalls = (await callsFor(org)).filter((r) => r.role === 'probe')
    expect(probeCalls).toHaveLength(2)
    expect(probeCalls.every((r) => r.idempotencyKey.startsWith(`probe:${credA}:`))).toBe(true)
    expect(probeCalls.some((r) => r.idempotencyKey.endsWith(':chat'))).toBe(true)
    expect(probeCalls.some((r) => r.idempotencyKey.endsWith(':structured:native'))).toBe(true)
    expect(probeCalls.some((r) => r.idempotencyKey.endsWith(':structured:json_mode'))).toBe(false)
    for (const row of probeCalls) {
      expect(row.mode).toBe('byok')
      expect(row.credentialId).toBe(credA)
      expect(row.provider).toBe('custom')
    }

    const audits = await auditRowsFor(org, credA, 'llm.credential_probed')
    expect(audits).toHaveLength(1)
    expect(audits[0]!.actor).toBe('system:llm.probe')
    expect(audits[0]!.detail).toMatchObject({ reason: 'connect', ok: true, structured: 'native', health: 'healthy' })
  }, 240_000)

  // ---- 2: the agent drafts on the owner's own endpoint ------------------------

  it('2. setAgentModel points the agent at that credential and the whole chain runs on it: triage and draft both on qwen3:32b at the NATIVE rung the probe proved, the run rows and every llm_calls row byok + credential-scoped, the quality cap still 0.6 on the breakdown, and the spend in the BYOK meter alone', async () => {
    const chosen = await chooseModel(org, { credentialId: credA, draftModel: CUSTOM_MODEL, triageModel: CUSTOM_MODEL })
    expect(chosen).toEqual({ ok: true, generationBumped: true, demoted: 0 })

    const resolved = await modelConfig(org, 'draft')
    expect(resolved.mode).toBe('byok')
    expect(resolved.provider).toBe('custom')
    expect(resolved.model).toBe(CUSTOM_MODEL)
    // An unlisted model is `limited` until it has proven otherwise (spec §Risks).
    expect(resolved.tier).toBe('limited')
    expect(resolved.credentialId).toBe(credA)

    const metersBefore = await metersFor(org)
    const { ticketId, draft } = await inboundToDraft(org, { subject: QUESTION })
    firstTicketId = ticketId

    expect(draft.status).toBe('pending')
    expect(draft.decision).toBe('review')
    expect(draft.decisionReason).toBe('category_review')
    expect(draft.body).toBe(CLEAN_BODY)
    // `drafts.confidence` still means the model's own self-assessment (plan deviation 1).
    expect(draft.confidence).toBeCloseTo(0.95, 10)
    expect((await getTicket(org, ticketId)).status).toBe('awaiting_review')

    // Both runs really went to the tenant's endpoint, and the run rows say so.
    const runs = await runsForTicket(org, ticketId)
    expect(runs.map((r) => r.kind).sort()).toEqual(['draft', 'triage'])
    for (const run of runs) {
      expect(run.provider).toBe('custom')
      expect(run.model).toBe(CUSTOM_MODEL)
      expect(run.status).toBe('succeeded')
    }

    const breakdown = breakdownOf(draft)
    expect(breakdown.mode).toBe('byok')
    expect(breakdown.provider).toBe('custom')
    expect(breakdown.modelId).toBe(CUSTOM_MODEL)
    expect(breakdown.tier).toBe('limited')
    expect(breakdown.modelCap).toBe(QUALITY_CAPS.limited)
    expect(breakdown.model).toBeCloseTo(0.6, 10)          // min(0.95, 0.6)
    expect(breakdown.modelRaw).toBeCloseTo(0.95, 10)
    expect(breakdown.modelGeneration).toBe(1)

    // Every call of the run is the tenant's own, on the rung the PROBE found — `native`, on a model
    // whose preset only ever guessed json_mode. One call: the ladder's first rung parsed.
    const { run, rows } = await draftRunOf(org, ticketId)
    expect(rows).toHaveLength(1)
    expect(rungOf(rows[0]!)).toBe('native')
    expect(rows[0]!.parseStrategy).toBe('native')
    for (const row of await callsForRun(org, run.id)) {
      expect(row.mode).toBe('byok')
      expect(row.credentialId).toBe(credA)
      expect(row.provider).toBe('custom')
      expect(row.errorCode).toBeNull()
    }

    // …and so is the TRIAGE call, which resolves the agent's model through the same reader: a
    // workspace on its own key triages on its own key, and that spend is the owner's too.
    const triageRun = (await runsForTicket(org, ticketId)).find((r) => r.kind === 'triage')!
    const triageRows = await callsForRun(org, triageRun.id)
    expect(triageRows.length).toBeGreaterThan(0)
    for (const row of triageRows) {
      expect(row.role).toBe('triage')
      expect(row.mode).toBe('byok')
      expect(row.credentialId).toBe(credA)
      expect(row.provider).toBe('custom')
    }

    // The owner's spend is the owner's: the managed meter has not been touched at all.
    const meters = await metersFor(org)
    expect(meters[LLM_METERS.costMicrosByok]).toBeDefined()
    expect(meters[LLM_METERS.costMicros]).toBeUndefined()
    expect(meters[LLM_METERS.calls]).toBeGreaterThan(metersBefore[LLM_METERS.calls] ?? 0)
  }, 240_000)

  // ---- 3: every rung of the structured-output ladder --------------------------

  it('3. the ladder lands on whatever rung the probe found, and walks down as the endpoint does: a preset credential on native (its own standard tier), then json_mode with NO native attempt once the probe has narrowed it, then the plain rung, then prose → repair → extract, and a refusal short-circuits the whole ladder', async () => {
    // --- (a) a PRESET credential, on a catalog model. Two things only this shape can show: the
    // adapter reaching the preset's own base URL (the row carries no `base_url` at all), and a
    // catalog TIER — `standard`, cap 0.9 — beside scenario 2's unlisted `limited` one. The native
    // rung itself is scenario 2's subject now; here it is the baseline the next steps walk down from.
    mock.setMode('native')
    const added = await connect(org, { provider: 'openai', label: 'OpenAI key', apiKey: OPENAI_KEY })
    expect(added.ok).toBe(true)
    credB = (added as { ok: true; credentialId: string }).credentialId
    const healthy = await waitForProbe(org, credB, 'native')
    expect(healthy.healthStatus).toBe('healthy')
    expect(healthy.probeModel).toBe(OPENAI_MODEL)
    // A preset carries no endpoint of its own on the row; the adapter fills in `PROVIDER_PRESETS`'
    // base URL, and the mock serves only the two it was told about — so `healthy` IS that assertion.
    expect(healthy.baseUrl).toBeNull()

    expect(await chooseModel(org, { credentialId: credB, draftModel: OPENAI_MODEL, triageModel: OPENAI_MODEL }))
      .toEqual({ ok: true, generationBumped: true, demoted: 0 })
    expect((await modelConfig(org, 'draft')).tier).toBe('standard')

    const native = await inboundToDraft(org, { subject: `${QUESTION} (native)` })
    const nativeRun = await draftRunOf(org, native.ticketId)
    expect(nativeRun.rows).toHaveLength(1)
    expect(rungOf(nativeRun.rows[0]!)).toBe('native')
    expect(nativeRun.rows[0]!.parseStrategy).toBe('native')
    // A catalog model carries its own tier, and the cap moves with it.
    expect(breakdownOf(native.draft).tier).toBe('standard')
    expect(breakdownOf(native.draft).modelCap).toBe(QUALITY_CAPS.standard)
    expect(breakdownOf(native.draft).model).toBeCloseTo(0.9, 10)

    // --- (b) json_mode. The endpoint stops honouring json_schema; a re-probe records that (at the
    // cost of one refused native attempt, which is what discovering the change costs), and the
    // resolver's cached provider is invalidated, so the NEXT draft never asks for native again.
    mock.setMode('json_mode')
    expect(await probeCredential(llmDeps, org.orgId, credB, actor(org))).toEqual({ ok: true })
    await waitForProbe(org, credB, 'json_mode')

    const jsonMode = await inboundToDraft(org, { subject: `${QUESTION} (json_mode)` })
    const jsonRun = await draftRunOf(org, jsonMode.ticketId)
    expect(jsonRun.rows).toHaveLength(1)
    expect(rungOf(jsonRun.rows[0]!)).toBe('json_mode')
    expect(jsonRun.rows[0]!.parseStrategy).toBe('json_mode')
    expect(jsonRun.rows.map(rungOf)).not.toContain('native')

    // --- (c) plain. The endpoint honours neither rung; the probe says `none`, which BOTH downgrades
    // the tier to `limited` and forces the ladder's own plain-text rung.
    mock.setMode('plain')
    expect(await probeCredential(llmDeps, org.orgId, credB, actor(org))).toEqual({ ok: true })
    const noStructured = await waitForProbe(org, credB, 'none')
    expect(noStructured.healthStatus).toBe('healthy')          // the chat step still worked
    expect((await modelConfig(org, 'draft')).tier).toBe('limited')

    const plain = await inboundToDraft(org, { subject: `${QUESTION} (plain)` })
    const plainRun = await draftRunOf(org, plain.ticketId)
    expect(plainRun.rows).toHaveLength(1)
    expect(rungOf(plainRun.rows[0]!)).toBe('plain')
    // The ROW records what the ADAPTER parsed, and the plain rung asks it for no structured output
    // at all (`output: undefined`) — so `none` here is right, and the LADDER's own verdict, which is
    // the one the run trace carries, is `plain`. Metering sits INSIDE the ladder; that is the whole
    // reason one run can show a rung-by-rung breakdown at all.
    expect(plainRun.rows[0]!.parseStrategy).toBe('none')
    expect(plain.draft.body).toBe(CLEAN_BODY)
    const plainCall = (await eventsForRun(org, plainRun.run.id)).filter((e) => e.kind === 'call')
    expect(plainCall).toHaveLength(1)
    expect((plainCall[0]!.payload as { parseStrategy: string }).parseStrategy).toBe('plain')

    // --- (d) prose → repair → extract. The reply is JSON wrapped in chat, so the plain rung parses
    // nothing, the repair call answers the same way, and the local extraction is what lands it.
    mock.setMode('prose')
    const prose = await inboundToDraft(org, { subject: `${QUESTION} (prose)` })
    const proseRun = await draftRunOf(org, prose.ticketId)
    expect(proseRun.rows.map(rungOf)).toEqual(['plain', 'repair'])
    // Each ROW again records what the adapter itself parsed — nothing, both times…
    expect(proseRun.rows.map((r) => r.parseStrategy)).toEqual(['none', 'none'])
    // …while the LADDER's verdict is the rung that finally landed the decision.
    const proseCall = (await eventsForRun(org, proseRun.run.id)).filter((e) => e.kind === 'call')
    expect(proseCall).toHaveLength(1)
    expect((proseCall[0]!.payload as { parseStrategy: string }).parseStrategy).toBe('extract')
    expect(prose.draft.body).toBe(CLEAN_BODY)
    expect(prose.draft.status).toBe('pending')

    // --- (e) a refusal. The ladder returns the moment a rung declines — asking again would only
    // spend another call on the same "no" — and with no body the ticket goes to the owner. The
    // endpoint goes back to answering normally first, so the TRIAGE call ahead of it still lands.
    mock.setMode(DEFAULT_MODE)
    const release = gateDrafts()
    const refusedTicket = await inboundToTriaged(org, { subject: `${QUESTION} (refusal)` })
    mock.setMode('refusal')
    release()
    await waitForNeedsOwner(org, refusedTicket, 'agent_escalated')
    const refusedRun = await draftRunOf(org, refusedTicket)
    expect(refusedRun.rows).toHaveLength(1)
    expect(refusedRun.rows[0]!.finish).toBe('refusal')
    expect(await draftsForTicket(org, refusedTicket)).toHaveLength(0)
  }, 240_000)

  // ---- 4: a key the provider rejects -----------------------------------------

  it('4. a 401 mid-draft kills the credential rather than retrying it: dead with a scrubbed last_error, ONE provider_health page, the ticket on provider_unavailable — and the NEXT inbound is refused by the resolver before any run row, any model call or a second page', async () => {
    const release = gateDrafts()
    const ticketId = await inboundToTriaged(org, { subject: `${QUESTION} (dead key)` })
    // Armed between the triage call and the draft call (seam 4): triage's own failure policy is a
    // different job's rule, and this scenario is about the draft path's auth landing.
    mock.setStatus(401)
    release()

    await waitForNeedsOwner(org, ticketId, 'provider_unavailable')

    const dead = await credential(org, credB)
    expect(dead!.healthStatus).toBe('dead')
    expect(dead!.consecutiveFailures).toBe(1)
    expect(dead!.lastError).toBeTruthy()
    expect(dead!.lastError!.length).toBeLessThanOrEqual(200)
    expect(dead!.lastError).not.toContain(OPENAI_KEY)

    const pages = await notificationsOf(org, 'provider_health')
    expect(pages).toHaveLength(1)
    expect(pages[0]!.title).toBe('AI provider needs attention')
    expect(pages[0]!.payload).toEqual({ credentialId: credB })
    expect(await auditRowsFor(org, credB, 'llm.credential_dead')).toHaveLength(1)

    // The run itself is settled as a failure, and the failed call is metered with its error code.
    const { run, rows } = await draftRunOf(org, ticketId)
    expect(run.status).toBe('failed')
    expect(run.errorCode).toBe('llm_auth')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.errorCode).toBe('auth')
    expect(rows[0]!.mode).toBe('byok')
    expect(rows[0]!.credentialId).toBe(credB)
    expect(await draftsForTicket(org, ticketId)).toHaveLength(0)

    // The next ticket never reaches the endpoint at all: the resolver refuses a `dead` credential
    // BEFORE the spend guard, so there is no run row, no model call and no second page.
    const requestsBefore = mock.requests.length
    const callsBefore = (await callsFor(org)).length
    const nextTicket = await inbound(org, { subject: `${QUESTION} (still dead)` })
    await waitForNeedsOwner(org, nextTicket, 'provider_unavailable')
    expect(await runsForTicket(org, nextTicket)).toHaveLength(0)
    expect((await callsFor(org)).length).toBe(callsBefore)
    expect(mock.requests.length).toBe(requestsBefore)
    expect(await notificationsOf(org, 'provider_health')).toHaveLength(1)
  }, 240_000)

  // ---- 5: fallback_to_managed -------------------------------------------------

  it('5. with fallback_to_managed on, a 500 from the owner’s endpoint is answered by Managed AI: the draft lands, the run trace records the fallback, the breakdown names the model that actually wrote it, and the spend moves to the MANAGED meter', async () => {
    // Back onto credential A (healthy); `credB` is dead and `setAgentModel` would refuse it outright.
    expect(await chooseModel(org, { credentialId: credA, draftModel: CUSTOM_MODEL, triageModel: CUSTOM_MODEL, fallbackToManaged: true }))
      .toEqual({ ok: true, generationBumped: true, demoted: 0 })

    const before = await metersFor(org)
    // Armed between the triage call and the draft call (seam 4), so TRIAGE lands on the tenant's own
    // provider and the managed meter below moves by exactly one call: the draft's fallback. A
    // globally-armed 500 would have triage fall back too, and "the platform paid for this one" would
    // then be an assertion about two calls at once.
    const release = gateDrafts()
    const ticketId = await inboundToTriaged(org, { subject: `${QUESTION} (fallback)` })
    mock.setStatus(500)
    release()
    const draft = await waitFor(async () => {
      const rows = await draftsForTicket(org, ticketId)
      if (rows.length === 1) return rows[0]!
      throw new Error(await whyNoDraft(org, ticketId, rows.length))
    })
    mock.setStatus(null)

    expect(draft.status).toBe('pending')
    expect(draft.body).toBe(CLEAN_BODY)

    // The breakdown describes the model that actually produced the body, never the one that failed.
    const breakdown = breakdownOf(draft)
    expect(breakdown.mode).toBe('managed')
    expect(breakdown.provider).toBe('anthropic')
    expect(breakdown.modelId).toBe(MANAGED_MODELS.draft)
    expect(breakdown.tier).toBe('limited')            // the AGENT's tier is still its own choice's

    // The triage run really did go out on the tenant's key — it ran before the outage was armed.
    const triageRun = (await runsForTicket(org, ticketId)).find((r) => r.kind === 'triage')!
    expect(triageRun.provider).toBe('custom')
    expect((await callsForRun(org, triageRun.id)).every((r) => r.mode === 'byok' && r.errorCode === null)).toBe(true)

    const { run, rows } = await draftRunOf(org, ticketId)
    const fallbackEvents = (await eventsForRun(org, run.id))
      .filter((e) => e.kind === 'call' && (e.payload as { fallback?: boolean }).fallback === true)
    expect(fallbackEvents).toHaveLength(1)
    expect(fallbackEvents[0]!.payload).toMatchObject({ attempt: 1, fallback: true, from: 'custom', code: 'transient' })

    // Two rows for the one attempt: the tenant's failed call, then the managed one that answered,
    // under its own idempotency key so the fallback's spend is never dropped as a duplicate.
    expect(rows).toHaveLength(2)
    const refused = rows.find((r) => r.mode === 'byok')!
    const answered = rows.find((r) => r.mode === 'managed')!
    expect(refused.credentialId).toBe(credA)
    expect(refused.errorCode).toBe('transient')
    expect(answered.credentialId).toBeNull()
    expect(answered.model).toBe(MANAGED_MODELS.draft)
    expect(answered.errorCode).toBeNull()
    expect(rungOf(answered)).toBe('fallback')

    // The platform paid for this ONE call, and the owner did not: the managed meter moved by exactly
    // the fallback draft's cost, and the owner's is untouched (their failed call cost 0 and their
    // triage model has no seeded price).
    const after = await metersFor(org)
    expect(after[LLM_METERS.costMicros]).toBe(answered.costMicros)
    expect(answered.costMicros).toBeGreaterThan(0)
    expect(after[LLM_METERS.costMicrosByok]).toBe(before[LLM_METERS.costMicrosByok])
  }, 240_000)

  // ---- 6: the quality cap holds Autopilot -------------------------------------

  it('6. the quality cap is what stops a limited model auto-sending: an Eager category with ten human decisions behind it and a 0.9 grounded citation still lands in review — evidence 0.9 × 0.6 = 0.54 under the 0.70 bar — with no send row and nothing delivered', async () => {
    // The same credential and model as scenario 5, with the fallback turned back off: the (mode,
    // credential, model) triple is unchanged, so no generation is burnt and nothing is demoted.
    expect(await chooseModel(org, { credentialId: credA, draftModel: CUSTOM_MODEL, triageModel: CUSTOM_MODEL }))
      .toEqual({ ok: true, generationBumped: false, demoted: 0 })

    await seedHumanDecisions(org, firstTicketId, 10)
    await withOrg(app.db, org.orgId, (tx) =>
      tx.update(agentCategoryPolicies).set({ mode: 'auto', autoSendMinConfidence: 70, graduatedAt: new Date() })
        .where(and(eq(agentCategoryPolicies.agentId, org.agentId), eq(agentCategoryPolicies.categoryId, org.categoryId))))

    // One well-scoring chunk, which the model's constant decision cites (seam 5).
    stubChunks = [{ id: GROUNDED_CHUNK_ID, heading: 'Delivery windows', content: 'Orders ship within two working days.', score: 0.9 }]
    const sentBefore = org.mailbox.sentMessages().length
    const { ticketId, draft } = await inboundToDraft(org, { subject: `${QUESTION} (capped)` })
    stubChunks = []

    expect(draft.status).toBe('pending')
    expect(draft.decision).toBe('review')
    expect(draft.decisionReason).toBe('below_threshold')
    expect((await getTicket(org, ticketId)).status).toBe('awaiting_review')

    const breakdown = breakdownOf(draft)
    expect(breakdown.blockers.coldStart).toBe(false)
    expect(breakdown.grounding.score).toBeCloseTo(0.9, 10)
    expect(breakdown.grounding.retrieved).toBe(1)
    expect(breakdown.grounding.cited).toBe(1)
    expect(breakdown.tier).toBe('limited')
    expect(breakdown.model).toBeCloseTo(0.6, 10)
    expect(breakdown.modelRaw).toBeCloseTo(0.95, 10)
    // max(memory 0, grounding 0.9) × 0.6 — the uncapped 0.95 would have cleared the bar at 0.855.
    expect(breakdown.evidence).toBeCloseTo(0.54, 10)
    expect(breakdown.threshold).toBeCloseTo(0.7, 10)

    // Nothing was queued and nothing went out.
    const sends = await withOrg(app.db, org.orgId, (tx) => tx.select().from(outboundSends).where(eq(outboundSends.draftId, draft.id)))
    expect(sends).toHaveLength(0)
    expect(org.mailbox.sentMessages()).toHaveLength(sentBefore)
    // The category keeps its autonomy — a draft under the bar is not a correction.
    expect((await policyFor(org)).mode).toBe('auto')
  }, 240_000)

  // ---- 7: hostile endpoints are refused at the api ----------------------------

  it('7. a custom endpoint that is not plain public https is refused before anything is stored: http, an IP literal, embedded credentials and a hostname that resolves to loopback each come back unsafe_url, with no row, no secret and no request', async () => {
    const before = (await credentialsFor(org)).length
    const secretsBefore = (await secretsFor(org)).length
    const requestsBefore = mock.requests.length

    const hostile = [
      'http://llm.example.test/v1',
      'https://10.0.0.1/v1',
      'https://someone:hunter2@llm.example.test/v1',
      `https://${LOOPBACK_HOST}/v1`,
    ]
    for (const baseUrl of hostile) {
      expect(await connect(org, {
        provider: 'custom', label: `Hostile ${baseUrl}`, apiKey: CUSTOM_KEY, baseUrl, probeModel: CUSTOM_MODEL,
      })).toEqual({ ok: false, code: 'unsafe_url' })
    }

    expect((await credentialsFor(org)).length).toBe(before)
    expect((await secretsFor(org)).length).toBe(secretsBefore)
    expect(mock.requests.length).toBe(requestsBefore)
  }, 240_000)

  // ---- 8: disconnecting puts the agent back on Managed AI ---------------------

  it('8. removing the credential resets every agent on it to Managed AI in the same transaction, takes Autopilot off the categories that had it (model_changed, ONE page), and leaves no secret behind', async () => {
    expect((await policyFor(org)).mode).toBe('auto')

    const removed = await removeCredential(llmDeps, org.orgId, credA, actor(org))
    expect(removed).toEqual({ ok: true, agentsReset: 1 })

    const resolved = await modelConfig(org, 'draft')
    expect(resolved.mode).toBe('managed')
    expect(resolved.provider).toBe('anthropic')
    expect(resolved.model).toBe(MANAGED_MODELS.draft)
    expect(resolved.credentialId).toBeNull()
    expect(resolved.tier).toBe('calibrated')
    const rows = await withOrg(app.db, org.orgId, (tx) =>
      tx.select().from(agentModelConfig).where(eq(agentModelConfig.agentId, org.agentId)))
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      expect(row.mode).toBe('managed')
      expect(row.credentialId).toBeNull()
      expect(row.fallbackToManaged).toBe(false)
    }

    // A new model has not earned the old one's autonomy.
    const policy = await policyFor(org)
    expect(policy.mode).toBe('review')
    expect(policy.demotedReason).toBe('model_changed')
    expect(policy.demotedAt).not.toBeNull()
    const demotions = await notificationsOf(org, 'demotion')
    expect(demotions).toHaveLength(1)
    expect(demotions[0]!.title).toMatch(/^Autopilot paused for /)

    // The dead one goes too — nobody was on it, so nothing is reset and nothing is demoted.
    expect(await removeCredential(llmDeps, org.orgId, credB, actor(org))).toEqual({ ok: true, agentsReset: 0 })
    expect(await notificationsOf(org, 'demotion')).toHaveLength(1)

    expect(await credentialsFor(org)).toHaveLength(0)
    // `llm_credential_secrets` cascades from the FK — a referential action bypasses both RLS and
    // the REVOKE, which is why the api never names that table.
    expect(await secretsFor(org)).toHaveLength(0)
    expect(await auditRowsFor(org, credA, 'llm.credential_removed')).toHaveLength(1)
    expect(await auditRowsFor(org, credB, 'llm.credential_removed')).toHaveLength(1)

    // The file's closing ledger: every escalation of this run really reached the push dispatcher,
    // and the owner's key never appeared in a log line.
    expect(pushCalls.length).toBeGreaterThan(0)
    expect(logLines.join('\n')).not.toContain(CUSTOM_KEY)
    expect(logLines.join('\n')).not.toContain(OPENAI_KEY)
  }, 240_000)
})
