/**
 * `maybeRegisterKnowledgeRole`'s gating, through the same injectable-registrar seam `agent-role.ts`
 * uses: no pg-boss, no database, no bucket. What it pins is which dependency a `knowledge` replica
 * refuses to start without, and what it silently falls back to in dev.
 */
import type PgBoss from 'pg-boss'
import { describe, expect, it } from 'vitest'
import { Secret } from '@aesa/crypto'
import type { Db } from '@aesa/db'
import type { WorkerConfig, WorkerS3Config } from '../src/config.ts'
import type { KnowledgeDeps } from '../src/knowledge-deps.ts'
import type { WorkspaceExportDeps } from '../src/jobs/workspace-export.ts'
import type { WorkspacePurgeDeps } from '../src/jobs/workspace-purge.ts'
import { maybeRegisterKnowledgeRole, type KnowledgeRoleDeps, type KnowledgeRoleRegistrars } from '../src/knowledge-role.ts'
import { createWorkerLogger } from '../src/logging.ts'

const fakeDb = {} as Db
const fakeBoss = {} as PgBoss

const s3: WorkerS3Config = {
  endpoint: 'http://localhost:9000', region: 'us-east-1', bucket: 'aesa-dev',
  accessKeyId: 'aesa', secretAccessKey: new Secret('aesaaesa'), forcePathStyle: true,
}

function baseConfig(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    env: 'development',
    databaseUrl: 'postgres://unused',
    roles: new Set(['knowledge']),
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
    stripe: null,
    managedDraftSlots: 0,
    sentryDsn: null,
    sentryEnvironment: 'test',
    platformSender: null,
    ...overrides,
  }
}

function testLogger(): { logger: ReturnType<typeof createWorkerLogger>; lines: string[] } {
  const lines: string[] = []
  return { logger: createWorkerLogger('info', { write: (s: string) => void lines.push(s) }), lines }
}

interface Spies {
  register: KnowledgeRoleRegistrars
  /** The three knowledge jobs' deps, in registration order. */
  seen: (KnowledgeDeps | undefined)[]
  /** Phase 7's two, which share the knowledge role's object store. */
  workspace: (WorkspaceExportDeps | WorkspacePurgeDeps)[]
}

function spyRegistrars(): Spies {
  const seen: (KnowledgeDeps | undefined)[] = []
  const workspace: (WorkspaceExportDeps | WorkspacePurgeDeps)[] = []
  return {
    seen,
    workspace,
    register: {
      registerIngest: async (_boss, deps) => { seen.push(deps) },
      registerCrawl: async (_boss, deps) => { seen.push(deps) },
      registerEmbedBatch: async (_boss, deps) => { seen.push(deps) },
      registerExport: async (_boss, deps) => { workspace.push(deps) },
      registerPurge: async (_boss, deps) => { workspace.push(deps) },
    },
  }
}

const noopNotify: KnowledgeRoleDeps['enqueueNotify'] = async () => {}

describe('maybeRegisterKnowledgeRole', () => {
  it('does nothing when the knowledge role is not active — not even a warning', async () => {
    const { logger, lines } = testLogger()
    const { register, seen } = spyRegistrars()
    await maybeRegisterKnowledgeRole({ boss: fakeBoss, db: fakeDb, logger, config: baseConfig({ roles: new Set(['send']) }), enqueueNotify: noopNotify }, register)
    expect(seen).toHaveLength(0)
    expect(lines).toHaveLength(0)
  })

  it('registers all five jobs on ONE object store when the role is on and S3 + Voyage are configured', async () => {
    const { logger, lines } = testLogger()
    const { register, seen, workspace } = spyRegistrars()
    await maybeRegisterKnowledgeRole(
      { boss: fakeBoss, db: fakeDb, logger, config: baseConfig({ env: 'production', s3, voyageApiKey: new Secret('pa-voyage') }), enqueueNotify: noopNotify },
      register,
    )
    expect(seen).toHaveLength(3)
    expect(seen[0]).toBe(seen[1])
    expect(seen[1]).toBe(seen[2])
    expect(seen[0]?.db).toBe(fakeDb)
    expect(seen[0]?.embedder.model).toBe('voyage-4')
    expect(seen[0]?.embedder.dimensions).toBe(1024)
    expect(seen[0]?.enqueueEmbedBatch).toBeDefined()
    // Phase 7: workspace.export and workspace.purge get the SAME store object as the three above —
    // an export written to one bucket and a purge deleting from another is the same class of bug.
    expect(workspace).toHaveLength(2)
    expect(workspace[0]?.store).toBe(seen[0]?.store)
    expect(workspace[1]?.store).toBe(seen[0]?.store)
    expect((workspace[0] as WorkspaceExportDeps).enqueueNotify).toBe(noopNotify)
    // Fully configured: no fallback warnings at all.
    expect(lines).toHaveLength(0)
  })

  it('honours KNOWLEDGE_EMBED_MODEL for the Voyage embedder', async () => {
    const { logger } = testLogger()
    const { register, seen } = spyRegistrars()
    await maybeRegisterKnowledgeRole(
      { boss: fakeBoss, db: fakeDb, logger, config: baseConfig({ s3, voyageApiKey: new Secret('pa-voyage'), knowledgeEmbedModel: 'voyage-4-lite' }), enqueueNotify: noopNotify },
      register,
    )
    expect(seen[0]?.embedder.model).toBe('voyage-4-lite')
  })

  it('falls back to the in-memory store and the hash embedder in development, with one warning each', async () => {
    const { logger, lines } = testLogger()
    const { register, seen } = spyRegistrars()
    await maybeRegisterKnowledgeRole({ boss: fakeBoss, db: fakeDb, logger, config: baseConfig(), enqueueNotify: noopNotify }, register)

    expect(seen).toHaveLength(3)
    expect(seen[0]?.embedder.model).toBe('hash-v1')
    expect(lines).toHaveLength(2)
    expect(lines.map((l) => JSON.parse(l).msg).join(' | ')).toMatch(/S3_\*/)
    expect(lines.map((l) => JSON.parse(l).msg).join(' | ')).toMatch(/VOYAGE_API_KEY/)
  })

  it('refuses to start in production without S3_* (loadConfig normally catches this first)', async () => {
    const { logger } = testLogger()
    const { register, seen } = spyRegistrars()
    await expect(
      maybeRegisterKnowledgeRole({ boss: fakeBoss, db: fakeDb, logger, config: baseConfig({ env: 'production', voyageApiKey: new Secret('pa-voyage') }), enqueueNotify: noopNotify }, register),
    ).rejects.toThrow(/S3_\*/)
    expect(seen).toHaveLength(0)
  })

  it('refuses to start in production without VOYAGE_API_KEY', async () => {
    const { logger } = testLogger()
    const { register, seen } = spyRegistrars()
    await expect(
      maybeRegisterKnowledgeRole({ boss: fakeBoss, db: fakeDb, logger, config: baseConfig({ env: 'production', s3 }), enqueueNotify: noopNotify }, register),
    ).rejects.toThrow(/VOYAGE_API_KEY/)
    expect(seen).toHaveLength(0)
  })
})
