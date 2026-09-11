/**
 * The `knowledge` router: input → `src/knowledge/service.ts` → tRPC error mapping, and nothing
 * else — mirrors `routers/drafts.ts`. Reads (`list`, `flaggedChunks`, `gaps`) are `orgProcedure`
 * (reviewing what the agent knows is every teammate's job); every mutation is a `managerProcedure`
 * (adding, removing or re-queuing a knowledge source is workspace management).
 */
import { TRPCError } from '@trpc/server'
import { ChunkIdInput, CompleteUploadInput, PasteInput, SourceIdInput, StartCrawlInput, StartUploadInput } from '@aesa/contracts'
import type { AuditActor } from '@aesa/db'
import type { ObjectStore } from '@aesa/knowledge'
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

const notFound = (message: string): TRPCError => new TRPCError({ code: 'NOT_FOUND', message })

export const knowledgeRouter = router({
  list: orgProcedure.query(({ ctx }) => listSources(serviceDeps(ctx), ctx.orgId)),

  startUpload: managerProcedure.input(StartUploadInput).mutation(async ({ ctx, input }) => {
    const res = await startUpload(serviceDeps(ctx), ctx.orgId, appActor(ctx), input)
    if (res.ok) return { sourceId: res.sourceId, url: res.url, headers: res.headers, expiresAt: res.expiresAt }
    throw new TRPCError({ code: 'FORBIDDEN', message: res.message ?? 'source cap reached' })
  }),

  completeUpload: managerProcedure.input(CompleteUploadInput).mutation(async ({ ctx, input }) => {
    const res = await completeUpload(serviceDeps(ctx), ctx.orgId, appActor(ctx), input)
    if (res.ok) return { ok: true as const }
    if (res.code === 'not_found') throw notFound('knowledge source not found')
    throw new TRPCError({ code: 'BAD_REQUEST', message: res.message ?? 'source is not an uploadable, queued source' })
  }),

  paste: managerProcedure.input(PasteInput).mutation(async ({ ctx, input }) => {
    const res = await pasteSource(serviceDeps(ctx), ctx.orgId, appActor(ctx), input)
    if (res.ok) return { sourceId: res.sourceId }
    throw new TRPCError({ code: 'FORBIDDEN', message: res.message ?? 'source cap reached' })
  }),

  startCrawl: managerProcedure.input(StartCrawlInput).mutation(async ({ ctx, input }) => {
    const res = await startCrawl(serviceDeps(ctx), ctx.orgId, appActor(ctx), input)
    if (res.ok) return { sourceId: res.sourceId }
    throw new TRPCError({ code: 'FORBIDDEN', message: res.message ?? 'source cap reached' })
  }),

  refreshCrawl: managerProcedure.input(SourceIdInput).mutation(async ({ ctx, input }) => {
    const res = await refreshCrawl(serviceDeps(ctx), ctx.orgId, appActor(ctx), input)
    if (res.ok) return { ok: true as const }
    if (res.code === 'not_found') throw notFound('knowledge source not found')
    throw new TRPCError({ code: 'BAD_REQUEST', message: res.message ?? 'source is not a ready or failed crawl' })
  }),

  deleteSource: managerProcedure.input(SourceIdInput).mutation(async ({ ctx, input }) => {
    const res = await deleteSource(serviceDeps(ctx), ctx.orgId, appActor(ctx), input)
    if (res.ok) return { ok: true as const }
    throw notFound('knowledge source not found')
  }),

  flaggedChunks: orgProcedure.query(({ ctx }) => flaggedChunks(serviceDeps(ctx), ctx.orgId)),

  unflagChunk: managerProcedure.input(ChunkIdInput).mutation(async ({ ctx, input }) => {
    const res = await unflagChunk(serviceDeps(ctx), ctx.orgId, appActor(ctx), input)
    if (res.ok) return { ok: true as const }
    throw notFound('flagged chunk not found')
  }),

  deleteChunk: managerProcedure.input(ChunkIdInput).mutation(async ({ ctx, input }) => {
    const res = await deleteChunk(serviceDeps(ctx), ctx.orgId, appActor(ctx), input)
    if (res.ok) return { ok: true as const }
    throw notFound('flagged chunk not found')
  }),

  gaps: orgProcedure.query(({ ctx }) => gaps(serviceDeps(ctx), ctx.orgId)),
})
