/**
 * Phase 7 close-out: billing, caps, retention, deletion, key rotation, "Remember this reply" and the
 * two knowledge sweeps, driven end to end through the REAL api services (`@aesa/api/billing`'s
 * `startCheckout` / `setOverageMode` / `getBilling` and the webhook's `applyStripeEvent`,
 * `@aesa/api/workspace`'s `requestDeletion` / `setRetentionDays`, `@aesa/api/memory`'s
 * `rememberReply`, `@aesa/api/knowledge`'s `pasteSource`, `@aesa/api/llm`'s `addCredential` /
 * `setAgentModel`, `@aesa/api/drafts`' `approveDraft` — all wired to `createApiFacade` /
 * `createEnqueue` from `@aesa/api/deps`), the REAL jobs (`mailbox.sync`, `ticket.triage`,
 * `ticket.draft`, `send.execute`, `memory.capture`, `llm.probe`, `notify.dispatch`,
 * `knowledge.ingest`, `knowledge.embed-batch`, `workspace.purge`) and the REAL cron bodies
 * (`billing.report-usage`, `retention.sweep`, `workspace.purge-sweep`, `keys.rotate`,
 * `knowledge.stuck-sweep`, `knowledge.reembed-sweep`), with only the sockets stubbed.
 *
 * The unit suites — `billing-report-usage.test.ts`, `retention-sweep.test.ts`,
 * `workspace-purge.test.ts`, `keys-rotate.test.ts`, `memory-capture.test.ts`,
 * `knowledge-{stuck,reembed}-sweep.test.ts`, `send-execute.test.ts`, `ticket-draft.test.ts` and
 * `apps/api/test/billing-{service,webhook}.test.ts` / `workspace-lifecycle.test.ts` — own the
 * branch-by-branch rules. This file exists to prove the WIRING between them: a Checkout the api
 * started really lands as the plan the worker's draft job reads, the 601st managed conversation
 * really becomes ONE metered unit on the fake's wire, a card that fails really holds the agent's
 * sends and not the owner's, a cancelled subscription really drops the caps the same instant, the
 * retention promise really nulls bodies and nothing else, a deletion really cancels the plan and
 * really empties every tenant table 30 days later while the workspace beside it keeps every row,
 * a rotated KEK really still opens both secrets, a remembered reply really reaches the next draft,
 * and a flipped embedding model really comes back on the vector leg.
 *
 * Shape ported from `e2e-phase6.test.ts`: one throwaway database (`createTestDatabase`), one
 * pg-boss instance on the shared dev `DATABASE_URL` under a schema unique to THIS run
 * (`pgboss_e2e7_<hex>`, dropped in `afterAll`), `createMockMailbox` plugged into `mailbox.sync` and
 * `send.execute` through their `clientFactory` seams, a `createFakeProvider` managed provider
 * wrapped in the real `withMetering`/`createMeterSink` pair, the REAL `createProviderResolver` in
 * front of it (with `test/helpers/mock-openai.ts` as the BYOK wire), the REAL `createRetriever`
 * over ONE `createHashEmbedder()` shared with every job that writes a vector, and `waitFor` polling
 * with NO wall-clock sleeps anywhere.
 *
 * SIX harness-level seams, all arrangement rather than assertion:
 *
 *  1. **One fake clock, injected everywhere a job or service takes `now`** (`clock.now`), advanced by
 *     the scenarios (+15 d for the trial to expire, +31 d twice for retention and the purge grace
 *     period). It runs `Date.now() + offset`, so it still ticks — a frozen clock would make every
 *     `created_at` default (the database's own `now()`) sort AFTER the fake one. `send.execute`'s
 *     copy runs `SEND_CLOCK_SKEW_MS` (16 s) ahead of it, `e2e-phase5.test.ts`'s note 4: an approve
 *     writes `send_after = now + 15 s`, and the undo window is real. `mailbox.sync` stays on the wall
 *     clock — its `now` only schedules ITS OWN retries through pg-boss, whose `startAfter` is wall
 *     time; likewise the draft job's `org_busy` re-enqueue is rebased from fake to wall time in the
 *     `enqueueDraft` seam, so a fake `+30 s` never becomes a job scheduled 77 days out.
 *  2. **One fake Stripe implementing BOTH ports** (`test/helpers/fake-stripe.ts`): the api's
 *     `startCheckout` / `requestDeletion` and the worker's `billing.report-usage` share one call log,
 *     which is what lets scenario 3 say "Stripe heard exactly one meter event". Every scenario still
 *     asserts through the DATABASE (the row the webhook wrote, the watermark the report moved, the
 *     audit row) — the log only confirms what left the process. Webhook events are built with
 *     `stripeEvent()` and handed to `applyStripeEvent` directly, the Phase 7 E2E path the webhook
 *     module was split for; `applyStripeEvent` lives in `apps/api/src/billing/webhook.ts` and is not
 *     re-exported by `@aesa/api/billing`, so it is imported by relative path here, exactly as the
 *     api's own `billing-webhook.test.ts` imports it.
 *  3. **The hold window is collapsed by the `enqueueSend` seam, and that seam is gateable**
 *     (`gateSends()`, `e2e-phase5.test.ts`'s notes 2 and 3): an auto landing's `queued` send is
 *     parked until the scenario has asserted the pre-send state, or has applied the event
 *     (`invoice.payment_failed`, `requestDeletion`) whose lever the send must then meet.
 *  4. **The draft script names answers by MARKER** (`use:<needle>`, note 1 of `e2e-phase5.test.ts`):
 *     the fake's `usedAnswerIds` entry is replaced at call time by the id of the retrieved answer
 *     whose `Q:`/`A:` lines carry the needle, read out of the request's OWN knowledge block — so
 *     every `used_answer_ids` assertion here is an assertion about the real prompt.
 *  5. **The KEK ring holds v1 AND v2 from the start, active 1** — which is what "the SAME ring on
 *     every replica" (CLAUDE.md) means during a rotation: every replica is given the new key BEFORE
 *     the active version flips. Scenario 9 hands `keys.rotate` the same key set with `active: 2`,
 *     and then proves the jobs still open both secrets — and that a ring WITHOUT v2 no longer can.
 *  6. **`knowledge.crawl` has a queue but no worker here**: scenario 11's stuck crawl must be
 *     re-enqueued by the sweep (asserted in pg-boss's own job table) and must NOT then run to
 *     completion, or it could never be stuck three times.
 *
 * ONE thing the router owns that no service exposes: enabling the agent (`workspace.setAgentEnabled`,
 * a tRPC mutation) is what starts the trial clock, with the two-statement COALESCE write spelled
 * inline in that procedure. Scenario 1 replays those same two statements against the fake clock
 * (`enableAgent`) rather than standing up Fastify + Better Auth for one mutation; the trial maths
 * downstream of that write (`billingStateOf`, `trial_expired`, the `trial_ended` page, the
 * `subscription_inactive` landing) are all the real ones.
 *
 * Org topology: **A** carries scenarios 1–7 and 11's knowledge (trial → checkout → 601 → blocked/
 * automatic → past_due → downgrade → retention); **B** is the untouched control created beside A;
 * **C** is the one scenario 8 deletes (it needs a LIVE subscription for `cancelSubscription`, which A
 * no longer has after scenario 6); **D** is scenario 9's (provisioned under the ring the rotation
 * moves); **E** is scenario 10's (its ONE learned answer must be the remembered reply).
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { and, eq, getTableName, sql } from 'drizzle-orm'
import pg from 'pg'
import type PgBoss from 'pg-boss'
import pino from 'pino'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { DraftDecision } from '@aesa/agent'
import { getBilling, setOverageMode, startCheckout, type BillingActor, type BillingServiceDeps } from '@aesa/api/billing'
import { createApiFacade, createEnqueue, type EnqueueFn } from '@aesa/api/deps'
import { approveDraft, markViewed, type DraftActor, type DraftServiceDeps } from '@aesa/api/drafts'
import { pasteSource, type KnowledgeActor, type KnowledgeServiceDeps } from '@aesa/api/knowledge'
import { addCredential, setAgentModel, type LlmActor, type LlmServiceDeps } from '@aesa/api/llm'
import { rememberReply, type MemoryActor, type MemoryServiceDeps } from '@aesa/api/memory'
import { requestDeletion, setRetentionDays, type LifecycleActor, type LifecycleDeps } from '@aesa/api/workspace'
import { applyStripeEvent } from '../../api/src/billing/webhook.ts'
import { BILLING_PRICING, WORKSPACE_DELETE_GRACE_DAYS } from '@aesa/contracts'
import { INVARIANTS, MEMORY_EXPIRY_DAYS, resolveSetting } from '@aesa/core'
import { encrypt, hashToken, loadKekRing, Secret, type KekRing, type Resolver } from '@aesa/crypto'
import {
  agentCategoryPolicies, agents, auditLog, billingSubscriptions, bumpMeter, categories, countHumanDecisions, createMeterSink,
  draftActionTokens, drafts, ensureBillingRow, ensureDefaultCategories, knowledgeChunks, knowledgeDocuments, knowledgeSources,
  llmCalls, llmCredentials, loadOrgDek, loadSettingSources, mailboxConnections, mailboxCredentials, member, messages,
  notificationDevices, notifications, organization, orgDataKeys, orgSettings, outboundSends, provisionOrgKeys, PURGE_ORDER,
  resolvedAnswers, SEND_METERS, tickets, usageCounters, user, withOrg, withPlatform, workspaces,
} from '@aesa/db'
import { createDb } from '@aesa/db/raw'
import { createTestDatabase, createTestOrganization } from '@aesa/db/testing'
import { createHashEmbedder, createMemoryStore, createRetriever, type Embedder } from '@aesa/knowledge'
import { uploadKey } from '@aesa/knowledge/storage'
import { createFakeProvider, withMetering, type ChatRequest, type ChatResult, type FakeScript, type LlmProvider } from '@aesa/llm'
import { createMailLimiter, createMockMailbox, type MailboxProvider, type MockMailbox } from '@aesa/mail'
import { createQueueRetrying, enqueue, JOB_NAMES, queueOptionsFor, startBoss } from '@aesa/queue'
import { runBillingReportUsage } from '../src/billing/report-usage.ts'
import type { WorkerConfig } from '../src/config.ts'
import { enqueueKnowledgeEmbedBatch, registerKnowledgeEmbedBatch, runKnowledgeEmbedBatch } from '../src/jobs/knowledge-embed-batch.ts'
import { registerKnowledgeIngest } from '../src/jobs/knowledge-ingest.ts'
import { runKnowledgeReembedSweep } from '../src/jobs/knowledge-reembed-sweep.ts'
import { runKnowledgeStuckSweep, STUCK_LEASE_SECONDS, STUCK_MAX_ATTEMPTS } from '../src/jobs/knowledge-stuck-sweep.ts'
import { runKeysRotate } from '../src/jobs/keys-rotate.ts'
import { registerLlmProbe } from '../src/jobs/llm-probe.ts'
import { mailboxSyncJob, registerMailboxSync } from '../src/jobs/mailbox-sync.ts'
import { enqueueMemoryCapture, registerMemoryCapture } from '../src/jobs/memory-capture.ts'
import { enqueueNotifyDispatch, registerNotifyDispatch } from '../src/jobs/notify-dispatch.ts'
import { runRetentionSweep } from '../src/jobs/retention-sweep.ts'
import { registerSendExecute, type SendExecuteDeps } from '../src/jobs/send-execute.ts'
import { enqueueTicketDraft, registerTicketDraft } from '../src/jobs/ticket-draft.ts'
import { registerTicketTriage } from '../src/jobs/ticket-triage.ts'
import { registerWorkspacePurge, runWorkspacePurgeSweep } from '../src/jobs/workspace-purge.ts'
import type { KnowledgeDeps } from '../src/knowledge-deps.ts'
import { createProviderResolver } from '../src/provider-resolver.ts'
import type { PushMessage, SendPush } from '../src/push.ts'
import { maybeRegisterSendRole } from '../src/send-role.ts'
import { createFakeStripe, stripeEvent } from './helpers/fake-stripe.ts'
import { createMockOpenAi } from './helpers/mock-openai.ts'

const rand = (): string => randomBytes(4).toString('hex')
const DB_URL = process.env.DATABASE_URL ?? 'postgres://aesa:aesa@localhost:5434/aesa_dev'
const SCHEMA = `pgboss_e2e7_${randomBytes(4).toString('hex')}`
const CUSTOMER_DOMAIN = 'example.test'
const DAY_MS = 86_400_000

/** See the file header, seam 1. */
const SEND_CLOCK_SKEW_MS = 16_000

/** The two configured price ids — how the webhook tells the licensed domain line from the metered
 *  overage line (`selectItems`), by PRICE and never by position. */
