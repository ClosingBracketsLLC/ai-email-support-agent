/**
 * The `knowledge` router: input → `src/knowledge/service.ts` → tRPC error mapping, and nothing
 * else — mirrors `routers/drafts.ts`. Reads (`list`, `flaggedChunks`, `gaps`) are `orgProcedure`
 * (reviewing what the agent knows is every teammate's job); every mutation is a `managerProcedure`
 * (adding, removing or re-queuing a knowledge source is workspace management).
 */
import { TRPCError } from '@trpc/server'
import { canManageWorkspace, ChunkIdInput, CompleteUploadInput, PasteInput, SourceIdInput, StartCrawlInput, StartUploadInput } from '@aesa/contracts'
import type { AuditActor } from '@aesa/db'
import type { ObjectStore } from '@aesa/knowledge/storage'
import type pino from 'pino'
import type { ApiFacade, EnqueueFn } from '../../deps.ts'
import {
  completeUpload, deleteChunk, deleteSource, flaggedChunks, gaps, listSources, pasteSource, refreshCrawl,
  startCrawl, startUpload, unflagChunk, type KnowledgeActor, type KnowledgeServiceDeps,
} from '../../knowledge/service.ts'
import { managerProcedure, orgProcedure, router } from '../init.ts'

/** The slice of the tRPC context the service needs — structural, so the real context just satisfies it. */
interface KnowledgeContext {
  deps: { api: ApiFacade; enqueue: EnqueueFn; store: ObjectStore; logger: pino.Logger }
  user: { id: string }
  actor: AuditActor
  ip: string
  userAgent: string | null
}

const serviceDeps = (ctx: KnowledgeContext): KnowledgeServiceDeps => ({ api: ctx.deps.api, enqueue: ctx.deps.enqueue, store: ctx.deps.store, logger: ctx.deps.logger })
const appActor = (ctx: KnowledgeContext): KnowledgeActor => ({ userId: ctx.user.id, actor: ctx.actor, ip: ctx.ip, userAgent: ctx.userAgent })

/** The one place a soft-outcome code becomes a `TRPCError`: `not_found → NOT_FOUND`,
 * `forbidden_cap → FORBIDDEN`, `bad_request → BAD_REQUEST`. `fallback` covers the two `not_found`
 * results that carry no `message` at all (`deleteSource`, `unflagChunk`, `deleteChunk`) — every
 * other soft outcome already sets one. */
function knowledgeError(code: 'not_found' | 'forbidden_cap' | 'bad_request', message: string | undefined, fallback: string): TRPCError {
  const text = message ?? fallback
  switch (code) {
    case 'not_found': return new TRPCError({ code: 'NOT_FOUND', message: text })
    case 'forbidden_cap': return new TRPCError({ code: 'FORBIDDEN', message: text })
    case 'bad_request': return new TRPCError({ code: 'BAD_REQUEST', message: text })
  }
}

export const knowledgeRouter = router({
  list: orgProcedure.query(({ ctx }) => listSources(serviceDeps(ctx), ctx.orgId, canManageWorkspace(ctx.member.role))),

  startUpload: managerProcedure.input(StartUploadInput).mutation(async ({ ctx, input }) => {
    const res = await startUpload(serviceDeps(ctx), ctx.orgId, appActor(ctx), input)
    if (res.ok) return { sourceId: res.sourceId, url: res.url, headers: res.headers, expiresAt: res.expiresAt }
    throw knowledgeError(res.code, res.message, 'source cap reached')
  }),

  completeUpload: managerProcedure.input(CompleteUploadInput).mutation(async ({ ctx, input }) => {
    const res = await completeUpload(serviceDeps(ctx), ctx.orgId, appActor(ctx), input)
    if (res.ok) return { ok: true as const }
    throw knowledgeError(res.code, res.message, res.code === 'not_found' ? 'knowledge source not found' : 'source is not an uploadable, queued source')
  }),

  paste: managerProcedure.input(PasteInput).mutation(async ({ ctx, input }) => {
    const res = await pasteSource(serviceDeps(ctx), ctx.orgId, appActor(ctx), input)
    if (res.ok) return { sourceId: res.sourceId }
    throw knowledgeError(res.code, res.message, 'source cap reached')
  }),

  startCrawl: managerProcedure.input(StartCrawlInput).mutation(async ({ ctx, input }) => {
    const res = await startCrawl(serviceDeps(ctx), ctx.orgId, appActor(ctx), input)
    if (res.ok) return { sourceId: res.sourceId }
    throw knowledgeError(res.code, res.message, 'source cap reached')
  }),

  refreshCrawl: managerProcedure.input(SourceIdInput).mutation(async ({ ctx, input }) => {
    const res = await refreshCrawl(serviceDeps(ctx), ctx.orgId, appActor(ctx), input)
    if (res.ok) return { ok: true as const }
    throw knowledgeError(res.code, res.message, res.code === 'not_found' ? 'knowledge source not found' : 'source is not a ready or failed crawl')
  }),

  deleteSource: managerProcedure.input(SourceIdInput).mutation(async ({ ctx, input }) => {
    const res = await deleteSource(serviceDeps(ctx), ctx.orgId, appActor(ctx), input)
    if (res.ok) return { ok: true as const }
    throw knowledgeError(res.code, undefined, 'knowledge source not found')
  }),

  flaggedChunks: orgProcedure.query(({ ctx }) => flaggedChunks(serviceDeps(ctx), ctx.orgId)),

  unflagChunk: managerProcedure.input(ChunkIdInput).mutation(async ({ ctx, input }) => {
    const res = await unflagChunk(serviceDeps(ctx), ctx.orgId, appActor(ctx), input)
    if (res.ok) return { ok: true as const }
    throw knowledgeError(res.code, undefined, 'flagged chunk not found')
  }),

  deleteChunk: managerProcedure.input(ChunkIdInput).mutation(async ({ ctx, input }) => {
    const res = await deleteChunk(serviceDeps(ctx), ctx.orgId, appActor(ctx), input)
    if (res.ok) return { ok: true as const }
    throw knowledgeError(res.code, undefined, 'flagged chunk not found')
  }),

  gaps: orgProcedure.query(({ ctx }) => gaps(serviceDeps(ctx), ctx.orgId)),
})
