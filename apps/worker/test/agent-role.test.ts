import { randomBytes } from 'node:crypto'
import type PgBoss from 'pg-boss'
import { describe, expect, it } from 'vitest'
import { emptyRetriever } from '@aesa/agent'
import { loadKekRing, Secret, type KekRing } from '@aesa/crypto'
import type { Db } from '@aesa/db'
import { maybeRegisterAgentRole, type AgentRoleRegistrars } from '../src/agent-role.ts'
import type { WorkerConfig } from '../src/config.ts'
import { createWorkerLogger } from '../src/logging.ts'
import type { AgentSandboxDeps } from '../src/jobs/agent-sandbox.ts'
import type { GuidanceSuggestDeps } from '../src/jobs/guidance-suggest.ts'
import type { LlmProbeDeps } from '../src/jobs/llm-probe.ts'
import type { MemoryCaptureDeps } from '../src/jobs/memory-capture.ts'
import type { TicketDraftDeps } from '../src/jobs/ticket-draft.ts'
import type { TicketTriageDeps } from '../src/jobs/ticket-triage.ts'

const fakeDb = {} as Db
const fakeBoss = {} as PgBoss
const ring: KekRing = loadKekRing({ AESA_KEK_V1: randomBytes(32).toString('base64'), AESA_KEK_ACTIVE: '1' })

function baseConfig(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    env: 'development',
    databaseUrl: 'postgres://unused',
    roles: new Set(['agent']),
    kekRing: null,
    logLevel: 'info',
    anthropicApiKey: null,
    gmailOauth: null,
    msOauth: null,
    gmailPubsubTopic: null,
    webhookPublicUrl: null,
    mail: { transport: 'devsink', from: 'aesa <onboarding@resend.dev>' },
    appBaseUrl: null,
    appWebOrigin: null,
    voyageApiKey: null,
    knowledgeEmbedModel: 'voyage-4',
    knowledgeRerank: false,
    s3: null,
    platformSender: null,
    ...overrides,
  }
}

/** All six registrars share one flag: every gating test only asks "did anything register at all?". */
function spyRegistrars(mark: () => void): AgentRoleRegistrars {
  return {
    registerTriage: async () => mark(), registerDraft: async () => mark(), registerSandbox: async () => mark(),
    registerMemoryCapture: async () => mark(), registerGuidanceSuggest: async () => mark(), registerLlmProbe: async () => mark(),
  }
}

function testLogger(): { logger: ReturnType<typeof createWorkerLogger>; lines: string[] } {
  const lines: string[] = []
  return { logger: createWorkerLogger('info', { write: (s: string) => void lines.push(s) }), lines }
}

