import type PgBoss from 'pg-boss'
import { describe, expect, it } from 'vitest'
import { emptyRetriever } from '@aesa/agent'
import { Secret } from '@aesa/crypto'
import type { Db } from '@aesa/db'
import { maybeRegisterAgentRole, type AgentRoleRegistrars } from '../src/agent-role.ts'
import type { WorkerConfig } from '../src/config.ts'
import { createWorkerLogger } from '../src/logging.ts'
import type { AgentSandboxDeps } from '../src/jobs/agent-sandbox.ts'
import type { TicketDraftDeps } from '../src/jobs/ticket-draft.ts'
import type { TicketTriageDeps } from '../src/jobs/ticket-triage.ts'

const fakeDb = {} as Db
const fakeBoss = {} as PgBoss

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

/** All three registrars share one flag: every gating test only asks "did anything register at all?". */
function spyRegistrars(mark: () => void): AgentRoleRegistrars {
  return { registerTriage: async () => mark(), registerDraft: async () => mark(), registerSandbox: async () => mark() }
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
      { boss: fakeBoss, db: fakeDb, logger, config: baseConfig({ roles: new Set(['sync']) }), enqueueNotify: async () => {}, enqueueDraft: async () => {} },
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
        { boss: fakeBoss, db: fakeDb, logger, config: baseConfig({ env: 'production' }), enqueueNotify: async () => {}, enqueueDraft: async () => {} },
        spyRegistrars(() => { registered = true }),
      ),
    ).rejects.toThrow(/ANTHROPIC_API_KEY/)
    expect(registered).toBe(false)
  })

  it('logs a warning and skips registration in development when ANTHROPIC_API_KEY is missing', async () => {
    const { logger, lines } = testLogger()
    let registered = false
    await maybeRegisterAgentRole(
      { boss: fakeBoss, db: fakeDb, logger, config: baseConfig({ env: 'development' }), enqueueNotify: async () => {}, enqueueDraft: async () => {} },
      spyRegistrars(() => { registered = true }),
    )
    expect(registered).toBe(false)
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]!).msg).toMatch(/ANTHROPIC_API_KEY/)
  })

  it('same in test env — boots without the key rather than crashing', async () => {
    const { logger } = testLogger()
    let registered = false
    await maybeRegisterAgentRole(
      { boss: fakeBoss, db: fakeDb, logger, config: baseConfig({ env: 'test' }), enqueueNotify: async () => {}, enqueueDraft: async () => {} },
      spyRegistrars(() => { registered = true }),
    )
    expect(registered).toBe(false)
  })

  it('registers ticket.triage, ticket.draft AND agent.sandbox on ONE managed provider once the key is present', async () => {
    const { logger } = testLogger()
    let triageDeps: TicketTriageDeps | undefined
    let draftDeps: TicketDraftDeps | undefined
    let sandboxDeps: AgentSandboxDeps | undefined
    await maybeRegisterAgentRole(
      {
        boss: fakeBoss, db: fakeDb, logger,
        // VOYAGE_API_KEY too: the role now builds the retriever's embedder, which refuses to fall
        // back to the hash embedder in production (knowledge-deps.ts).
        config: baseConfig({ env: 'production', anthropicApiKey: new Secret('sk-ant-test'), voyageApiKey: new Secret('pa-voyage') }),
        enqueueNotify: async () => {},
        enqueueDraft: async () => {},
      },
      {
        registerTriage: async (_boss, jobDeps) => { triageDeps = jobDeps },
        registerDraft: async (_boss, jobDeps) => { draftDeps = jobDeps },
        registerSandbox: async (_boss, jobDeps) => { sandboxDeps = jobDeps },
      },
    )
    expect(triageDeps?.db).toBe(fakeDb)
    expect(draftDeps?.db).toBe(fakeDb)
    expect(sandboxDeps?.db).toBe(fakeDb)
    expect(triageDeps?.provider.kind).toBe('anthropic')
    // ONE provider for the role: triage's and the sandbox's calls are metered through the same
    // managed stack the draft job uses (deviation 8), not a second bare adapter.
    expect(draftDeps?.provider).toBe(triageDeps?.provider)
    expect(sandboxDeps?.provider).toBe(triageDeps?.provider)
    expect(draftDeps?.retriever).toBeDefined()
    expect(sandboxDeps?.retriever).toBeDefined()
    expect(triageDeps?.enqueueDraft).toBeDefined()
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
      },
      {
        registerTriage: async () => {},
        registerDraft: async (_boss, jobDeps) => { draftDeps = jobDeps },
        registerSandbox: async (_boss, jobDeps) => { sandboxDeps = jobDeps },
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
      },
      spyRegistrars(() => {}),
    )
    // `maybeRegisterKnowledgeRole` builds its own embedder from the same helper and warns there; the
    // owner of a one-process dev worker should read the sentence once, not twice.
    expect(lines.map((l) => JSON.parse(l).msg as string).filter((m) => m.includes('VOYAGE_API_KEY'))).toHaveLength(0)
  })
})