const PRICE_DOMAIN = 'price_domain_e2e7'
const PRICE_OVERAGE = 'price_overage_e2e7'

/** The owner's own OpenAI-compatible endpoint (scenarios 6 and 9) and the model they run on it. */
const CUSTOM_BASE = 'https://llm.example.test/v1'
const CUSTOM_MODEL = 'qwen3:32b'
const CUSTOM_KEY = 'sk-local-qwen-NEVERLOGTHIS-ab12'

/** The one question every customer in this file asks, and the one triage extracts from it. */
const QUESTION = 'Where is my order?'
/** `scrubForMemory` keeps this verbatim, so a remembered reply's stored question is byte-equal to
 *  the triage question the next draft retrieves by — cosine 1 on the hash embedder. */
const CUSTOMER_TEXT = QUESTION
/** The `use:` marker's needle (seam 4): a substring of the stored `Q:` line. */
const ANSWER_NEEDLE = 'Where is my order'
const USE = 'use:'

/** Passes every guardrail screen — no markup, no link, no address, no number, no promise token —
 *  and therefore `warningCount: 0`, which an auto-send needs (`e2e-phase5.test.ts`'s `CLEAN_BODY`). */
const CLEAN_BODY = 'I have checked the details you gave us and everything looks correct on our side.'
/** The owner's hand-written reply scenario 10 remembers; distinct from `CLEAN_BODY` so the stored
 *  answer is unmistakably the remembered one and not something a draft taught. */
const OWNER_REPLY = 'Your order left our warehouse yesterday and arrives within two working days.'

const TRIAGE_VERDICT = {
  categoryKey: 'order_status',
  language: 'en',
  sentiment: 'neutral' as const,
  isSpam: false,
  isAutomated: false,
  escalationFlags: [] as string[],
  questions: [QUESTION],
}

/** `confidence: 0.9` is load-bearing: `evidence = max(memory, grounding) × model`, and on the
 *  managed (calibrated, cap 1.0) model a three-approval answer gives `1 × 0.9 = 0.9`, which clears the
 *  category's 80% bar in scenarios 4 and 8. */
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
/** What every BYOK draft (the mock endpoint) resolves to — plain, cites nothing, reuses nothing. */
const BYOK_REPLY: DraftDecision = reply({ confidence: 0.95, rationale: 'Answered on the owner\'s own endpoint.' })

