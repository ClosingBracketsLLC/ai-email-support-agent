/**
 * The `knowledge` role's job wiring: `knowledge.ingest`, `knowledge.crawl`, `knowledge.embed-batch`
 * and — since Phase 7 — the two object-store jobs that are not about knowledge at all but need the
 * same bucket, `workspace.export` and `workspace.purge`. Split out of `index.ts` the same way
 * `agent-role.ts` and `send-role.ts` are, so the S3/Voyage gating is unit-testable with no pg-boss
 * and no bucket — `register` is an injectable seam (defaulting to the five real registrars) that
 * tests replace with spies.
 *
 * ONE `KnowledgeDeps` is built for the whole role and handed to ALL THREE knowledge jobs: one object
 * store, one embedder, one enqueue seam. Three separately-built embedders could silently disagree
 * about the model, and `embedding_model` is part of retrieval's vector-leg WHERE. The two workspace
 * jobs get THAT SAME store object — an export written to one bucket and a purge deleting from
 * another would be the same class of bug, one layer down.
 */
import type PgBoss from 'pg-boss'
import type pino from 'pino'
import type { Db } from '@aesa/db'
import type { WorkerConfig } from './config.ts'
import { registerKnowledgeCrawl } from './jobs/knowledge-crawl.ts'
import { enqueueKnowledgeEmbedBatch, registerKnowledgeEmbedBatch } from './jobs/knowledge-embed-batch.ts'
import { registerKnowledgeIngest } from './jobs/knowledge-ingest.ts'
import { registerWorkspaceExport, type WorkspaceExportDeps } from './jobs/workspace-export.ts'
import { registerWorkspacePurge, type WorkspacePurgeDeps } from './jobs/workspace-purge.ts'
import { createKnowledgeDeps, type KnowledgeDeps } from './knowledge-deps.ts'

export interface KnowledgeRoleDeps {
  boss: PgBoss
  db: Db
  logger: pino.Logger
  config: WorkerConfig
  /** index.ts wires this to `enqueueKnowledgeEmbedBatch`; defaults to the real one bound to `boss`. */
  enqueueEmbedBatch?: KnowledgeDeps['enqueueEmbedBatch']
  /** index.ts wires this to `enqueueNotifyDispatch` — `workspace.export` pages the owner when the
   *  bundle is ready (or when it could not be built). */
  enqueueNotify: WorkspaceExportDeps['enqueueNotify']
}

/** The five registrars, as one injectable seam. */
export interface KnowledgeRoleRegistrars {
  registerIngest: (boss: PgBoss, deps: KnowledgeDeps) => Promise<void>
  registerCrawl: (boss: PgBoss, deps: KnowledgeDeps) => Promise<void>
  registerEmbedBatch: (boss: PgBoss, deps: KnowledgeDeps) => Promise<void>
  registerExport: (boss: PgBoss, deps: WorkspaceExportDeps) => Promise<void>
  registerPurge: (boss: PgBoss, deps: WorkspacePurgeDeps) => Promise<void>
}

const DEFAULT_REGISTRARS: KnowledgeRoleRegistrars = {
  registerIngest: registerKnowledgeIngest,
  registerCrawl: registerKnowledgeCrawl,
  registerEmbedBatch: registerKnowledgeEmbedBatch,
  registerExport: registerWorkspaceExport,
  registerPurge: registerWorkspacePurge,
}

/**
 * Registers the five jobs when `WORKER_ROLES` includes `knowledge`. Missing `S3_*` or
 * `VOYAGE_API_KEY` refuses to start in production (`createKnowledgeDeps` throws — `loadConfig`
 * already refuses first, this is the second line of the same defence) and in dev/test falls back to
 * an in-memory store and the hash embedder with one warning each, so local dev still ingests pastes
 * and crawls without a bucket or an API key.
 */
export async function maybeRegisterKnowledgeRole(
  deps: KnowledgeRoleDeps,
  register: KnowledgeRoleRegistrars = DEFAULT_REGISTRARS,
): Promise<void> {
  if (!deps.config.roles.has('knowledge')) return

  const enqueueEmbedBatch =
    deps.enqueueEmbedBatch ?? ((orgId: string, documentId: string) => enqueueKnowledgeEmbedBatch(deps.boss, orgId, documentId))

  const jobDeps = createKnowledgeDeps(deps.config, deps.db, deps.logger, enqueueEmbedBatch)
  await register.registerIngest(deps.boss, jobDeps)
  await register.registerCrawl(deps.boss, jobDeps)
  await register.registerEmbedBatch(deps.boss, jobDeps)

  // The SAME store object the three above hold — see the file header.
  await register.registerExport(deps.boss, {
    db: deps.db, store: jobDeps.store, logger: deps.logger, enqueueNotify: deps.enqueueNotify,
  })
  await register.registerPurge(deps.boss, { db: deps.db, store: jobDeps.store, logger: deps.logger })
}
