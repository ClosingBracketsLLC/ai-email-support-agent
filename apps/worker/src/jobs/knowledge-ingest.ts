/**
 * The `knowledge.ingest` job (spec §Knowledge & learning): one uploaded file or one pasted text
 * becomes ONE document and its chunks, ready for `knowledge.embed-batch` to vectorize.
 *
 * **Every database touch is a short `withOrg` transaction, and the store's HEAD/GET and the forked
 * parser all happen OUTSIDE every one of them** — the app role's 5 s idle-in-transaction timeout
 * would kill a connection held across a download (CLAUDE.md Transactions).
 *
 * Two failure kinds, deliberately different:
 *  - a `ParseError` (too large, wrong type, unparsable, no text, timed out) is TERMINAL: the source
 *    lands `failed` with an owner-facing reason and the job returns cleanly. Retrying a file that
 *    cannot be parsed just burns the retry budget and re-fails identically.
 *  - anything else (a store outage, a dropped connection) rethrows for pg-boss's retry, and hands
 *    the source back as `queued` first so the retry's own claim can take it — the claim below only
 *    accepts `queued`, so without that hand-back the retry would be a silent no-op.
 */
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import type PgBoss from 'pg-boss'
import { z } from 'zod'
import { KNOWLEDGE_MAX_UPLOAD_BYTES } from '@aesa/contracts'
import {
  audit, bumpKnowledgeVersion, knowledgeChunks, knowledgeDocuments, knowledgeSources, withOrg,
} from '@aesa/db'
import {
  DEFAULT_PARSE_LIMITS, ParseError, parseMarkdown, parseText, prepareDocument, runParserInChild,
  type Block, type PreparedDocument,
} from '@aesa/knowledge'
import { defineJob, enqueue, JOB_NAMES, registerJob, type JobDefinition } from '@aesa/queue'
import { failSource, guardedSourceWrite } from '../knowledge/sources.ts'
import type { KnowledgeDeps } from '../knowledge-deps.ts'

export const KnowledgeIngestPayload = z.object({ orgId: z.string(), sourceId: z.string() })
export type KnowledgeIngestPayload = z.infer<typeof KnowledgeIngestPayload>

const ACTOR = 'system:knowledge.ingest' as const

/**
 * The importable definition: the api's `knowledge.completeUpload`/`paste` mutations `enqueue()`
 * against this (it only ever reads `.name`/`.schema`). `registerKnowledgeIngest` builds the
 * deps-bound definition and registers THAT.
 */
export const knowledgeIngestJob: JobDefinition<KnowledgeIngestPayload> = defineJob({
  name: JOB_NAMES.knowledgeIngest,
  schema: KnowledgeIngestPayload,
  // `short`: the owner can re-trigger the same source (a second completeUpload, a re-paste) while
  // the first job is still `created`; those collapse. Once it goes active a newer event is its own job.
  queue: { expireInSeconds: 600, retryLimit: 2, retryBackoff: true, policy: 'short' },
  handler: async () => {
    throw new Error('knowledge.ingest: this definition has no bound deps — register it through registerKnowledgeIngest(boss, deps)')
  },
})

interface ClaimedSource {
  kind: string
  title: string
  storageKey: string | null
  mime: string | null
  pastedText: string | null
}

/** `text/plain; charset=utf-8` → `text/plain`; null when the store reported no type at all. */
function baseContentType(raw: string | null): string | null {
  const base = raw?.split(';')[0]?.trim().toLowerCase()
  return base ? base : null
}

/** Thrown by `parseUpload` after it has deleted the object: the caller clears `storage_key` too, so
 * the row never points at a key that is gone (a later re-ingest would read "object missing" and
 * report the wrong reason, and the api would presign against a stale key). */
class ObjectRefused extends ParseError {
  constructor(code: ParseError['code'], message: string) {
    super(code, message)
    this.name = 'ObjectRefused'
  }
}