describe('maybeRegisterAgentRole', () => {
  it('does nothing when the agent role is not active — not even a warning', async () => {
    const { logger, lines } = testLogger()
    let registered = false
    await maybeRegisterAgentRole(
      { boss: fakeBoss, db: fakeDb, logger, config: baseConfig({ roles: new Set(['sync']) }), enqueueNotify: async () => {}, enqueueDraft: async () => {}, enqueueSend: async () => {} },
      spyRegistrars(() => { registered = true }),
    )
    expect(registered).toBe(false)
    expect(lines).toHaveLength(0)
  })

  it('refuses to start in production when the agent role is active but ANTHROPIC_API_KEY is missing', async () => {
    const { logger } = testLogger()
    let registered = false
    await expect(
      maybeRegisterAgentRole(
        { boss: fakeBoss, db: fakeDb, logger, config: baseConfig({ env: 'production' }), enqueueNotify: async () => {}, enqueueDraft: async () => {}, enqueueSend: async () => {} },
        spyRegistrars(() => { registered = true }),
      ),
    ).rejects.toThrow(/ANTHROPIC_API_KEY/)
    expect(registered).toBe(false)
  })

  it('in development with NEITHER key nor ring: the five model jobs still register, llm.probe does not, and both sentences are logged once', async () => {
    const { logger, lines } = testLogger()
    let registered = 0
    await maybeRegisterAgentRole(
      { boss: fakeBoss, db: fakeDb, logger, config: baseConfig({ env: 'development' }), enqueueNotify: async () => {}, enqueueDraft: async () => {}, enqueueSend: async () => {} },
      spyRegistrars(() => { registered += 1 }),
    )
    // Phase 6: a null managed provider is a real state the RESOLVER handles (`no_managed_key` →
    // `provider_unavailable`), not a reason to leave queues unconsumed.
    expect(registered).toBe(5)
    // Two independent gates, two sentences: no ring (so no llm.probe) and no key (so no Managed AI).
    const msgs = lines.map((l) => JSON.parse(l).msg as string)
    expect(msgs.filter((m) => m.includes('ANTHROPIC_API_KEY'))).toHaveLength(1)
    expect(msgs.filter((m) => m.includes('Managed AI is unavailable'))).toHaveLength(1)
    expect(msgs.filter((m) => m.includes('BYOK disabled'))).toHaveLength(1)
  })

  /** The two keys buy different things: `llm.probe` only ever calls the TENANT's endpoint, so a dev
   *  box with a ring and no Anthropic key is a fully working BYOK-only worker. */
  it('no ANTHROPIC_API_KEY but a ring, in dev: ALL SIX register and the one warn says Managed AI is unavailable', async () => {
    const { logger, lines } = testLogger()
    let probeDeps: LlmProbeDeps | undefined
    let modelJobs = 0
    await maybeRegisterAgentRole(
      {
        boss: fakeBoss, db: fakeDb, logger,
        config: baseConfig({ env: 'development', anthropicApiKey: null, kekRing: ring }),
        enqueueNotify: async () => {}, enqueueDraft: async () => {}, enqueueSend: async () => {},
      },
      {
        ...spyRegistrars(() => { modelJobs += 1 }),
        registerLlmProbe: async (_boss, jobDeps) => { probeDeps = jobDeps },
      },
    )
    expect(probeDeps?.ring).toBe(ring)
    expect(modelJobs).toBe(5)
    const msgs = lines.map((l) => JSON.parse(l).msg as string)
    expect(msgs.filter((m) => m.includes('Managed AI is unavailable'))).toHaveLength(1)
    expect(msgs.filter((m) => m.includes('BYOK disabled'))).toHaveLength(0)
  })

  it('same in test env — boots without the key rather than crashing', async () => {
    const { logger } = testLogger()
    let registered = 0
    await maybeRegisterAgentRole(
      { boss: fakeBoss, db: fakeDb, logger, config: baseConfig({ env: 'test' }), enqueueNotify: async () => {}, enqueueDraft: async () => {}, enqueueSend: async () => {} },
      spyRegistrars(() => { registered += 1 }),
    )
    expect(registered).toBe(5)
  })

  it('registers ticket.triage, ticket.draft, agent.sandbox, memory.capture AND guidance.suggest on ONE shared resolver once the key is present', async () => {
    const { logger } = testLogger()
    let triageDeps: TicketTriageDeps | undefined
    let draftDeps: TicketDraftDeps | undefined
    let sandboxDeps: AgentSandboxDeps | undefined
    let memoryDeps: MemoryCaptureDeps | undefined
    let guidanceDeps: GuidanceSuggestDeps | undefined
    const enqueueSend: TicketDraftDeps['enqueueSend'] = async () => {}
    await maybeRegisterAgentRole(
      {
        boss: fakeBoss, db: fakeDb, logger,
        // VOYAGE_API_KEY too: the role now builds the retriever's embedder, which refuses to fall
        // back to the hash embedder in production (knowledge-deps.ts).
        config: baseConfig({ env: 'production', anthropicApiKey: new Secret('sk-ant-test'), voyageApiKey: new Secret('pa-voyage') }),
        enqueueNotify: async () => {},
        enqueueDraft: async () => {},
        enqueueSend,
      },
      {
        registerTriage: async (_boss, jobDeps) => { triageDeps = jobDeps },
        registerDraft: async (_boss, jobDeps) => { draftDeps = jobDeps },
        registerSandbox: async (_boss, jobDeps) => { sandboxDeps = jobDeps },
        registerMemoryCapture: async (_boss, jobDeps) => { memoryDeps = jobDeps },
        registerGuidanceSuggest: async (_boss, jobDeps) => { guidanceDeps = jobDeps },
        registerLlmProbe: async () => {},
      },
    )
    expect(triageDeps?.db).toBe(fakeDb)
    expect(draftDeps?.db).toBe(fakeDb)
    expect(sandboxDeps?.db).toBe(fakeDb)
    expect(memoryDeps?.db).toBe(fakeDb)
    expect(guidanceDeps?.db).toBe(fakeDb)
    expect(draftDeps?.retriever).toBeDefined()
    expect(sandboxDeps?.retriever).toBeDefined()
    expect(triageDeps?.enqueueDraft).toBeDefined()
    // Phase 5: without this seam the auto landing's send row would sit `queued` until the backstop
    // sweep's due-send arm noticed it, a minute or more after the hold window elapsed.
    expect(draftDeps?.enqueueSend).toBe(enqueueSend)
    // ONE embedder for the role: the retriever's answers leg and memory.capture's write must never
    // disagree about which model wrote a resolved_answers vector.
    expect(memoryDeps?.embedder).toBeDefined()
    // Phase 6: ONE resolver, and it is the ONLY model seam a job gets — triage's, the sandbox's AND
    // guidance.suggest's calls all go through the same stack the draft job uses (deviation 8). A
    // second resolver would be a second per-credential cache and a second per-credential rate budget.
    expect(triageDeps?.providers).toBeDefined()
    expect(draftDeps?.providers).toBe(triageDeps?.providers)
    expect(sandboxDeps?.providers).toBe(triageDeps?.providers)
    expect(guidanceDeps?.providers).toBe(triageDeps?.providers)
  })

  it('key AND ring: all six register, llm.probe on the SAME resolver every job got', async () => {
    const { logger, lines } = testLogger()
    let probeDeps: LlmProbeDeps | undefined
    let draftDeps: TicketDraftDeps | undefined
    let modelJobs = 0
    await maybeRegisterAgentRole(
      {
        boss: fakeBoss, db: fakeDb, logger,
        config: baseConfig({ anthropicApiKey: new Secret('sk-ant-test'), kekRing: ring }),
        enqueueNotify: async () => {}, enqueueDraft: async () => {}, enqueueSend: async () => {},
      },
      {
        registerTriage: async () => { modelJobs += 1 },
        registerDraft: async (_boss, jobDeps) => { modelJobs += 1; draftDeps = jobDeps },
        registerSandbox: async () => { modelJobs += 1 },
        registerMemoryCapture: async () => { modelJobs += 1 },
        registerGuidanceSuggest: async () => { modelJobs += 1 },
        registerLlmProbe: async (_boss, jobDeps) => { probeDeps = jobDeps },
      },
    )
    expect(modelJobs).toBe(5)
    expect(probeDeps?.db).toBe(fakeDb)
    expect(probeDeps?.ring).toBe(ring)
    // The probe's whole job is to invalidate what the resolver cached — a second resolver would
    // leave every draft on this replica using the key the probe just replaced.
    expect(probeDeps?.resolver).toBe(draftDeps?.providers)
    expect(lines.map((l) => JSON.parse(l).msg as string).filter((m) => m.includes('BYOK disabled'))).toHaveLength(0)
  })

  it('skips llm.probe with ONE warning when there is no KEK ring (dev only — production refuses to boot)', async () => {
    const { logger, lines } = testLogger()
    let probeRegistered = false
    let draftRegistered = false
    await maybeRegisterAgentRole(
      {
        boss: fakeBoss, db: fakeDb, logger,
        config: baseConfig({ anthropicApiKey: new Secret('sk-ant-test'), kekRing: null }),
        enqueueNotify: async () => {}, enqueueDraft: async () => {}, enqueueSend: async () => {},
      },
      {
        registerTriage: async () => {}, registerDraft: async () => { draftRegistered = true },
        registerSandbox: async () => {}, registerMemoryCapture: async () => {}, registerGuidanceSuggest: async () => {},
        registerLlmProbe: async () => { probeRegistered = true },
      },
    )
    expect(probeRegistered).toBe(false)
    // Every other job still registers: a ringless dev box still drafts with the managed key.
    expect(draftRegistered).toBe(true)
    expect(lines.map((l) => JSON.parse(l).msg as string).filter((m) => m.includes('BYOK disabled'))).toHaveLength(1)
  })

  it('hands draft AND sandbox the REAL retriever — one instance, with retrieveDetailed (not emptyRetriever)', async () => {
    const { logger, lines } = testLogger()
    let draftDeps: TicketDraftDeps | undefined
    let sandboxDeps: AgentSandboxDeps | undefined
    await maybeRegisterAgentRole(
      {
        boss: fakeBoss, db: fakeDb, logger,
        config: baseConfig({ anthropicApiKey: new Secret('sk-ant-test') }),
        enqueueNotify: async () => {},
        enqueueDraft: async () => {},
        enqueueSend: async () => {},
      },
      {
        registerTriage: async () => {},
        registerDraft: async (_boss, jobDeps) => { draftDeps = jobDeps },
        registerSandbox: async (_boss, jobDeps) => { sandboxDeps = jobDeps },
        registerMemoryCapture: async () => {},
        registerGuidanceSuggest: async () => {},
        registerLlmProbe: async () => {},
      },
    )
    expect(draftDeps?.retriever).not.toBe(emptyRetriever)
    expect(draftDeps?.retriever).toHaveProperty('retrieveDetailed')
    // ONE retriever (one embedder, one rate budget) for both jobs.
    expect(sandboxDeps?.retriever).toBe(draftDeps?.retriever)
    // An `agent`-only replica is the one that announces the dev fallback here.
    expect(lines.map((l) => JSON.parse(l).msg as string).filter((m) => m.includes('VOYAGE_API_KEY'))).toHaveLength(1)
  })

  it('says the VOYAGE_API_KEY fallback ONCE on a combined `knowledge,agent` replica — the knowledge role owns that warning', async () => {
    const { logger, lines } = testLogger()
    await maybeRegisterAgentRole(
      {
        boss: fakeBoss, db: fakeDb, logger,
        config: baseConfig({ roles: new Set(['agent', 'knowledge']), anthropicApiKey: new Secret('sk-ant-test') }),
        enqueueNotify: async () => {},
        enqueueDraft: async () => {},
        enqueueSend: async () => {},
      },
      spyRegistrars(() => {}),
    )
    // `maybeRegisterKnowledgeRole` builds its own embedder from the same helper and warns there; the
    // owner of a one-process dev worker should read the sentence once, not twice.
    expect(lines.map((l) => JSON.parse(l).msg as string).filter((m) => m.includes('VOYAGE_API_KEY'))).toHaveLength(0)
  })
})
