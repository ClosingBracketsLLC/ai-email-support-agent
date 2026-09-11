/**
 * What the three `knowledge.*` jobs need, and the ONE place the store/embedder/reranker are chosen
 * from `WorkerConfig`. `agent-role.ts` builds its retriever's embedder through the same two helpers,
 * so a worker can never end up writing vectors with one model and querying with another.
 *
 * The production fallbacks are refusals, not warnings: the hash embedder's vectors are not
 * comparable with Voyage's and the memory store loses every upload on restart, so a production
 * replica missing either would look healthy while quietly producing an unusable knowledge base.
 * `loadConfig` already refuses to boot a production `knowledge` (or `agent`) replica without them —
 * the throws below are the second line of that same defence, reachable only if the gates drift.
 */
import type pino from 'pino'
import type { Resolver } from '@aesa/crypto'
import type { Db } from '@aesa/db'
import {
  createHashEmbedder, createMemoryStore, createS3Store, createVoyageEmbedder, createVoyageReranker,
  type CrawlFetch, type Embedder, type ObjectStore, type Reranker, type runParserInChild,
} from '@aesa/knowledge'
import type { WorkerConfig } from './config.ts'

export interface KnowledgeDeps {
  db: Db
  store: ObjectStore
  embedder: Embedder
  logger: pino.Logger
  /** index.ts/knowledge-role.ts wire this to `enqueueKnowledgeEmbedBatch`; returns null when pg-boss collapsed a duplicate. */
  enqueueEmbedBatch: (orgId: string, documentId: string) => Promise<string | null>
  now?: () => Date
  /** Test seam: the crawler's HTTP port (defaults to the SSRF-pinned real one). */
  crawlFetch?: CrawlFetch
  /** Test seam: DNS resolution for the crawler's public-address checks. */
  resolver?: Resolver
  /** Test seam: the forked PDF/DOCX parser. */
  parseInChild?: typeof runParserInChild
}

/** S3 (minio/R2/S3) when configured; in dev/test an in-memory store, which serves paste and crawl fine. */
export function createKnowledgeStore(config: WorkerConfig, logger: pino.Logger): ObjectStore {
  // `config.s3.secretAccessKey` is already a `Secret` (loadConfig wraps it); createS3Store takes it as is.
  if (config.s3) return createS3Store(config.s3)
  if (config.env === 'production') {
    throw new Error('S3_* are required in production when WORKER_ROLES includes `knowledge` (upload storage)')
  }
  logger.warn('S3_* missing; knowledge uploads use an in-memory object store (paste and crawl sources are unaffected)')
  return createMemoryStore()
}

/**
 * Voyage when a key is configured; in dev/test the deterministic hash embedder.
 *
 * `warnOnFallback: false` silences only the dev/test warning, never the production refusal: a
 * combined `knowledge,agent` replica calls this twice (once per role) and the owner does not need
 * to read the same sentence twice. `agent-role.ts` is the caller that passes it — the `knowledge`
 * role's own call is the one that keeps the warning, because it is the role whose writes the
 * fallback embedder makes unusable.
 */
export function createKnowledgeEmbedder(
  config: WorkerConfig,
  logger: pino.Logger,
  opts: { warnOnFallback?: boolean } = {},
): Embedder {
  if (config.voyageApiKey) {
    return createVoyageEmbedder({ apiKey: config.voyageApiKey, model: config.knowledgeEmbedModel })
  }
  if (config.env === 'production') {
    throw new Error('VOYAGE_API_KEY is required in production when WORKER_ROLES includes `agent` or `knowledge` (embeddings)')
  }
  if (opts.warnOnFallback !== false) {
    logger.warn('VOYAGE_API_KEY missing; using the deterministic hash embedder (its vectors are NOT comparable with Voyage\'s)')
  }
  return createHashEmbedder()
}

/** The optional cross-encoder pass: only with KNOWLEDGE_RERANK=on AND a Voyage key. */
export function createKnowledgeReranker(config: WorkerConfig): Reranker | null {
  if (!config.knowledgeRerank || !config.voyageApiKey) return null
  return createVoyageReranker({ apiKey: config.voyageApiKey })
}

/**
 * ONE deps object for all three jobs. `enqueueEmbedBatch` is passed in rather than built here (a
 * small extension of the task brief's `createKnowledgeDeps(config, db, logger)`): the enqueue seam
 * needs the pg-boss instance, and keeping it out of this module is what lets it be unit-tested with
 * no boss at all.
 */
export function createKnowledgeDeps(
  config: WorkerConfig,
  db: Db,
  logger: pino.Logger,
  enqueueEmbedBatch: KnowledgeDeps['enqueueEmbedBatch'],
): KnowledgeDeps {
  return { db, store: createKnowledgeStore(config, logger), embedder: createKnowledgeEmbedder(config, logger), logger, enqueueEmbedBatch }
}