/** Reads the source's bytes and turns them into blocks. Never inside a transaction. */
async function parseUpload(deps: KnowledgeDeps, source: ClaimedSource): Promise<{ blocks: Block[]; uri: string }> {
  const key = source.storageKey
  if (!key) throw new ParseError('parse_failed', 'object missing')

  const head = await deps.store.head(key)
  if (!head) throw new ParseError('parse_failed', 'object missing')
  if (head.contentLength > KNOWLEDGE_MAX_UPLOAD_BYTES) {
    // The bytes are never downloaded, and the object goes: nothing else will ever read it.
    await deps.store.delete(key)
    throw new ObjectRefused('too_large', `object is ${head.contentLength} bytes, over the ${KNOWLEDGE_MAX_UPLOAD_BYTES} byte limit`)
  }
  const actualType = baseContentType(head.contentType)
  // A store that reports no content-type at all cannot contradict the declared mime — the parser
  // dispatch below (and, for pdf/docx, the bounded child) is what actually has to survive the bytes.
  if (actualType !== null && actualType !== source.mime) {
    await deps.store.delete(key)
    throw new ObjectRefused('wrong_type', `object is ${actualType}, declared ${source.mime}`)
  }

  const bytes = await deps.store.get(key)
  const uri = `upload:${key}`
  const parseInChild = deps.parseInChild ?? runParserInChild

  // One temp directory per ingest, removed whatever happens: the forked PDF/DOCX parser reads a
  // PATH, not a buffer, so the parse itself (the memory-hungry half, and the one running under
  // `--max-old-space-size`) never happens in this process. The download above does put the whole
  // object in the parent's heap first — bounded by the 20 MiB upload cap, not by the child's limits.
  const dir = await mkdtemp(join(tmpdir(), 'aesa-ingest-'))
  const path = join(dir, 'source')
  try {
    await writeFile(path, bytes)
    switch (source.mime) {
      case 'application/pdf':
        return { blocks: await parseInChild({ kind: 'pdf', path, limits: DEFAULT_PARSE_LIMITS }), uri }
      case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
        return { blocks: await parseInChild({ kind: 'docx', path, limits: DEFAULT_PARSE_LIMITS }), uri }
      case 'text/markdown':
        return { blocks: parseMarkdown(Buffer.from(bytes).toString('utf8')), uri }
      case 'text/plain':
        return { blocks: parseText(Buffer.from(bytes).toString('utf8')), uri }
      default:
        throw new ParseError('wrong_type', `unsupported mime ${source.mime}`)
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

export async function runKnowledgeIngest(deps: KnowledgeDeps, payload: KnowledgeIngestPayload, signal: AbortSignal): Promise<void> {
  const { orgId, sourceId } = payload
  const now = deps.now?.() ?? new Date()

  // tx1: claim. `queued` only — a source already `processing` belongs to another run, and a `ready`
  // or `failed` one needs the api to re-queue it before anything here touches it again.
  const claimToken = randomUUID()
  const source = await withOrg(deps.db, orgId, async (tx) => {
    const [row] = await tx
      .select({
        kind: knowledgeSources.kind, title: knowledgeSources.title, storageKey: knowledgeSources.storageKey,
        mime: knowledgeSources.mime, pastedText: knowledgeSources.pastedText,
      })
      .from(knowledgeSources)
      .where(eq(knowledgeSources.id, sourceId))
    if (!row) return null
    const claimed = await guardedSourceWrite(tx, sourceId, ['queued'], {
      status: 'processing', failureReason: null, failureDetail: null, completedAt: null, claimToken,
    })
    return claimed ? row : null
  })
  if (!source) return

  let prepared: PreparedDocument
  try {
    if (signal.aborted) throw new Error('knowledge.ingest: aborted before parsing')
    const { blocks, uri } =
      source.kind === 'paste'
        ? { blocks: parseMarkdown(source.pastedText ?? ''), uri: `paste:${sourceId}` }
        : await parseUpload(deps, source)
    prepared = prepareDocument({ blocks, uri, title: source.title })
  } catch (err) {
    if (err instanceof ParseError) {
      if (err instanceof ObjectRefused) {
        // The object is gone; the key must not outlive it.
        await withOrg(deps.db, orgId, (tx) =>
          guardedSourceWrite(tx, sourceId, ['processing'], { storageKey: null }, claimToken))
      }
      await failSource(deps.db, { orgId, sourceId, actor: ACTOR, reason: err.code, detail: err.message, now, claimToken })
      return
    }
    // Retryable: hand the claim back so pg-boss's next attempt can take it, then let it fail loudly.
    await withOrg(deps.db, orgId, (tx) =>
      guardedSourceWrite(tx, sourceId, ['processing'], { status: 'queued', claimToken: null }, claimToken))
    throw err
  }

  // tx2: replace the source's document set outright. One source, one document — the delete cascades
  // to its chunks, so a re-ingest can never leave a stale chunk behind for retrieval to find.
  const flagged = prepared.chunks.filter((c) => c.injectionFlagged).length
  const documentId = await withOrg(deps.db, orgId, async (tx) => {
    const written = await guardedSourceWrite(tx, sourceId, ['processing'], {
      documentCount: 1, chunkCount: prepared.chunks.length, contentHash: prepared.contentHash,
    }, claimToken)
    if (!written) return null // the owner deleted or re-queued the source while we were parsing

    await tx.delete(knowledgeDocuments).where(eq(knowledgeDocuments.sourceId, sourceId))
    const [doc] = await tx
      .insert(knowledgeDocuments)
      .values({ orgId, sourceId, uri: prepared.uri, title: prepared.title, contentHash: prepared.contentHash, chunkCount: prepared.chunks.length })
      .returning({ id: knowledgeDocuments.id })
    await tx.insert(knowledgeChunks).values(prepared.chunks.map((chunk) => ({
      orgId, documentId: doc!.id, ordinal: chunk.ordinal, headingPath: chunk.headingPath,
      content: chunk.content, tokenCount: chunk.tokenCount,
      injectionFlagged: chunk.injectionFlagged, injectionReason: chunk.injectionReason,
    })))

    // Same transaction as the chunk set it describes (CLAUDE.md: provenance, not a cache key).
    await bumpKnowledgeVersion(tx, orgId)
    await audit(tx, {
      actor: ACTOR, action: 'knowledge.source.parsed', entityType: 'knowledge_source', entityId: sourceId,
      detail: { chunks: prepared.chunks.length, flagged },
    })
    return doc!.id
  })

  // After the commit: the embed job reads rows that must already exist.
  if (documentId) await deps.enqueueEmbedBatch(orgId, documentId)
}

export async function registerKnowledgeIngest(boss: PgBoss, deps: KnowledgeDeps): Promise<void> {
  const wired: JobDefinition<KnowledgeIngestPayload> = {
    ...knowledgeIngestJob,
    handler: async (ctx) => {
      await runKnowledgeIngest(deps, ctx.data, ctx.signal)
    },
  }
  await registerJob(boss, wired)
}

export async function enqueueKnowledgeIngest(boss: PgBoss, orgId: string, sourceId: string): Promise<string | null> {
  return enqueue(boss, knowledgeIngestJob, { orgId, sourceId }, { entityId: sourceId })
}