const UUID_IN_BRACKETS = /\[([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\]/

/** The knowledge block's entries, as the MODEL saw them (`e2e-phase5.test.ts`'s `knowledgeEntries`). */
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

/** A raw trigger, bypassing `enqueue()`'s `${orgId}:${entityId}` key on purpose: `send.execute` is
 *  `policy: 'short'`, whose unique index is over `COALESCE(singleton_key, '')`. */
const rawSend = (boss: PgBoss, name: string, data: unknown): Promise<string | null> =>
  boss.send(name, data as object, { singletonKey: `e2e7-${randomBytes(8).toString('hex')}` })

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
  businessName: string
  mailbox: MockMailbox
  ownerUserId: string
  ownerEmail: string
}

interface Breakdown {
  evidence: number | null
  threshold: number | null
  memory: { score: number; answerId: string; cosine: number; approvals: number } | null
  mode: string
  provider: string
  /** Phase 7's two billing facts ride on the blockers, with the numbers they were judged on. */
  blockers: { coldStart: boolean; allowance: { used: number; allowance: number; mode: string; exhausted: boolean }; subscription: string }
}

describe('Phase 7 close-out E2E (billing, caps, retention, delete, rotate, remember, the knowledge sweeps — the real api services and the real jobs over one throwaway database)', () => {
  let t: Awaited<ReturnType<typeof createTestDatabase>>
  let app: ReturnType<typeof createDb>
  let boss: PgBoss
  let admin: pg.Client

  let draftService: DraftServiceDeps
  let billingDeps: BillingServiceDeps
  let lifecycleDeps: LifecycleDeps
  let memoryDeps: MemoryServiceDeps
  let knowledgeService: KnowledgeServiceDeps
  let llmDeps: LlmServiceDeps

  /** Every job's and service's logger writes here: the alerts (`{ alert: true, kind }`) and the
   *  retriever's model-mismatch warn are asserted on these lines. */
  const logLines: string[] = []
  const logger = pino({ level: 'info' }, { write: (line: string) => { logLines.push(line) } })
  const logged = (needle: string): string[] => logLines.filter((line) => line.includes(needle))

  // ---- seam 1: the fake clock ----------------------------------------------

  let clockOffsetMs = 0
  const clock = {
    now: (): Date => new Date(Date.now() + clockOffsetMs),
    advanceDays(n: number): void { clockOffsetMs += n * DAY_MS },
  }
  const sendClock = (): Date => new Date(clock.now().getTime() + SEND_CLOCK_SKEW_MS)
  /** A fake-clock instant → the wall-clock instant the same distance out, for pg-boss `startAfter`. */
  const rebase = (fake: Date): Date => new Date(Date.now() + (fake.getTime() - clock.now().getTime()))
  /** Stripe's `event.created`: Unix seconds off the fake clock, plus a sequence so two events sent
   *  in the same second still compare strictly. */
  let eventSeq = 0
  const created = (): number => Math.floor(clock.now().getTime() / 1000) + (eventSeq += 1)
  const utcDay = (d: Date): string => d.toISOString().slice(0, 10)

  // ---- seam 5: the ring ------------------------------------------------------

  const KEK_V1 = randomBytes(32).toString('base64')
  const KEK_V2 = randomBytes(32).toString('base64')
  /** What every replica holds: both keys, v1 active. */
  const ring: KekRing = loadKekRing({ AESA_KEK_V1: KEK_V1, AESA_KEK_V2: KEK_V2, AESA_KEK_ACTIVE: '1' })
  /** The same key set with the active version flipped — what `keys.rotate` is handed. */
  const ringRotated: KekRing = loadKekRing({ AESA_KEK_V1: KEK_V1, AESA_KEK_V2: KEK_V2, AESA_KEK_ACTIVE: '2' })
  /** A replica that never received v2 — the negative half of scenario 9. */
  const ringV1Only: KekRing = loadKekRing({ AESA_KEK_V1: KEK_V1, AESA_KEK_ACTIVE: '1' })

  const mailboxesByAddress = new Map<string, MockMailbox>()
  const pushCalls: PushMessage[] = []
  const fakeStripe = createFakeStripe()
  /** ONE object store for the api's knowledge service, the ingest job and the purge job. */
  const store = createMemoryStore()
  /** ONE embedder, shared by the retriever's legs, `knowledge.embed-batch` and `memory.capture`. */
  const embedder: Embedder = createHashEmbedder()

  // ---- seam 3: the `enqueueSend` seam and its gate --------------------------

  let sendGate: Promise<void> | null = null
  let releaseSendGate: (() => void) | null = null
  function gateSends(): () => void {
    sendGate = new Promise<void>((resolve) => {
      releaseSendGate = () => { sendGate = null; releaseSendGate = null; resolve() }
    })
    return () => releaseSendGate?.()
  }
  /** Scenario 4 hands its parked auto send to scenario 5 on purpose (the lever it must meet is the
   *  event scenario 5 applies), and says so by setting this as its LAST statement — so a failure
   *  anywhere before that still releases. */
  let carryGate = false
  /** A failed assertion between `gateSends()` and its release would park the seam FOREVER — and with
   *  it the `ticket.draft` worker whose handler is awaiting it — turning every later scenario into a
   *  timeout on top of the real failure. Idempotent and free otherwise. The fake's call log is
   *  emptied too, so one scenario's Stripe traffic can never satisfy the next. */
  afterEach(() => {
    if (carryGate) carryGate = false
    else releaseSendGate?.()
    fakeStripe.reset()
  })

  const enqueueSendSeam = async (orgId: string, sendId: string): Promise<void> => {
    if (sendGate) await sendGate
    // Collapse the agent's hold window for THIS send only — one row, one column, on the fake clock
    // the send job reads (16 s ahead of it).
    await withOrg(app.db, orgId, (tx) =>
      tx.update(outboundSends).set({ sendAfter: clock.now() }).where(eq(outboundSends.id, sendId)))
    await rawSend(boss, JOB_NAMES.sendExecute, { orgId, sendId })
  }
  const enqueueDraftSeam = async (orgId: string, ticketId: string, opts?: { startAfter?: Date }): Promise<void> => {
    await enqueueTicketDraft(boss, orgId, ticketId, opts?.startAfter ? { startAfter: rebase(opts.startAfter) } : undefined)
  }

  // ---- the managed model, marker-wrapped (seam 4), and the BYOK wire ---------

  const draftScripts: FakeScript[] = []
  const fake = createFakeProvider([], {
    kind: 'anthropic',
    byRole: {
      triage: [{ parsed: TRIAGE_VERDICT, usage: { inputTokens: 1200, outputTokens: 180 } }],
      draft: draftScripts,
    },
  })
  /** Rewrites the tail from the CURRENT call index, so each scenario's scripts are consumed by that
   *  scenario's own calls (`createFakeProvider` repeats the last script once a queue is exhausted). */
  function scriptDraft(...scripts: FakeScript[]): void {
    const at = fake.callsFor('draft').length
    draftScripts.length = at
    draftScripts.push(...scripts.map((s) => ({ usage: { inputTokens: 1200, outputTokens: 180 }, ...s })))
  }
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
          parsed: { ...parsed, usedAnswerIds: resolveIds(parsed.usedAnswerIds), memoryConflictIds: resolveIds(parsed.memoryConflictIds) } as unknown as T,
        }
      },
    } as LlmProvider
  }

  const mock = createMockOpenAi({ mode: 'native', models: [CUSTOM_MODEL], baseUrls: [CUSTOM_BASE], triage: TRIAGE_VERDICT, draft: BYOK_REPLY })

  const push: SendPush = async (msg) => {
    pushCalls.push(msg)
    return { ok: true, invalidTokens: [] }
  }

  function workerConfig(): WorkerConfig {
    return {
      env: 'test',
      databaseUrl: 'unused',
      roles: new Set(['sync', 'agent', 'send', 'knowledge', 'cron']),
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
      stripe: null,
      managedDraftSlots: 0,
      sentryDsn: null,
      sentryEnvironment: 'test',
      platformSender: 'no-reply@aesa.test',
    }
  }

  let knowledgeDeps: KnowledgeDeps
  let retriever: ReturnType<typeof createRetriever>

  beforeAll(async () => {
    t = await createTestDatabase()
    app = createDb(t.url)
    boss = await startBoss(DB_URL, SCHEMA)
    admin = new pg.Client({ connectionString: DB_URL })
    await admin.connect()

    const sink = createMeterSink(app.db)
    const managed = withMetering(answerMarkingProvider(fake), sink, { cacheTtl: '1h' })
    // The REAL resolver, built the way `agent-role.ts` builds it: Managed AI is the marker-wrapped
    // fake, BYOK is the real adapter over the mock wire. One instance for the whole file.
    const providers = createProviderResolver({ db: app.db, ring, managed, sink, logger, fetchFn: mock.fetchFn })

    const limiter = createMailLimiter()
    const clientFactory = (_provider: 'gmail' | 'microsoft', _token: string, addr: string): MockMailbox =>
      mailboxesByAddress.get(addr)!
    const enqueueNotify = (orgId: string, notificationId: string): Promise<void> => enqueueNotifyDispatch(boss, orgId, notificationId)

    // The REAL retriever, over the SAME embedder the knowledge jobs and `memory.capture` write with.
    retriever = createRetriever({ db: app.db, embedder, logger })
    knowledgeDeps = {
      db: app.db, store, embedder, logger, now: clock.now,
      enqueueEmbedBatch: (orgId, documentId) => enqueueKnowledgeEmbedBatch(boss, orgId, documentId),
    }
    await registerKnowledgeIngest(boss, knowledgeDeps)
    await registerKnowledgeEmbedBatch(boss, knowledgeDeps)
    // Seam 6: the queue exists so the stuck sweep's re-enqueue lands; nothing works it.
    await createQueueRetrying(boss, JOB_NAMES.knowledgeCrawl, queueOptionsFor(JOB_NAMES.knowledgeCrawl))

    await registerMailboxSync(boss, { db: app.db, ring, config: workerConfig(), limiter, logger, clientFactory })
    await registerLlmProbe(boss, { db: app.db, ring, sink, logger, resolver: providers, fetchFn: mock.fetchFn, enqueueNotify, now: clock.now })
    await registerTicketTriage(boss, { db: app.db, providers, logger, enqueueNotify, enqueueDraft: enqueueDraftSeam, now: clock.now })
    await registerTicketDraft(boss, {
      db: app.db, providers, retriever, logger, enqueueNotify, enqueueDraft: enqueueDraftSeam, enqueueSend: enqueueSendSeam, now: clock.now,
    })
    await registerMemoryCapture(boss, { db: app.db, embedder, logger, now: clock.now })
    await registerNotifyDispatch(boss, { db: app.db, push, logger, now: clock.now })
    await registerWorkspacePurge(boss, { db: app.db, store, logger, now: clock.now })
    // The production role gate, with the client/provider/clock seams swapped in and the `onSent`
    // seam wired exactly as `index.ts` wires it — every delivered reply really reaches `memory.capture`.
    await maybeRegisterSendRole(
      {
        boss, db: app.db, config: workerConfig(), limiter, logger, enqueueNotify,
        enqueueDraft: enqueueDraftSeam,
        onSent: (p) => enqueueMemoryCapture(boss, p.orgId, p.draftId),
      },
      (b, deps: SendExecuteDeps) =>
        registerSendExecute(b, { ...deps, clientFactory, providerFactory: () => stubProvider(), now: sendClock }),
    )

    // Retry CADENCE only (`e2e-phase3.test.ts`'s note 2): the limits, the queue POLICY and every
    // recovery path are the shipped ones; the production backoffs would just make a transient
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
    const apiEnqueue: EnqueueFn = createEnqueue(boss)
    const dnsStub: Resolver = async () => [{ address: '93.184.216.34', family: 4 }]
    draftService = { api, enqueue: apiEnqueue, logger, now: clock.now }
    billingDeps = {
      api, enqueue: apiEnqueue, logger, stripe: fakeStripe.port, appWebOrigin: 'https://app.test',
      priceDomain: PRICE_DOMAIN, priceOverage: PRICE_OVERAGE, now: clock.now,
    }
    lifecycleDeps = { api, enqueue: apiEnqueue, logger, stripe: fakeStripe.port, store, now: clock.now }
    memoryDeps = { api, enqueue: apiEnqueue, logger, now: clock.now }
    knowledgeService = { api, enqueue: apiEnqueue, store, logger, now: clock.now }
    llmDeps = { api, enqueue: apiEnqueue, logger, resolver: dnsStub, now: clock.now }
  }, 120_000)

  afterAll(async () => {
    await boss.stop({ graceful: false, wait: true })
    await admin.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`)
    await admin.end()
    await app.pool.end()
    await t.drop()
  })

  // ---- fixtures -------------------------------------------------------------

  async function createOrg(opts: { name: string; agentEnabled?: boolean; secondDomain?: boolean }): Promise<Org> {
    const domain = `${opts.name}.test`
    const orgId = await createTestOrganization(app, opts.name)
    const ownerEmail = `owner-${rand()}@example.com`
    const [owner] = await app.db.insert(user).values({ name: 'Owner', email: ownerEmail }).returning({ id: user.id })
    await app.db.insert(member).values({ organizationId: orgId, userId: owner!.id, role: 'owner' })
    const selfAddress = `support-${rand()}@${domain}`
    const businessName = `${opts.name} Dog Supplies`

    const base = await withOrg(app.db, orgId, async (tx) => {
      await tx.insert(workspaces).values({
        orgId, businessName, timezone: 'UTC', locale: 'en',
        description: 'Sells dog beds, leads and bowls online.',
        allowedUrlHosts: [domain], allowedEmailDomains: [domain],
        operatingGuidance: 'Always confirm the order number before quoting a delivery window.',
        agentEnabled: opts.agentEnabled ?? true,
      })
      await provisionOrgKeys(tx, ring)
      await ensureDefaultCategories(tx)
      // What `workspace.create` seeds: the trial row, `trial_ends_at` NULL until the agent goes live.
      await ensureBillingRow(tx)
      const [conn] = await tx.insert(mailboxConnections).values({
        orgId, provider: 'gmail', providerAccountId: `acct-${rand()}`,
        emailAddress: selfAddress, status: 'connected', connectedByUserId: owner!.id,
      }).returning({ id: mailboxConnections.id })
      const [agent] = await tx.insert(agents).values({
        orgId, connectionId: conn!.id, address: selfAddress, domain, displayName: `${opts.name} Support`,
        status: 'active', priority: 0, signature: `${opts.name} Support`,
        guidanceExtra: 'Keep replies to three sentences where you can.',
        autoSendDelayMin: 2,
      }).returning({ id: agents.id })
      if (opts.secondDomain) {
        // A second ACTIVE agent on another domain: `countActiveDomains` (the Checkout's licensed
        // quantity and the nightly quantity sync) counts DISTINCT domains of active agents.
        await tx.insert(agents).values({
          orgId, connectionId: conn!.id, address: `help-${rand()}@${opts.name}-outlet.test`, domain: `${opts.name}-outlet.test`,
          displayName: `${opts.name} Outlet`, status: 'active', priority: 1, signature: `${opts.name} Outlet`, autoSendDelayMin: 2,
        })
      }
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
    const org: Org = { orgId, ...base, selfAddress, domain, businessName, mailbox, ownerUserId: owner!.id, ownerEmail }

    // Seed-on-null: the first sync remembers where to start and ingests nothing.
    await triggerSync(org)
    await waitFor(async () => {
      const [row] = await withOrg(app.db, orgId, (tx) => tx.select().from(mailboxConnections).where(eq(mailboxConnections.id, base.connectionId)))
      expect(row!.cursor).not.toBeNull()
    })
    return org
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
        // Wall clock on purpose: `getAccessToken` judges freshness by the wall clock, and this
        // file runs in minutes.
        accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
        refreshTokenHash: hashToken('refresh', refreshToken),
        encryption: 'dek', dataKeyVersion: version,
      }))
  }

  /**
   * The router's `workspace.setAgentEnabled`, replayed statement for statement against the fake clock
   * (file header): `agent_enabled` on, `agent_enabled_at` COALESCEd, and the trial clock started with
   * the same COALESCE so a later off/on flip could never restart it.
   */
  async function enableAgent(o: Org): Promise<void> {
    const now = clock.now()
    await withOrg(app.db, o.orgId, async (tx) => {
      await tx.update(workspaces)
        .set({ agentEnabled: true, agentEnabledAt: sql`COALESCE(${workspaces.agentEnabledAt}, ${now})` })
        .where(eq(workspaces.orgId, o.orgId))
      await ensureBillingRow(tx)
      await tx.update(billingSubscriptions)
        .set({ trialEndsAt: sql`COALESCE(${billingSubscriptions.trialEndsAt}, ${now}::timestamptz + make_interval(days => ${BILLING_PRICING.trialDays}::int))` })
        .where(eq(billingSubscriptions.orgId, o.orgId))
    })
  }

  const triggerSync = (o: Org): Promise<string | null> =>
    enqueue(boss, mailboxSyncJob, { orgId: o.orgId, connectionId: o.connectionId }, { entityId: o.connectionId })

  const draftActor = (o: Org): DraftActor => ({ userId: o.ownerUserId, actor: `user:${o.ownerUserId}`, source: 'app' })
  const billingActor = (o: Org): BillingActor => ({ userId: o.ownerUserId, actor: `user:${o.ownerUserId}`, email: o.ownerEmail })
  const lifecycleActor = (o: Org): LifecycleActor => ({ userId: o.ownerUserId, actor: `user:${o.ownerUserId}` })
  const memoryActor = (o: Org): MemoryActor => ({ userId: o.ownerUserId, actor: `user:${o.ownerUserId}` })
  const knowledgeActor = (o: Org): KnowledgeActor => ({ userId: o.ownerUserId, actor: `user:${o.ownerUserId}` })
  const llmActor = (o: Org): LlmActor => ({ userId: o.ownerUserId, actor: `user:${o.ownerUserId}` })

  // ---- reads ----------------------------------------------------------------

  const allDrafts = (o: Org) => withOrg(app.db, o.orgId, (tx) => tx.select().from(drafts).where(eq(drafts.orgId, o.orgId)))
  async function getDraft(o: Org, draftId: string) {
    const [row] = await withOrg(app.db, o.orgId, (tx) => tx.select().from(drafts).where(eq(drafts.id, draftId)))
    return row!
  }
  async function getTicket(o: Org, ticketId: string) {
    const [row] = await withOrg(app.db, o.orgId, (tx) => tx.select().from(tickets).where(eq(tickets.id, ticketId)))
    return row!
  }
  async function sendFor(o: Org, draftId: string) {
    const [row] = await withOrg(app.db, o.orgId, (tx) => tx.select().from(outboundSends).where(eq(outboundSends.draftId, draftId)))
    return row!
  }
  const answersFor = (o: Org) =>
    withOrg(app.db, o.orgId, (tx) => tx.select().from(resolvedAnswers).where(eq(resolvedAnswers.orgId, o.orgId)).orderBy(resolvedAnswers.createdAt))
  const messagesFor = (o: Org) =>
    withOrg(app.db, o.orgId, (tx) => tx.select().from(messages).where(eq(messages.orgId, o.orgId)).orderBy(messages.createdAt))
  async function billingRow(o: Org) {
    const [row] = await withOrg(app.db, o.orgId, (tx) => tx.select().from(billingSubscriptions).where(eq(billingSubscriptions.orgId, o.orgId)))
    return row!
  }
  async function workspaceOf(o: Org) {
    const [row] = await withOrg(app.db, o.orgId, (tx) => tx.select().from(workspaces).where(eq(workspaces.orgId, o.orgId)))
    return row
  }
  const notificationsOf = (o: Org, kind: string) =>
    withOrg(app.db, o.orgId, (tx) => tx.select().from(notifications).where(and(eq(notifications.orgId, o.orgId), eq(notifications.kind, kind))).orderBy(notifications.createdAt))
  const auditRowsFor = (o: Org, entityId: string, action: string) =>
    withOrg(app.db, o.orgId, (tx) => tx.select().from(auditLog).where(and(eq(auditLog.entityId, entityId), eq(auditLog.action, action))))
  async function metersFor(o: Org): Promise<Record<string, number>> {
    const rows = await withOrg(app.db, o.orgId, (tx) => tx.select().from(usageCounters).where(eq(usageCounters.orgId, o.orgId)))
    const out: Record<string, number> = {}
    for (const r of rows) out[r.meter] = (out[r.meter] ?? 0) + r.value
    return out
  }
  const maxSourcesFor = (o: Org): Promise<number> =>
    withOrg(app.db, o.orgId, async (tx) => resolveSetting('knowledge.max_sources', await loadSettingSources(tx, ['knowledge.max_sources'], clock.now())))
  const breakdownOf = (draft: { confidenceBreakdown: unknown }): Breakdown => draft.confidenceBreakdown as Breakdown
  const sourcesFor = (o: Org) =>
    withOrg(app.db, o.orgId, (tx) => tx.select().from(knowledgeSources).where(eq(knowledgeSources.orgId, o.orgId)).orderBy(knowledgeSources.createdAt))
  const chunksFor = (o: Org) =>
    withOrg(app.db, o.orgId, (tx) => tx.select({ id: knowledgeChunks.id, documentId: knowledgeChunks.documentId, embeddingModel: knowledgeChunks.embeddingModel, hasVector: sql<boolean>`${knowledgeChunks.embedding} IS NOT NULL` }).from(knowledgeChunks).where(eq(knowledgeChunks.orgId, o.orgId)))
  const documentsFor = (o: Org) =>
    withOrg(app.db, o.orgId, (tx) => tx.select().from(knowledgeDocuments).where(eq(knowledgeDocuments.orgId, o.orgId)))
  /** The count of rows this org holds in every table an org-delete empties — the SAME list the purge
   *  walks (`PURGE_ORDER`) plus `workspaces`, read as the platform role so RLS cannot hide a leak. */
  async function rowCounts(orgId: string): Promise<Record<string, number>> {
    return withPlatform(app.db, 'test:count', async (tx) => {
      const out: Record<string, number> = {}
      for (const table of [...PURGE_ORDER, workspaces]) {
        const name = getTableName(table)
        const res = await tx.execute(sql`SELECT count(*)::int AS n FROM ${sql.identifier(name)} WHERE org_id = ${orgId}`)
        out[name] = Number((res.rows[0] as { n: number }).n)
      }
      return out
    })
  }
  /** pg-boss's OWN job table for this run's schema — the database's record that an enqueue landed. */
  async function jobsFor(queue: string, orgId: string): Promise<{ state: string; data: Record<string, unknown> }[]> {
    const res = await admin.query<{ state: string; data: Record<string, unknown> }>(
      `SELECT state, data FROM "${SCHEMA}".job WHERE name = $1 AND data ->> 'orgId' = $2`, [queue, orgId],
    )
    return res.rows
  }

  // ---- arrangement helpers --------------------------------------------------

  /** One inbound through the REAL sync walk; resolves with the new ticket's id. */
  async function inbound(o: Org, opts: { subject: string; body?: string; from?: string; attachments?: { filename: string; mime: string; size: number }[] }): Promise<string> {
    const before = new Set((await withOrg(app.db, o.orgId, (tx) => tx.select({ id: tickets.id }).from(tickets))).map((r) => r.id))
    o.mailbox.receiveInbound({
      from: opts.from ?? `customer-${rand()}@${CUSTOMER_DOMAIN}`, to: [o.selfAddress], subject: opts.subject,
      bodyText: opts.body ?? CUSTOMER_TEXT, ...(opts.attachments ? { attachments: opts.attachments } : {}),
    })
    await triggerSync(o)
    return waitFor(async () => {
      const rows = await withOrg(app.db, o.orgId, (tx) => tx.select({ id: tickets.id }).from(tickets))
      const fresh = rows.filter((r) => !before.has(r.id))
      expect(fresh).toHaveLength(1)
      return fresh[0]!.id
    })
  }

  /** Inbound → sync → triage → draft, waiting for a NEW draft row of ANY status (an auto landing
   *  writes an `approved` one). */
  async function inboundToDraft(o: Org, opts: { subject: string; body?: string; attachments?: { filename: string; mime: string; size: number }[] }) {
    const before = new Set((await allDrafts(o)).map((r) => r.id))
    const ticketId = await inbound(o, opts)
    const draft = await waitFor(async () => {
      const fresh = (await allDrafts(o)).filter((r) => !before.has(r.id))
      if (fresh.length === 1) return fresh[0]!
      throw new Error(await whyNoDraft(o, ticketId, fresh.length))
    })
    return { ticketId, draft }
  }

  async function whyNoDraft(o: Org, ticketId: string, found: number): Promise<string> {
    const ticket = await getTicket(o, ticketId)
    const lines = logLines.filter((line) => line.includes(ticketId)).slice(-4)
    return `no draft on ticket ${ticketId} (found ${found}); ticket ${ticket.status}/${ticket.needsOwnerReason ?? '-'}\nlog: ${lines.join(' | ')}`
  }

  /** Marks viewed, approves through the real gate, triggers `send.execute` and waits for delivery. */
  async function approveAndSend(o: Org, draftId: string): Promise<string> {
    expect(await markViewed(draftService, o.orgId, draftId, draftActor(o))).toBe(true)
    const approved = await approveDraft(draftService, o.orgId, { draftId }, draftActor(o))
    expect(approved.ok).toBe(true)
    const sendId = (approved as { ok: true; sendId: string }).sendId
    await rawSend(boss, JOB_NAMES.sendExecute, { orgId: o.orgId, sendId })
    await waitFor(async () => {
      expect((await sendFor(o, draftId)).status).toBe('sent')
    })
    return sendId
  }

  /** Owner-decided drafts on an existing ticket, so `countHumanDecisions` reaches the cold-start floor. */
  async function seedHumanDecisions(o: Org, ticketId: string, n: number): Promise<void> {
    const now = clock.now()
    await withOrg(app.db, o.orgId, (tx) =>
      tx.insert(drafts).values(
        Array.from({ length: n }, (_unused, i) => ({
          orgId: o.orgId, ticketId, agentId: o.agentId, categoryId: o.categoryId,
          version: 100 + i, body: CLEAN_BODY, finalBody: CLEAN_BODY,
          confidence: 0.9, modelConfidence: 0.9,
          decision: 'review', decisionReason: 'category_review', status: 'sent',
          threadSnapshotAt: now, expiresAt: new Date(now.getTime() + 30 * DAY_MS),
          decidedBy: o.ownerUserId, decidedAt: now, decisionSource: 'app', editDistanceRatio: 0,
        })),
      ))
  }

  async function setPolicy(o: Org, patch: Partial<typeof agentCategoryPolicies.$inferInsert>): Promise<void> {
    await withOrg(app.db, o.orgId, (tx) =>
      tx.update(agentCategoryPolicies).set(patch)
        .where(and(eq(agentCategoryPolicies.agentId, o.agentId), eq(agentCategoryPolicies.categoryId, o.categoryId))))
  }

  /** ONE active answer in exactly the shape `memory.capture` writes it (scenario 3 proves that write
   *  for real on org A; org C only needs the answer to EXIST). */
  async function seedActiveAnswer(o: Org): Promise<string> {
    const { vectors } = await embedder.embed([QUESTION], 'document')
    return withOrg(app.db, o.orgId, async (tx) => {
      const [row] = await tx.insert(resolvedAnswers).values({
        orgId: o.orgId, agentId: o.agentId, categoryId: o.categoryId,
        questionText: QUESTION, answerBody: CLEAN_BODY,
        questionEmbedding: vectors[0]!, embeddingModel: embedder.model, embeddingVersion: embedder.version,
        status: 'active', approvals: 3, lastApprovedAt: clock.now(),
        expiresAt: new Date(clock.now().getTime() + MEMORY_EXPIRY_DAYS * DAY_MS),
      }).returning({ id: resolvedAnswers.id })
      return row!.id
    })
  }

  /** The REAL Checkout → webhook chain: `startCheckout` (the fake creates the customer and the
   *  session), then the two events Stripe really sends — `checkout.session.completed` with a BARE
   *  subscription id and `payment_status: 'paid'` (R10), then `customer.subscription.updated` with the
   *  items (by price), the licensed quantity and the period. */
  async function subscribe(o: Org, p: { subscriptionId: string; quantity: number; periodStart: Date; periodEnd: Date }): Promise<string> {
    const started = await startCheckout(billingDeps, o.orgId, billingActor(o))
    expect(started.ok).toBe(true)
    const customerId = (await billingRow(o)).stripeCustomerId!
    expect(customerId).toMatch(/^cus_fake_/)
    expect(fakeStripe.callsTo('createCheckoutSession')[0]!.params).toMatchObject({ customerId, orgId: o.orgId, domainQuantity: p.quantity })

    expect(await applyStripeEvent(billingDeps, stripeEvent('checkout.session.completed', {
      customer: customerId, client_reference_id: o.orgId, subscription: p.subscriptionId, payment_status: 'paid',
    }, created()))).toBe('applied')
    expect(await applyStripeEvent(billingDeps, stripeEvent('customer.subscription.updated', subscriptionObject({
      id: p.subscriptionId, customer: customerId, status: 'active', quantity: p.quantity,
      periodStart: Math.floor(p.periodStart.getTime() / 1000), periodEnd: Math.floor(p.periodEnd.getTime() / 1000),
    }), created()))).toBe('applied')
    return customerId
  }

  const subscriptionObject = (p: { id: string; customer: string; status: string; quantity: number; periodStart: number; periodEnd: number }) => ({
    id: p.id, customer: p.customer, status: p.status, cancel_at_period_end: false,
    items: { data: [
      { id: `si_domain_${p.id}`, price: { id: PRICE_DOMAIN }, quantity: p.quantity, current_period_start: p.periodStart, current_period_end: p.periodEnd },
      { id: `si_overage_${p.id}`, price: { id: PRICE_OVERAGE }, current_period_start: p.periodStart, current_period_end: p.periodEnd },
    ] },
  })

  /** Ten short pastes through the REAL knowledge service, waiting for each to be ingested AND embedded. */
  async function paste(o: Org, i: number) {
    return pasteSource(knowledgeService, o.orgId, knowledgeActor(o), { title: `Shipping policy ${i}`, text: pasteText(i) })
  }
  const pasteText = (i: number): string =>
    `Acme shipping policy, section ${i}. Orders ship within two working days and arrive within five. Tracking numbers are emailed the moment a parcel leaves the warehouse.`

  async function waitForEmbedded(o: Org): Promise<void> {
    await waitFor(async () => {
      const sources = (await sourcesFor(o)).filter((s) => s.kind === 'paste')
      expect(sources.every((s) => s.status === 'ready')).toBe(true)
      const docs = await documentsFor(o)
      expect(docs.length).toBe(sources.length)
      expect(docs.every((d) => d.chunkCount > 0 && d.embeddedCount === d.chunkCount)).toBe(true)
    })
  }

  const runReport = () => runBillingReportUsage({
    db: app.db, logger, stripe: fakeStripe.usagePort, now: clock.now,
    enqueueNotify: (orgId, notificationId) => enqueueNotifyDispatch(boss, orgId, notificationId),
  })

  // ---- shared state across the scenarios ------------------------------------

  let orgA: Org
  let orgB: Org
  let orgC: Org
  let subA: string
  let customerA: string
  /** Org A's Stripe period, set by scenario 2's `customer.subscription.updated`. */
  let periodA: { start: Date; end: Date }
  /** Scenario 1's first ticket — the one scenario 4 hangs its seeded human decisions on. */
  let firstTicketA: string
  /** Scenario 3's answer: the one three real approvals teach. */
  let answerA: string
  /** Scenario 4's auto-landed draft, whose queued send scenario 5 holds. */
  let autoDraftA: string
  /** Org B's row counts, taken before the destructive scenarios and re-checked after. */
  let countsB: Record<string, number>

  // ---- 1: the trial clock ----------------------------------------------------

  it('1. the trial clock: a fresh workspace is trialing with no expiry, enabling the agent stamps trial_ends_at = now + 14 d, the first inbound drafts into review (cold start), and 15 days later the next inbound still drafts — decision_reason subscription_inactive, the ticket awaiting_review — while billing reads trial_expired and the nightly pass pages "Your trial has ended" once', async () => {
    orgA = await createOrg({ name: 'acme', agentEnabled: false, secondDomain: true })
    orgB = await createOrg({ name: 'bravo' })

    const fresh = await billingRow(orgA)
    expect(fresh).toMatchObject({ plan: 'trial', status: 'trialing', trialEndsAt: null, domainQuantity: 0, overageMode: 'automatic' })
    expect((await getBilling(billingDeps, orgA.orgId))).toMatchObject({
      plan: 'trial', state: 'trialing', trialEndsAt: null, allowance: BILLING_PRICING.trialIncludedConversations, used: 0,
      hasStripeCustomer: false, hasSubscription: false, configured: true, activeDomains: 2,
    })

    await enableAgent(orgA)
    const enabled = await billingRow(orgA)
    expect(enabled.trialEndsAt).not.toBeNull()
    expect(enabled.trialEndsAt!.getTime() - clock.now().getTime()).toBeGreaterThan(BILLING_PRICING.trialDays * DAY_MS - 5_000)
    expect(enabled.trialEndsAt!.getTime() - clock.now().getTime()).toBeLessThanOrEqual(BILLING_PRICING.trialDays * DAY_MS)
    // A second enable leaves the clock alone (the COALESCE).
    await enableAgent(orgA)
    expect((await billingRow(orgA)).trialEndsAt!.getTime()).toBe(enabled.trialEndsAt!.getTime())
    expect((await workspaceOf(orgA))!.agentEnabled).toBe(true)

    // The order_status category is on Auto from the start, so the FIRST landing is the cold-start
    // lock rather than `category_review` — and that is what scenario 4 later lifts.
    await setPolicy(orgA, { mode: 'auto', autoSendMinConfidence: 80, graduatedAt: clock.now() })
    scriptDraft({ parsed: reply() })
    const first = await inboundToDraft(orgA, { subject: QUESTION, attachments: [{ filename: 'receipt.pdf', mime: 'application/pdf', size: 12_345 }] })
    firstTicketA = first.ticketId
    expect(first.draft.status).toBe('pending')
    expect(first.draft.decision).toBe('review')
    expect(first.draft.decisionReason).toBe('cold_start')
    expect((await getTicket(orgA, first.ticketId)).status).toBe('awaiting_review')
    expect(breakdownOf(first.draft).blockers).toMatchObject({ coldStart: true, subscription: 'trialing', allowance: { used: 0, allowance: 50, exhausted: false } })

    // Org B, the control, gets one conversation of its own before anything destructive happens.
    scriptDraft({ parsed: reply() })
    const bDraft = await inboundToDraft(orgB, { subject: QUESTION })
    expect(bDraft.draft.decisionReason).toBe('category_review')

    clock.advanceDays(15)

    expect((await getBilling(billingDeps, orgA.orgId)).state).toBe('trial_expired')
    scriptDraft({ parsed: reply() })
    const expired = await inboundToDraft(orgA, { subject: `${QUESTION} (trial over)` })
    expect(expired.draft.status).toBe('pending')
    expect(expired.draft.decision).toBe('review')
    expect(expired.draft.decisionReason).toBe('subscription_inactive')
    expect(breakdownOf(expired.draft).blockers.subscription).toBe('trial_expired')
    expect((await getTicket(orgA, expired.ticketId)).status).toBe('awaiting_review')
    // The stored status never moves — `trial_expired` is derived, and the clock alone decides.
    expect((await billingRow(orgA)).status).toBe('trialing')

    // The nightly pass needs no Stripe for this: ONE page, ever, keyed `billing:trial_ended:<org>`.
    const report = await runReport()
    expect(report).toMatchObject({ reported: 0, quantitySynced: 0, trialNotices: 1, skipped: 0 })
    const pages = await notificationsOf(orgA, 'billing')
    expect(pages).toHaveLength(1)
    expect(pages[0]).toMatchObject({ title: 'Your trial has ended', dedupeKey: `billing:trial_ended:${orgA.orgId}` })
    expect((await runReport()).trialNotices).toBe(0)
    await waitFor(async () => {
      expect((await notificationsOf(orgA, 'billing'))[0]!.status).toBe('sent')
    })
    expect(fakeStripe.calls).toHaveLength(0)
  }, 240_000)

  // ---- 2: checkout → the caps rise the same day ------------------------------

  it('2. Checkout → caps rise the same day: startCheckout creates the customer and a 2-domain session, checkout.session.completed (paid) lands plan standard/active and the subscription.updated that follows lands quantity 2, item ids by price and the period — allowance 600 — and knowledge.max_sources resolves 100 where the trial refused an 11th paste at 10', async () => {
    // On the trial the REAL paste path admits ten sources and refuses the eleventh.
    for (let i = 1; i <= 10; i += 1) expect((await paste(orgA, i)).ok).toBe(true)
    expect(await maxSourcesFor(orgA)).toBe(10)
    expect(await paste(orgA, 11)).toMatchObject({ ok: false, code: 'forbidden_cap' })

    periodA = { start: new Date(clock.now().getTime() - DAY_MS), end: new Date(clock.now().getTime() + 29 * DAY_MS) }
    subA = `sub_${rand()}`
    customerA = await subscribe(orgA, { subscriptionId: subA, quantity: 2, periodStart: periodA.start, periodEnd: periodA.end })

    const row = await billingRow(orgA)
    expect(row).toMatchObject({
      plan: 'standard', status: 'active', stripeCustomerId: customerA, stripeSubscriptionId: subA,
      stripeDomainItemId: `si_domain_${subA}`, stripeOverageItemId: `si_overage_${subA}`, domainQuantity: 2,
      includedConversationsPerDomain: BILLING_PRICING.includedPerDomain,
    })
    expect(row.currentPeriodStart!.getTime()).toBe(Math.floor(periodA.start.getTime() / 1000) * 1000)
    expect(row.lastStripeEventCreated).not.toBeNull()
    expect(await getBilling(billingDeps, orgA.orgId)).toMatchObject({
      plan: 'standard', state: 'active', allowance: 600, domainQuantity: 2, activeDomains: 2, hasSubscription: true, used: 0,
    })
    expect(await auditRowsFor(orgA, orgA.orgId, 'billing.checkout_started')).toHaveLength(1)
    expect(await auditRowsFor(orgA, orgA.orgId, 'billing.subscription_activated')).toHaveLength(1)
    expect(await auditRowsFor(orgA, orgA.orgId, 'billing.subscription_updated')).toHaveLength(1)

    // The plan's defaults follow the row the same instant: the eleventh paste now lands.
    expect(await maxSourcesFor(orgA)).toBe(100)
    expect((await paste(orgA, 11)).ok).toBe(true)
    await waitForEmbedded(orgA)
    expect((await sourcesFor(orgA)).filter((s) => s.status === 'ready')).toHaveLength(11)
  }, 240_000)

  // ---- 3: conversation 301 ---------------------------------------------------

  it('3. conversation 601 of 600: four real sends through completeSend count on the MANAGED meter (and teach one answer), the rest of the allowance is seeded straight onto the meter, the nightly pass reports nothing at 600, exactly ONE unit as the delta at 601 with identifier <org>:<periodStartIso>:1 and moves the watermark, and a re-run reports nothing again', async () => {
    const day = utcDay(clock.now())

    // --- four REAL conversations. The first send teaches an answer (`memory.capture`); the next
    // three reuse it through the marker (seam 4), so the fixture scenario 4 needs — three learned
    // approvals — is built for real rather than seeded.
    scriptDraft({ parsed: reply() })
    const one = await inboundToDraft(orgA, { subject: `${QUESTION} (1)` })
    expect(one.draft.decisionReason).toBe('cold_start')
    expect(breakdownOf(one.draft).blockers).toMatchObject({ subscription: 'active', allowance: { used: 0, allowance: 600, mode: 'automatic', exhausted: false } })
    await approveAndSend(orgA, one.draft.id)
    const [taught] = await waitFor(async () => {
      const rows = await answersFor(orgA)
      expect(rows).toHaveLength(1)
      return rows
    })
    answerA = taught!.id
    expect(taught).toMatchObject({ status: 'active', approvals: 1, sourceDraftId: one.draft.id, embeddingModel: 'hash-v1' })

    for (const round of [2, 3] as const) {
      scriptDraft({ parsed: reply({ usedAnswerIds: [`${USE}${ANSWER_NEEDLE}`] }) })
      const draft = (await inboundToDraft(orgA, { subject: `${QUESTION} (${round})` })).draft
      expect(draft.usedAnswerIds).toEqual([answerA])
      expect(draft.decisionReason).toBe('cold_start')
      await approveAndSend(orgA, draft.id)
      await waitFor(async () => {
        expect((await answersFor(orgA))[0]!.approvals).toBe(round)
      })
    }
    expect(await answersFor(orgA)).toHaveLength(1)
    expect((await metersFor(orgA))[SEND_METERS.aiHandledManaged]).toBe(3)
    expect((await metersFor(orgA))[SEND_METERS.aiHandledConversations]).toBe(3)
    expect((await metersFor(orgA))[SEND_METERS.reviewSends]).toBe(3)
    expect(await withOrg(app.db, orgA.orgId, (tx) => countHumanDecisions(tx, orgA.agentId, orgA.categoryId))).toBe(3)

    // --- THE SHORTCUT: 597 more managed conversations, written straight onto the meter
    // `completeSend` bumps (the same `bumpMeter`, the same meter name, the same period day). Each of
    // those would otherwise be an inbound, a triage call, a draft call, an approve and a send.
    await withOrg(app.db, orgA.orgId, (tx) => bumpMeter(tx, orgA.orgId, day, SEND_METERS.aiHandledManaged, 597))
    expect((await getBilling(billingDeps, orgA.orgId))).toMatchObject({ used: 600, allowance: 600, overageUnits: 0 })

    // At exactly the allowance nothing is owed: no meter event, no quantity sync (2 == 2), no page.
    expect(await runReport()).toMatchObject({ reported: 0, quantitySynced: 0, trialNotices: 0, skipped: 0 })
    expect(fakeStripe.calls).toHaveLength(0)
    expect((await billingRow(orgA))).toMatchObject({ overageReported: 0, overageReportedPeriodStart: null })

    // --- the 601st: one more REAL conversation, approved and sent.
    scriptDraft({ parsed: reply({ usedAnswerIds: [`${USE}${ANSWER_NEEDLE}`] }) })
    const fourth = (await inboundToDraft(orgA, { subject: `${QUESTION} (4)` })).draft
    expect(fourth.usedAnswerIds).toEqual([answerA])
    await approveAndSend(orgA, fourth.id)
    expect((await getBilling(billingDeps, orgA.orgId))).toMatchObject({ used: 601, overageUnits: 1 })

    const periodStartIso = new Date(Math.floor(periodA.start.getTime() / 1000) * 1000).toISOString()
    expect(await runReport()).toMatchObject({ reported: 1, quantitySynced: 0, skipped: 0 })
    expect(fakeStripe.calls).toHaveLength(1)
    expect(fakeStripe.callsTo('reportOverage')[0]!.params).toEqual({ customerId: customerA, value: 1, identifier: `${orgA.orgId}:${periodStartIso}:1` })
    const reported = await billingRow(orgA)
    expect(reported.overageReported).toBe(1)
    expect(reported.overageReportedPeriodStart!.toISOString()).toBe(periodStartIso)
    const audits = await auditRowsFor(orgA, orgA.orgId, 'billing.overage_reported')
    expect(audits).toHaveLength(1)
    expect(audits[0]!.detail).toMatchObject({ used: 601, allowance: 600, delta: 1, total: 1, identifier: `${orgA.orgId}:${periodStartIso}:1` })

    // Nothing changed → nothing reported: the watermark is what makes the pass idempotent.
    expect(await runReport()).toMatchObject({ reported: 0 })
    expect(fakeStripe.calls).toHaveLength(1)
    expect((await billingRow(orgA)).overageReported).toBe(1)

    // The answer the three reuses reinforced, ready for scenario 4.
    await waitFor(async () => {
      expect((await answersFor(orgA))[0]!.approvals).toBe(4)
    })
    expect(await withOrg(app.db, orgA.orgId, (tx) => countHumanDecisions(tx, orgA.agentId, orgA.categoryId))).toBe(4)
  }, 240_000)

  // ---- 4: blocked vs automatic -------------------------------------------------

  it('4. blocked vs automatic at 601 of 600: with the cold-start floor met and a learned answer behind it, an auto-eligible draft under blocked overage lands review/allowance_exhausted (and the nightly pass pages "Included conversations used up" once); setOverageMode(automatic) → the next lands send — an approved auto draft, a queued send, the ticket on auto_sending', async () => {
    await seedHumanDecisions(orgA, firstTicketA, 6)
    expect(await withOrg(app.db, orgA.orgId, (tx) => countHumanDecisions(tx, orgA.agentId, orgA.categoryId))).toBe(10)

    expect(await setOverageMode(billingDeps, orgA.orgId, { mode: 'blocked' }, billingActor(orgA))).toEqual({ ok: true })
    expect((await billingRow(orgA)).overageMode).toBe('blocked')

    scriptDraft({ parsed: reply({ usedAnswerIds: [`${USE}${ANSWER_NEEDLE}`] }) })
    const blocked = await inboundToDraft(orgA, { subject: `${QUESTION} (blocked)` })
    expect(blocked.draft.status).toBe('pending')
    expect(blocked.draft.decision).toBe('review')
    expect(blocked.draft.decisionReason).toBe('allowance_exhausted')
    expect((await getTicket(orgA, blocked.ticketId)).status).toBe('awaiting_review')
    const b = breakdownOf(blocked.draft)
    expect(b.memory).toMatchObject({ answerId: answerA, approvals: 4 })
    expect(b.evidence).toBeCloseTo(0.9, 10)
    expect(b.threshold).toBeCloseTo(0.8, 10)
    expect(b.blockers).toMatchObject({ coldStart: false, subscription: 'active', allowance: { used: 601, allowance: 600, mode: 'blocked', exhausted: true } })
    expect(await withOrg(app.db, orgA.orgId, (tx) => tx.select().from(outboundSends).where(eq(outboundSends.draftId, blocked.draft.id)))).toHaveLength(0)

    // R11: the page follows the SAME predicate that stopped the send. Once per period, no Stripe.
    expect(await runReport()).toMatchObject({ reported: 0, trialNotices: 1 })
    expect(fakeStripe.calls).toHaveLength(0)
    const page = (await notificationsOf(orgA, 'billing')).find((n) => n.title === 'Included conversations used up')!
    expect(page.dedupeKey).toBe(`billing:allowance:${orgA.orgId}:${(await billingRow(orgA)).currentPeriodStart!.toISOString()}`)
    expect(page.body).toContain('all 600 included conversations')
    expect(await runReport()).toMatchObject({ trialNotices: 0 })

    expect(await setOverageMode(billingDeps, orgA.orgId, { mode: 'automatic' }, billingActor(orgA))).toEqual({ ok: true })
    gateSends()
    scriptDraft({ parsed: reply({ usedAnswerIds: [`${USE}${ANSWER_NEEDLE}`] }) })
    const auto = await inboundToDraft(orgA, { subject: `${QUESTION} (automatic)` })
    autoDraftA = auto.draft.id
    expect(auto.draft.status).toBe('approved')
    expect(auto.draft.decision).toBe('send')
    expect(auto.draft.decisionReason).toBe('ok')
    expect(auto.draft.decisionSource).toBe('auto')
    expect(auto.draft.decidedBy).toBeNull()
    expect(breakdownOf(auto.draft).blockers).toMatchObject({ allowance: { used: 601, allowance: 600, mode: 'automatic', exhausted: false } })
    const queued = await sendFor(orgA, auto.draft.id)
    expect(queued.status).toBe('queued')
    expect(queued.sendAfter.getTime() - clock.now().getTime()).toBeGreaterThan(90_000)   // the 2-minute hold window
    expect((await getTicket(orgA, auto.ticketId)).status).toBe('auto_sending')
    expect(orgA.mailbox.sentMessages().at(-1)?.markerDraftId).not.toBe(auto.draft.id)
    // Parked, deliberately: scenario 5 applies the failed payment BEFORE this send runs, and is the
    // one that releases the gate. Last statement on purpose — see `carryGate`.
    carryGate = true
  }, 240_000)

  // ---- 5: unpaid suspends auto-send, not approvals ------------------------------

  it('5. invoice.payment_failed → past_due and ONE "Payment failed" page; the queued auto send then HOLDS on subscription_inactive; an owner-approved review draft still goes out and the mailbox has it; a foreign invoice.paid is ignored and the row\'s own brings it back to active', async () => {
    const sentBefore = orgA.mailbox.sentMessages().length
    expect(await applyStripeEvent(billingDeps, stripeEvent('invoice.payment_failed', {
      customer: customerA, parent: { subscription_details: { subscription: subA } },
    }, created()))).toBe('applied')
    expect((await billingRow(orgA))).toMatchObject({ status: 'past_due', plan: 'standard' })
    expect((await getBilling(billingDeps, orgA.orgId)).state).toBe('past_due')
    const failed = (await notificationsOf(orgA, 'billing')).find((n) => n.title === 'Payment failed')!
    expect(failed.dedupeKey).toBe(`billing:past_due:${orgA.orgId}:${utcDay(clock.now())}`)
    await waitFor(async () => {
      expect((await notificationsOf(orgA, 'billing')).find((n) => n.id === failed.id)!.status).toBe('sent')
    })

    // The parked auto send meets the eighth lever.
    releaseSendGate?.()
    await waitFor(async () => {
      expect((await sendFor(orgA, autoDraftA)).status).toBe('held')
    })
    const held = await sendFor(orgA, autoDraftA)
    expect(held.lastError).toBe('held:subscription_inactive')
    expect((await getDraft(orgA, autoDraftA)).status).toBe('held')
    const holdPage = (await notificationsOf(orgA, 'escalation')).find((n) => n.dedupeKey?.startsWith(`send_held:${held.id}:`))!
    expect(holdPage.title).toBe('Reply on hold — the workspace has no active subscription')
    expect(await auditRowsFor(orgA, held.id, 'send.held')).toHaveLength(1)
    expect(orgA.mailbox.sentMessages()).toHaveLength(sentBefore)

    // The owner's own decision is not billing's to block: a review draft, approved, is delivered.
    scriptDraft({ parsed: reply({ usedAnswerIds: [`${USE}${ANSWER_NEEDLE}`] }) })
    const review = await inboundToDraft(orgA, { subject: `${QUESTION} (past due)` })
    expect(review.draft.decision).toBe('review')
    expect(review.draft.decisionReason).toBe('subscription_inactive')
    await approveAndSend(orgA, review.draft.id)
    expect(orgA.mailbox.sentMessages()).toHaveLength(sentBefore + 1)
    expect(orgA.mailbox.sentMessages().at(-1)!.markerDraftId).toBe(review.draft.id)
    expect((await getTicket(orgA, review.ticketId)).status).toBe('waiting_on_customer')
    expect((await metersFor(orgA))[SEND_METERS.aiHandledManaged]).toBe(602)

    // The card is fixed: the `invoice.paid` for the row's OWN subscription brings it back to active;
    // one for somebody else's subscription on the same customer is ignored, never applied.
    const foreign = { customer: customerA, parent: { subscription_details: { subscription: `sub_${rand()}` } } }
    expect(await applyStripeEvent(billingDeps, stripeEvent('invoice.paid', foreign, created()))).toBe('ignored')
    expect((await billingRow(orgA)).status).toBe('past_due')
    expect(logged('stripe.invoice_for_another_subscription').filter((l) => l.includes(orgA.orgId))).toHaveLength(1)
    expect(await applyStripeEvent(billingDeps, stripeEvent('invoice.paid', {
      customer: customerA, parent: { subscription_details: { subscription: subA } },
    }, created()))).toBe('applied')
    expect((await billingRow(orgA))).toMatchObject({ status: 'active', plan: 'standard' })
    expect((await getBilling(billingDeps, orgA.orgId)).state).toBe('active')
    // The held send stays held — a lever landing is the owner's to resume, not billing's to undo.
    expect((await sendFor(orgA, autoDraftA)).status).toBe('held')
  }, 240_000)

  // ---- 6: downgrade ------------------------------------------------------------

  it('6. customer.subscription.deleted → canceled, plan trial, knowledge.max_sources back to 10 the same instant; a BYOK agent (a credential added through the Phase 6 path and probed by the real job) still drafts and still never counts toward the allowance', async () => {
    expect(await applyStripeEvent(billingDeps, stripeEvent('customer.subscription.deleted', subscriptionObject({
      id: subA, customer: customerA, status: 'canceled', quantity: 2,
      periodStart: Math.floor(periodA.start.getTime() / 1000), periodEnd: Math.floor(periodA.end.getTime() / 1000),
    }), created()))).toBe('applied')
    expect((await billingRow(orgA))).toMatchObject({ status: 'canceled', plan: 'trial', cancelAtPeriodEnd: false, stripeSubscriptionId: subA })
    expect(await getBilling(billingDeps, orgA.orgId)).toMatchObject({ plan: 'trial', state: 'canceled', allowance: BILLING_PRICING.trialIncludedConversations })
    expect(await maxSourcesFor(orgA)).toBe(10)
    expect(await paste(orgA, 12)).toMatchObject({ ok: false, code: 'forbidden_cap' })

    // The Phase 6 path: the owner pastes a key, the api seals it, the worker probes and stores it.
    const added = await addCredential(llmDeps, orgA.orgId, {
      provider: 'custom', label: 'Local qwen', apiKey: CUSTOM_KEY, baseUrl: CUSTOM_BASE, probeModel: CUSTOM_MODEL,
    }, llmActor(orgA))
    expect(added.ok).toBe(true)
    const credentialId = (added as { ok: true; credentialId: string }).credentialId
    await waitFor(async () => {
      const [row] = await withOrg(app.db, orgA.orgId, (tx) => tx.select().from(llmCredentials).where(eq(llmCredentials.id, credentialId)))
      expect(row!.healthStatus).toBe('healthy')
    })
    expect(await setAgentModel(llmDeps, orgA.orgId, {
      agentId: orgA.agentId, mode: 'byok', credentialId, draftModel: CUSTOM_MODEL, triageModel: CUSTOM_MODEL, effort: null, fallbackToManaged: false,
    }, llmActor(orgA))).toMatchObject({ ok: true })

    const managedBefore = (await metersFor(orgA))[SEND_METERS.aiHandledManaged]
    const usedBefore = (await getBilling(billingDeps, orgA.orgId)).used
    const requestsBefore = mock.requests.length
    const byok = await inboundToDraft(orgA, { subject: `${QUESTION} (byok)` })
    expect(byok.draft.status).toBe('pending')
    expect(byok.draft.decisionReason).toBe('subscription_inactive')
    expect(breakdownOf(byok.draft)).toMatchObject({ mode: 'byok', provider: 'custom', blockers: { subscription: 'canceled', allowance: { exhausted: false } } })
    expect(mock.requests.length).toBeGreaterThan(requestsBefore)
    const calls = await withOrg(app.db, orgA.orgId, (tx) => tx.select().from(llmCalls).where(and(eq(llmCalls.orgId, orgA.orgId), eq(llmCalls.credentialId, credentialId))))
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.every((c) => c.mode === 'byok')).toBe(true)

    await approveAndSend(orgA, byok.draft.id)
    const meters = await metersFor(orgA)
    expect(meters[SEND_METERS.aiHandledConversations]).toBe(6)
    expect(meters[SEND_METERS.aiHandledManaged]).toBe(managedBefore)      // 602, unchanged
    expect((await getBilling(billingDeps, orgA.orgId)).used).toBe(usedBefore)
  }, 240_000)

  // ---- 7: retention ------------------------------------------------------------

  it('7. retention: with retention_days at 30 and the clock 31 days on, every message body and every TERMINAL draft body of org A is nulled — subjects, attachment metadata, timestamps and the live drafts stay — while org B at its 180-day default keeps every body', async () => {
    expect(await setRetentionDays(lifecycleDeps, orgA.orgId, 30, lifecycleActor(orgA))).toEqual({ retentionDays: 30 })
    expect((await workspaceOf(orgA))!.retentionDays).toBe(30)

    const messagesA = await messagesFor(orgA)
    const messagesB = await messagesFor(orgB)
    expect(messagesA.length).toBeGreaterThan(5)
    expect(messagesA.every((m) => m.bodyText !== null && m.bodyPurgedAt === null)).toBe(true)
    const withAttachment = messagesA.find((m) => (m.attachments as unknown[]).length > 0)!
    expect(withAttachment.attachments).toEqual([{ filename: 'receipt.pdf', mime: 'application/pdf', size: 12_345 }])
    const draftsA = await allDrafts(orgA)
    const terminal = draftsA.filter((d) => ['sent', 'rejected', 'expired', 'superseded', 'failed'].includes(d.status))
    const live = draftsA.filter((d) => !['sent', 'rejected', 'expired', 'superseded', 'failed'].includes(d.status))
    expect(terminal.length).toBeGreaterThan(5)
    expect(live.length).toBeGreaterThan(1)     // scenario 1's two pending drafts, scenario 5's held one

    clock.advanceDays(31)
    const result = await runRetentionSweep({ db: app.db, logger, now: clock.now })
    expect(result).toMatchObject({ orgs: 2, messagesPurged: messagesA.length, draftsPurged: terminal.length, llmCallsDeleted: 0, notificationsDeleted: 0, auditDeleted: 0 })

    const purged = await messagesFor(orgA)
    expect(purged).toHaveLength(messagesA.length)
    for (const [i, m] of purged.entries()) {
      expect(m.bodyText).toBeNull()
      expect(m.bodyPurgedAt).not.toBeNull()
      // The ticket list keeps reading: the subject, the sender, the attachment metadata, the dates.
      expect(m.subject).toBe(messagesA[i]!.subject)
      expect(m.fromAddress).toBe(messagesA[i]!.fromAddress)
      expect(m.attachments).toEqual(messagesA[i]!.attachments)
      expect(m.sentAt?.getTime()).toBe(messagesA[i]!.sentAt?.getTime())
    }
    for (const d of await allDrafts(orgA)) {
      const wasTerminal = terminal.some((x) => x.id === d.id)
      if (wasTerminal) {
        expect(d.body).toBe('')
        expect(d.finalBody).toBeNull()
        expect(d.bodyPurgedAt).not.toBeNull()
      } else {
        // `send.execute` still reads `final_body` off a live draft — never touched.
        expect(d.body).toBe(CLEAN_BODY)
        expect(d.bodyPurgedAt).toBeNull()
      }
    }
    // One audit row per org per arm.
    expect(await auditRowsFor(orgA, orgA.orgId, 'retention.purged')).toHaveLength(2)
    // The control: nothing of B's is old enough at its own setting.
    expect((await messagesFor(orgB)).every((m) => m.bodyText !== null && m.bodyPurgedAt === null)).toBe(true)
    expect((await messagesFor(orgB)).length).toBe(messagesB.length)
    // A second pass re-derives its work list from the stamp and purges nothing.
    expect(await runRetentionSweep({ db: app.db, logger, now: clock.now })).toMatchObject({ messagesPurged: 0, draftsPurged: 0 })
    // A purged reply has nothing left to remember.
    const sentReply = purged.find((m) => m.direction === 'outbound')!
    expect(await rememberReply(memoryDeps, orgA.orgId, sentReply.id, memoryActor(orgA))).toEqual({ ok: false, code: 'empty' })
  }, 240_000)

  // ---- 8: delete with grace ----------------------------------------------------

  it('8. delete with grace: on a live subscription requestDeletion cancels it at Stripe, flips the kill switch and holds the queued auto send on workspace_kill_switch; 31 days later the purge sweep enqueues the job, which empties every PURGE_ORDER table, the workspace, the organization and the bucket object — and orgs A and B keep every row', async () => {
    orgC = await createOrg({ name: 'charlie' })
    await enableAgent(orgC)
    const subC = `sub_${rand()}`
    await subscribe(orgC, { subscriptionId: subC, quantity: 1, periodStart: new Date(clock.now().getTime() - DAY_MS), periodEnd: new Date(clock.now().getTime() + 29 * DAY_MS) })
    expect((await billingRow(orgC))).toMatchObject({ plan: 'standard', status: 'active', stripeSubscriptionId: subC })

    // Make C worth purging: a paste (document + chunks), an upload whose bytes sit in the store, a
    // provider connection (credential + platform-only secret + probe calls), a model config, a
    // setting, a token — beside everything the conversation below writes.
    expect((await paste(orgC, 1)).ok).toBe(true)
    await waitForEmbedded(orgC)
    const uploadSourceId = randomUUID()
    const objectKey = uploadKey(orgC.orgId, uploadSourceId, 'catalogue.pdf')
    await store.put(objectKey, Buffer.from('%PDF-1.4 catalogue'), 'application/pdf')
    await withOrg(app.db, orgC.orgId, async (tx) => {
      await tx.insert(knowledgeSources).values({ id: uploadSourceId, orgId: orgC.orgId, kind: 'upload', status: 'queued', title: 'Catalogue', storageKey: objectKey, mime: 'application/pdf', byteSize: 18 })
      await tx.insert(orgSettings).values({ orgId: orgC.orgId, key: 'guidance.daily_suggest_cap', value: 5 })
    })
    const added = await addCredential(llmDeps, orgC.orgId, { provider: 'custom', label: 'Spare key', apiKey: CUSTOM_KEY, baseUrl: CUSTOM_BASE, probeModel: CUSTOM_MODEL }, llmActor(orgC))
    expect(added.ok).toBe(true)
    await waitFor(async () => {
      const [row] = await withOrg(app.db, orgC.orgId, (tx) => tx.select().from(llmCredentials).where(eq(llmCredentials.orgId, orgC.orgId)))
      expect(row!.healthStatus).toBe('healthy')
    })
    expect(await setAgentModel(llmDeps, orgC.orgId, { agentId: orgC.agentId, mode: 'managed', credentialId: null, draftModel: null, triageModel: null, effort: null, fallbackToManaged: false }, llmActor(orgC))).toMatchObject({ ok: true })

    // The Phase 5 fixture on C: Auto, ten human decisions, one three-approval answer → an auto landing, parked.
    scriptDraft({ parsed: reply() })
    const seedTicket = await inboundToDraft(orgC, { subject: QUESTION })
    await withOrg(app.db, orgC.orgId, (tx) => tx.insert(draftActionTokens).values({ orgId: orgC.orgId, draftId: seedTicket.draft.id, userId: orgC.ownerUserId, tokenHash: `tok-${rand()}`, expiresAt: new Date(clock.now().getTime() + DAY_MS) }))
    await seedHumanDecisions(orgC, seedTicket.ticketId, 10)
    await setPolicy(orgC, { mode: 'auto', autoSendMinConfidence: 80, graduatedAt: clock.now() })
    await seedActiveAnswer(orgC)
    const release = gateSends()
    scriptDraft({ parsed: reply({ usedAnswerIds: [`${USE}${ANSWER_NEEDLE}`] }) })
    const auto = await inboundToDraft(orgC, { subject: `${QUESTION} (auto)` })
    expect(auto.draft.decisionSource).toBe('auto')
    expect((await sendFor(orgC, auto.draft.id)).status).toBe('queued')

    const before = await rowCounts(orgC.orgId)
    for (const table of ['workspaces', 'billing_subscriptions', 'org_data_keys', 'agents', 'categories', 'agent_category_policies', 'mailbox_connections', 'mailbox_credentials',
      'tickets', 'messages', 'drafts', 'agent_runs', 'agent_run_events', 'llm_calls', 'outbound_sends', 'resolved_answers', 'knowledge_sources', 'knowledge_documents', 'knowledge_chunks',
      'llm_credentials', 'llm_credential_secrets', 'agent_model_config', 'org_settings', 'draft_action_tokens', 'notification_devices', 'usage_counters', 'audit_log']) {
      expect(before[table], table).toBeGreaterThan(0)
    }
    const countsA = await rowCounts(orgA.orgId)
    countsB = await rowCounts(orgB.orgId)

    // --- the request. Wrong name → nothing happens; the right name → Stripe first, then ONE transaction.
    expect(await requestDeletion(lifecycleDeps, orgC.orgId, 'Charlie', lifecycleActor(orgC))).toEqual({ ok: false, code: 'confirm_mismatch' })
    expect(fakeStripe.callsTo('cancelSubscription')).toHaveLength(0)
    const requested = await requestDeletion(lifecycleDeps, orgC.orgId, orgC.businessName, lifecycleActor(orgC))
    expect(requested).toMatchObject({ ok: true, subscriptionCancelled: true })
    expect(fakeStripe.callsTo('cancelSubscription')).toEqual([{ method: 'cancelSubscription', params: { subscriptionId: subC } }])
    const ws = (await workspaceOf(orgC))!
    expect(ws.killSwitch).toBe(true)
    expect(ws.agentEnabled).toBe(false)
    expect(ws.deletionRequestedAt).not.toBeNull()
    expect(ws.deletionRequestedBy).toBe(orgC.ownerUserId)
    expect((requested as { ok: true; purgeAfter: Date }).purgeAfter.getTime()).toBe(ws.deletionRequestedAt!.getTime() + WORKSPACE_DELETE_GRACE_DAYS * DAY_MS)
    expect(await requestDeletion(lifecycleDeps, orgC.orgId, orgC.businessName, lifecycleActor(orgC))).toEqual({ ok: false, code: 'deletion_pending' })
    const scheduled = (await notificationsOf(orgC, 'workspace'))[0]!
    expect(scheduled.title).toBe('Workspace deletion scheduled')
    expect(scheduled.body).toContain('Your subscription has already been cancelled')

    release()
    await waitFor(async () => {
      expect((await sendFor(orgC, auto.draft.id)).status).toBe('held')
    })
    expect((await sendFor(orgC, auto.draft.id)).lastError).toBe('held:workspace_kill_switch')
    expect((await getDraft(orgC, auto.draft.id)).status).toBe('held')
    expect(orgC.mailbox.sentMessages()).toHaveLength(0)

    // --- the grace period. Too early: the sweep finds nothing.
    expect(await runWorkspacePurgeSweep(boss, { db: app.db, logger, now: clock.now })).toEqual({ enqueued: 0 })
    clock.advanceDays(31)
    expect(await runWorkspacePurgeSweep(boss, { db: app.db, logger, now: clock.now })).toEqual({ enqueued: 1 })
    await waitFor(async () => {
      expect(await workspaceOf(orgC)).toBeUndefined()
    })

    const after = await rowCounts(orgC.orgId)
    for (const [table, n] of Object.entries(after)) expect(n, table).toBe(0)
    expect(await app.db.select({ id: organization.id }).from(organization).where(eq(organization.id, orgC.orgId))).toHaveLength(0)
    expect(await app.db.select({ id: member.userId }).from(member).where(eq(member.organizationId, orgC.orgId))).toHaveLength(0)
    expect(store.objects.has(objectKey)).toBe(false)
    // The platform keeps the one fact that the purge happened — an `org_id NULL` row, numbers only.
    const record = await withPlatform(app.db, 'test:read', (tx) => tx.select().from(auditLog).where(and(eq(auditLog.action, 'workspace.purged'), eq(auditLog.entityId, orgC.orgId))))
    expect(record).toHaveLength(1)
    expect(record[0]!.orgId).toBeNull()
    expect(record[0]!.detail).toMatchObject({ objectsDeleted: 1, objectsFailed: 0, objectsForeign: 0 })
    expect((record[0]!.detail as { rows: Record<string, number> }).rows).toMatchObject({ tickets: before.tickets, messages: before.messages, drafts: before.drafts, workspaces: 1 })
    expect(logged('purge_failed')).toHaveLength(0)
    expect(await jobsFor(JOB_NAMES.workspacePurge, orgC.orgId)).toHaveLength(1)

    // The workspaces beside it: every table, the same count as before.
    expect(await rowCounts(orgA.orgId)).toEqual(countsA)
    expect(await rowCounts(orgB.orgId)).toEqual(countsB)
    expect(await workspaceOf(orgB)).toBeDefined()
  }, 240_000)

  // ---- 9: rotate ---------------------------------------------------------------

  it('9. rotate: an org provisioned under KEK v1 holds a mailbox credential and a BYOK key; keys.rotate under the same ring with v2 active re-wraps the DEK alone (kek_version 1 → 2, one audit row, "current" on a re-run), a replica without v2 can no longer open it, and ticket.draft (the BYOK key) and send.execute (the mailbox credential) both still succeed', async () => {
    const orgD = await createOrg({ name: 'delta' })
    await enableAgent(orgD)
    const [provisioned] = await withOrg(app.db, orgD.orgId, (tx) => tx.select().from(orgDataKeys))
    expect(provisioned!.kekVersion).toBe(1)

    const added = await addCredential(llmDeps, orgD.orgId, { provider: 'custom', label: 'Local qwen', apiKey: CUSTOM_KEY, baseUrl: CUSTOM_BASE, probeModel: CUSTOM_MODEL }, llmActor(orgD))
    expect(added.ok).toBe(true)
    const credentialId = (added as { ok: true; credentialId: string }).credentialId
    await waitFor(async () => {
      const [row] = await withOrg(app.db, orgD.orgId, (tx) => tx.select().from(llmCredentials).where(eq(llmCredentials.id, credentialId)))
      expect(row!.healthStatus).toBe('healthy')
    })
    expect(await setAgentModel(llmDeps, orgD.orgId, {
      agentId: orgD.agentId, mode: 'byok', credentialId, draftModel: CUSTOM_MODEL, triageModel: CUSTOM_MODEL, effort: null, fallbackToManaged: false,
    }, llmActor(orgD))).toMatchObject({ ok: true })

    // The rotation: the same key set, v2 active. The DEK's bytes never change, only its wrapping.
    expect(await runKeysRotate({ db: app.db, ring: ringRotated, logger }, { orgId: orgD.orgId })).toBe('rewrapped')
    const [rotated] = await withOrg(app.db, orgD.orgId, (tx) => tx.select().from(orgDataKeys))
    expect(rotated!.kekVersion).toBe(2)
    expect(rotated!.version).toBe(provisioned!.version)
    expect(rotated!.wrappedDek.equals(provisioned!.wrappedDek)).toBe(false)
    const audits = await auditRowsFor(orgD, orgD.orgId, 'keys.rotated')
    expect(audits).toHaveLength(1)
    expect(audits[0]!.detail).toEqual({ from: 1, to: 2 })
    expect(await runKeysRotate({ db: app.db, ring: ringRotated, logger }, { orgId: orgD.orgId })).toBe('current')
    expect(logged('keys_rotate_failed')).toHaveLength(0)
    // A replica that never received v2 is exactly one KEK away from unreadable — the failure the
    // "same ring on every replica" rule exists for.
    await expect(withOrg(app.db, orgD.orgId, (tx) => loadOrgDek(tx, ringV1Only))).rejects.toThrow()
    const { dek: afterDek } = await withOrg(app.db, orgD.orgId, (tx) => loadOrgDek(tx, ring))
    expect(afterDek).toHaveLength(32)

    // Both secrets still open under the rotated wrapping: the BYOK key on the draft path (a cold
    // resolve — nothing on D was resolved before the rotation), the mailbox credential on the send.
    const draft = await inboundToDraft(orgD, { subject: QUESTION })
    expect(draft.draft.status).toBe('pending')
    expect(breakdownOf(draft.draft)).toMatchObject({ mode: 'byok', provider: 'custom' })
    expect(logged('provider_unavailable').filter((l) => l.includes(orgD.orgId))).toHaveLength(0)
    await approveAndSend(orgD, draft.draft.id)
    expect(orgD.mailbox.sentMessages()).toHaveLength(1)
    expect(orgD.mailbox.sentMessages()[0]!.markerDraftId).toBe(draft.draft.id)
  }, 240_000)

  // ---- 10: remember this reply ---------------------------------------------------

  it('10. remember this reply: an owner-sent outbound message ingested by the sync walk → rememberReply → the real memory.capture writes an ACTIVE answer with approvals 1 and source_message_id; the next similar inbound retrieves it on the answers leg, the draft carries it in used_answer_ids with memory > 0, and a second tap is already_remembered', async () => {
    const orgE = await createOrg({ name: 'echo' })
    await enableAgent(orgE)
    const customer = `customer-${rand()}@${CUSTOMER_DOMAIN}`

    // The customer asks; the OWNER answers by hand from their mail client. Both land through sync.
    scriptDraft({ parsed: reply() })
    const asked = await inboundToDraft(orgE, { subject: QUESTION })
    const inboundMsg = (await messagesFor(orgE)).find((m) => m.ticketId === asked.ticketId && m.direction === 'inbound')!
    const thread = await withOrg(app.db, orgE.orgId, (tx) => tx.select({ providerThreadId: tickets.providerThreadId }).from(tickets).where(eq(tickets.id, asked.ticketId)))
    orgE.mailbox.receiveOutbound({ to: [customer], subject: `Re: ${QUESTION}`, bodyText: OWNER_REPLY, threadId: thread[0]!.providerThreadId! })
    await triggerSync(orgE)
    const ownerMsg = await waitFor(async () => {
      const rows = (await messagesFor(orgE)).filter((m) => m.ticketId === asked.ticketId && m.direction === 'outbound')
      expect(rows).toHaveLength(1)
      return rows[0]!
    })
    expect(ownerMsg.bodyText).toBe(OWNER_REPLY)
    expect(ownerMsg.sentAt!.getTime()).toBeGreaterThan(inboundMsg.sentAt!.getTime())
    expect(ownerMsg.draftId).toBeNull()      // no marker: nothing the agent wrote
    expect(await answersFor(orgE)).toHaveLength(0)

    // Wrong direction, then the tap that counts.
    expect(await rememberReply(memoryDeps, orgE.orgId, inboundMsg.id, memoryActor(orgE))).toEqual({ ok: false, code: 'not_outbound' })
    expect(await rememberReply(memoryDeps, orgE.orgId, ownerMsg.id, memoryActor(orgE))).toEqual({ ok: true })
    expect(await auditRowsFor(orgE, ownerMsg.id, 'memory.remember_requested')).toHaveLength(1)
    const [answer] = await waitFor(async () => {
      const rows = await answersFor(orgE)
      expect(rows).toHaveLength(1)
      return rows
    })
    expect(answer).toMatchObject({
      status: 'active', approvals: 1, wasEdited: false, sourceMessageId: ownerMsg.id, sourceTicketId: asked.ticketId, sourceDraftId: null,
      agentId: null, categoryId: null, questionText: QUESTION, answerBody: OWNER_REPLY, embeddingModel: 'hash-v1',
    })
    expect(answer!.questionEmbedding).not.toBeNull()
    expect(answer!.sourceCustomerHash).toMatch(/^[0-9a-f]{64}$/)
    expect(answer!.expiresAt.getTime()).toBeGreaterThan(clock.now().getTime() + (MEMORY_EXPIRY_DAYS - 1) * DAY_MS)
    expect((await auditRowsFor(orgE, ownerMsg.id, 'memory.captured'))[0]!.detail).toMatchObject({ answerId: answer!.id, status: 'active' })

    // The next similar question: the answers leg retrieves it, the model reuses it, the breakdown says so.
    scriptDraft({ parsed: reply({ usedAnswerIds: [`${USE}${ANSWER_NEEDLE}`] }) })
    const at = fake.callsFor('draft').length
    const next = await inboundToDraft(orgE, { subject: `${QUESTION} (again)` })
    expect(next.draft.retrievedAnswerIds).toEqual([answer!.id])
    expect(next.draft.usedAnswerIds).toEqual([answer!.id])
    const block = fake.callsFor('draft')[at]!.system.find((b) => b.id === 'knowledge.retrieved')!.text
    expect(block).toContain(`[${answer!.id}] Q: ${QUESTION}`)
    expect(block).toContain(`A: ${OWNER_REPLY}`)
    const memory = breakdownOf(next.draft).memory!
    expect(memory.answerId).toBe(answer!.id)
    expect(memory.approvals).toBe(1)
    expect(memory.cosine).toBeGreaterThan(0.99)
    expect(memory.score).toBeGreaterThan(0)
    expect(memory.score).toBeCloseTo(1 / 3, 10)
    expect(breakdownOf(next.draft).evidence).toBeCloseTo(0.3, 10)

    // Idempotent both ways: the api refuses the second tap, and the job would skip it too.
    expect(await rememberReply(memoryDeps, orgE.orgId, ownerMsg.id, memoryActor(orgE))).toEqual({ ok: false, code: 'already_remembered' })
    expect(await answersFor(orgE)).toHaveLength(1)
  }, 240_000)

  // ---- 11: stuck and re-embed ---------------------------------------------------

  it('11. the knowledge sweeps: a crawl left processing 11 minutes is requeued (and knowledge.crawl re-enqueued) three times, then failed "stuck"; a flipped embedding model empties the vector leg (with the mismatch warn), the reembed sweep nulls the stale vectors without bumping knowledge_version, embed-batch under the new model refills them, the answers are re-embedded in place, and the vector leg retrieves the chunks again', async () => {
    // --- (a) stuck. A crawl whose claim died: `processing`, `updated_at` past the sweep's lease.
    const stale = (): Date => new Date(Date.now() - (STUCK_LEASE_SECONDS + 60) * 1000)
    const stuckId = randomUUID()
    await withOrg(app.db, orgA.orgId, (tx) => tx.insert(knowledgeSources).values({
      id: stuckId, orgId: orgA.orgId, kind: 'crawl', status: 'processing', title: 'shop.example.test', url: 'https://shop.example.test/',
      crawlConfig: { maxPages: 5 }, claimToken: randomUUID(), updatedAt: stale(),
    }))
    const sweepDeps = { db: app.db, store, logger, now: clock.now }
    for (let attempt = 1; attempt <= STUCK_MAX_ATTEMPTS; attempt += 1) {
      expect(await runKnowledgeStuckSweep(boss, sweepDeps)).toEqual({ requeued: 1, failed: 0, abandoned: 0 })
      const [row] = await withOrg(app.db, orgA.orgId, (tx) => tx.select().from(knowledgeSources).where(eq(knowledgeSources.id, stuckId)))
      expect(row).toMatchObject({ status: 'queued', claimToken: null, sweepAttempts: attempt, failureReason: null })
      expect(await jobsFor(JOB_NAMES.knowledgeCrawl, orgA.orgId)).toHaveLength(1)     // seam 6: enqueued, never worked
      // …and the crawl claims it and dies again.
      await withOrg(app.db, orgA.orgId, (tx) => tx.update(knowledgeSources).set({ status: 'processing', claimToken: randomUUID(), updatedAt: stale() }).where(eq(knowledgeSources.id, stuckId)))
    }
    expect(await runKnowledgeStuckSweep(boss, sweepDeps)).toEqual({ requeued: 0, failed: 1, abandoned: 0 })
    const [failed] = await withOrg(app.db, orgA.orgId, (tx) => tx.select().from(knowledgeSources).where(eq(knowledgeSources.id, stuckId)))
    expect(failed).toMatchObject({ status: 'failed', failureReason: 'stuck', sweepAttempts: STUCK_MAX_ATTEMPTS, claimToken: null })
    expect(failed!.completedAt).not.toBeNull()
    expect(await auditRowsFor(orgA, stuckId, 'knowledge.source.requeued')).toHaveLength(STUCK_MAX_ATTEMPTS)
    const failedAudit = await auditRowsFor(orgA, stuckId, 'knowledge.source.failed')
    expect(failedAudit).toHaveLength(1)
    expect(failedAudit[0]!.detail).toMatchObject({ reason: 'stuck', attempts: STUCK_MAX_ATTEMPTS })
    // A failed source no longer counts against the cap; nothing else was touched.
    expect((await sourcesFor(orgA)).filter((s) => s.status === 'ready')).toHaveLength(11)
    expect(await runKnowledgeStuckSweep(boss, sweepDeps)).toEqual({ requeued: 0, failed: 0, abandoned: 0 })

    // --- (b) the model flips. The SAME vectors under a new name: what changes is the label the
    // vector leg filters by, which is all this sweep is about.
    const embedderB: Embedder = { ...embedder, model: 'hash-v2', embed: (texts, kind, signal) => embedder.embed(texts, kind, signal) }
    const query = pasteText(1)
    const retrieve = (e: Embedder) => createRetriever({ db: app.db, embedder: e, logger }).retrieveDetailed({ orgId: orgA.orgId, questions: [query], text: query, signal: new AbortController().signal })
    const versionBefore = (await workspaceOf(orgA))!.knowledgeVersion
    const chunksBefore = await chunksFor(orgA)
    expect(chunksBefore.length).toBe(11)
    expect(chunksBefore.every((c) => c.hasVector && c.embeddingModel === 'hash-v1')).toBe(true)

    const onOld = await retrieve(embedder)
    expect(onOld.mode).toBe('hybrid')
    expect(Math.max(...onOld.chunks.map((c) => c.score))).toBeGreaterThan(0.5)      // a vector cosine, not a lexical rank
    const mismatched = await retrieve(embedderB)
    expect(mismatched.mode).toBe('hybrid')
    expect(mismatched.degraded).toBe(false)
    expect(mismatched.chunks.length).toBeGreaterThan(0)                                 // the LEXICAL leg still finds them…
    expect(Math.max(...mismatched.chunks.map((c) => c.score))).toBeLessThanOrEqual(0.5) // …the vector leg found nothing
    const warns = logged('KNOWLEDGE_EMBED_MODEL differs across replicas').filter((l) => l.includes(orgA.orgId))
    expect(warns).toHaveLength(1)
    expect(warns[0]).toContain('"queryModel":"hash-v2"')
    expect(warns[0]).toContain('"storedModels":["hash-v1"]')

    // --- (c) the sweep, under the new model. Its enqueue seam is captured: the REGISTERED
    // embed-batch job still runs the OLD embedder, so the refill is driven directly with the new one
    // (the brief's `runKnowledgeReembedSweep → runKnowledgeEmbedBatch`).
    const queued: { orgId: string; documentId: string }[] = []
    const depsB: KnowledgeDeps = { ...knowledgeDeps, embedder: embedderB, enqueueEmbedBatch: async (orgId, documentId) => { queued.push({ orgId, documentId }); return `captured-${queued.length}` } }
    const answersBefore = await withPlatform(app.db, 'test:read', (tx) => tx.select({ id: resolvedAnswers.id, orgId: resolvedAnswers.orgId }).from(resolvedAnswers).where(eq(resolvedAnswers.status, 'active')))
    expect(answersBefore.length).toBeGreaterThanOrEqual(3)     // A's taught one (+ the BYOK send's), D's, E's remembered one
    const swept = await runKnowledgeReembedSweep(boss, depsB)
    expect(swept.documentsQueued).toBe(queued.length)
    expect(queued.filter((q) => q.orgId === orgA.orgId)).toHaveLength(11)
    expect(swept.answersReembedded).toBe(answersBefore.length)
    expect(swept.skippedCap).toBe(0)
    expect(logged('knowledge_reembed_stranded')).toHaveLength(0)

    const nulled = await chunksFor(orgA)
    expect(nulled.every((c) => !c.hasVector && c.embeddingModel === null)).toBe(true)
    expect((await documentsFor(orgA)).every((d) => d.embeddedCount === 0)).toBe(true)
    expect((await workspaceOf(orgA))!.knowledgeVersion).toBe(versionBefore)            // provenance, not a cache key
    expect(await withOrg(app.db, orgA.orgId, (tx) => tx.select().from(auditLog).where(eq(auditLog.action, 'knowledge.source.reembed_queued')))).toHaveLength(11)
    for (const a of await withPlatform(app.db, 'test:read', (tx) => tx.select().from(resolvedAnswers).where(eq(resolvedAnswers.status, 'active')))) {
      expect(a.embeddingModel).toBe('hash-v2')
      expect(a.questionEmbedding).not.toBeNull()
    }
    expect(await auditRowsFor(orgA, orgA.orgId, 'memory.reembedded')).toHaveLength(1)

    // --- (d) the refill, and the vector leg comes back.
    for (const job of queued) await runKnowledgeEmbedBatch(depsB, job, new AbortController().signal)
    const refilled = await chunksFor(orgA)
    expect(refilled).toHaveLength(11)
    expect(refilled.every((c) => c.hasVector && c.embeddingModel === 'hash-v2')).toBe(true)
    expect((await documentsFor(orgA)).every((d) => d.embeddedCount === d.chunkCount)).toBe(true)
    expect((await workspaceOf(orgA))!.knowledgeVersion).toBe(versionBefore)
    const onNew = await retrieve(embedderB)
    expect(onNew.mode).toBe('hybrid')
    expect(Math.max(...onNew.chunks.map((c) => c.score))).toBeGreaterThan(0.5)
    expect(onNew.chunks.map((c) => c.id)).toContain(onOld.chunks[0]!.id)
    // …and a second sweep has nothing left to do.
    expect(await runKnowledgeReembedSweep(boss, depsB)).toEqual({ documentsQueued: 0, answersReembedded: 0, skippedCap: 0 })

    // The file's closing ledger: every page really reached the push dispatcher, the control never
    // moved, and the owner's key never appeared in a log line.
    expect(pushCalls.length).toBeGreaterThan(0)
    expect(await rowCounts(orgB.orgId)).toEqual(countsB)
    expect(logLines.join('\n')).not.toContain(CUSTOM_KEY)
  }, 240_000)
})
