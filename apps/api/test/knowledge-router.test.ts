/**
 * The `knowledge` router (and `workspace.updateGuidance`): input → `src/knowledge/service.ts` →
 * tRPC error mapping. Follows `drafts-router.test.ts`'s harness shape — a real tRPC client over a
 * throwaway database, a recording `enqueue` fake, chunks/documents/drafts seeded directly through
 * `withOrg` on the test db handle.
 */
import { createHash, randomUUID } from 'node:crypto'
import { createTRPCClient, httpBatchLink } from '@trpc/client'
import { and, eq } from 'drizzle-orm'
import superjson from 'superjson'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  auditLog, drafts, knowledgeChunks, knowledgeDocuments, knowledgeSources, orgSettings, workspaces,
} from '@aesa/db'
import { vectorLiteral } from '@aesa/knowledge'
import { createMemoryStore, type ObjectStore } from '@aesa/knowledge/storage'
import type { EnqueueFn } from '../src/deps.ts'
import type { AppRouter } from '../src/trpc/router.ts'
import { WEB, createTestApi, insertAgent, insertConnectedMailbox, insertTicket, listen, signInWithOtp } from './helpers/app.ts'

const client = (base: string, cookie?: string) => createTRPCClient<AppRouter>({
  links: [httpBatchLink({ url: `${base}/trpc`, transformer: superjson, headers: () => ({ origin: WEB, ...(cookie ? { cookie } : {}) }) })],
})

/** `createTestApi`'s `store` is typed as the port (`ObjectStore`); `put()` is the memory
 * implementation's own test-only round-trip seam (see its doc comment in `storage/memory.ts`). */
type TestObjectStore = ReturnType<typeof createMemoryStore>

/** A pgvector(1024) literal — the column enforces exact dimensionality on insert, and (same as the
 * worker's own `knowledge-embed-batch.ts`) drizzle's `vector` column only accepts a raw SQL literal
 * on write, never a plain `number[]`. */
const FAKE_EMBEDDING = vectorLiteral(new Array(1024).fill(0.001)) as never

describe('knowledge router', () => {
  let t: Awaited<ReturnType<typeof createTestApi>>
  let base: string
  let sent: { name: string; data: Record<string, unknown>; opts: Record<string, unknown> }[]
  let seq = 0

  beforeAll(async () => {
    sent = []
    const enqueue: EnqueueFn = async (name, data, opts) => { sent.push({ name, data, opts: opts as Record<string, unknown> }); return `job-${sent.length}` }
    t = await createTestApi({}, { enqueue })
    base = await listen(t.app)
  })
  afterAll(async () => { await t.close() })
  beforeEach(() => { sent.length = 0 })

  async function seedOrg() {
    const n = ++seq
    const signed = await signInWithOtp(t.app, t.mail, `knowledge-${n}@example.com`, 'Owner')
    const c = client(base, signed.cookie)
    const { orgId } = await c.workspace.create.mutate({ businessName: 'Acme', timezone: 'UTC' })
    return { orgId, c, userId: signed.user.id }
  }

  async function setCap(orgId: string, key: string, value: number) {
    await t.api.withOrg(orgId, (tx) => tx.insert(orgSettings).values({ orgId, key, value }))
  }

  async function insertSource(orgId: string, overrides: Partial<typeof knowledgeSources.$inferInsert> = {}) {
    const [row] = await t.api.withOrg(orgId, (tx) =>
      tx.insert(knowledgeSources).values({ orgId, kind: 'upload', status: 'ready', title: 'Doc', ...overrides }).returning(),
    )
    return row!
  }

  async function insertDocument(orgId: string, sourceId: string, overrides: Partial<typeof knowledgeDocuments.$inferInsert> = {}) {
    const [row] = await t.api.withOrg(orgId, (tx) =>
      tx.insert(knowledgeDocuments).values({ orgId, sourceId, uri: `upload:${sourceId}`, contentHash: 'hash', ...overrides }).returning(),
    )
    return row!
  }

  async function insertChunk(orgId: string, documentId: string, overrides: Partial<typeof knowledgeChunks.$inferInsert> = {}) {
    const [row] = await t.api.withOrg(orgId, (tx) =>
      tx.insert(knowledgeChunks).values({ orgId, documentId, ordinal: 0, content: 'chunk text', tokenCount: 3, ...overrides }).returning(),
    )
    return row!
  }

  async function auditRows(orgId: string, action: string, entityId?: string) {
    return t.api.withOrg(orgId, (tx) =>
      tx.select().from(auditLog).where(entityId ? and(eq(auditLog.action, action), eq(auditLog.entityId, entityId)) : eq(auditLog.action, action)),
    )
  }

  // ── list ─────────────────────────────────────────────────────────────────

  it('list returns knowledgeVersion, counts and every source view (crawlProgress only on the crawl row)', async () => {
    const org = await seedOrg()
    const older = new Date(Date.now() - 60_000)
    const upload = await insertSource(org.orgId, {
      kind: 'upload', status: 'processing', title: 'Manual.pdf', mime: 'application/pdf', byteSize: 1234, createdAt: older,
    })
    const crawl = await insertSource(org.orgId, {
      kind: 'crawl', status: 'ready', title: 'https://example.com/kb', url: 'https://example.com/kb',
      crawlConfig: { maxPages: 20, progress: { fetched: 5, ingested: 4, skipped: 1 } },
    })

    const doc = await insertDocument(org.orgId, crawl.id)
    await insertChunk(org.orgId, doc.id, { embedding: FAKE_EMBEDDING, injectionFlagged: false })
    await insertChunk(org.orgId, doc.id, { ordinal: 1, injectionFlagged: true, injectionReason: 'looked like an instruction' })

    const res = await org.c.knowledge.list.query()
    expect(res.knowledgeVersion).toBe(0)
    expect(res.counts).toEqual({ sources: 2, readyChunks: 1, flaggedChunks: 1 })
    expect(res.sources.map((s) => s.id)).toEqual([crawl.id, upload.id])
    expect(res.sources[0]).toMatchObject({ kind: 'crawl', status: 'ready', url: 'https://example.com/kb', crawlProgress: { fetched: 5, ingested: 4, skipped: 1 } })
    expect(res.sources[1]).toMatchObject({ kind: 'upload', status: 'processing', mime: 'application/pdf', byteSize: 1234, crawlProgress: null })
  })

  it('list returns caps resolved the SAME way the mutations clamp with (org override wins over the plan default), and canManage false for a plain member', async () => {
    const org = await seedOrg()
    const defaults = await org.c.knowledge.list.query()
    // Core settings-catalog defaults (packages/core/src/settings-catalog.ts): a brand-new org with no
    // org_settings override and no plan override sits on the code defaults.
    expect(defaults.caps).toEqual({ maxSources: 100, maxCrawlPages: 200 })
    expect(defaults.canManage).toBe(true)

    await setCap(org.orgId, 'knowledge.max_sources', 5)
    await setCap(org.orgId, 'knowledge.max_crawl_pages', 7)
    const overridden = await org.c.knowledge.list.query()
    expect(overridden.caps).toEqual({ maxSources: 5, maxCrawlPages: 7 })

    // A plain member sees the same caps but canManage: false — same invite → accept → set-active
    // round trip team.test.ts's "accept" case uses.
    const memberEmail = `knowledge-member-${seq}@example.com`
    const memberSignIn = await signInWithOtp(t.app, t.mail, memberEmail, 'Bob')
    const { invitationId } = await org.c.team.invite.mutate({ email: memberEmail, role: 'member' })
    await t.app.inject({
      method: 'POST', url: '/api/auth/organization/accept-invitation',
      headers: { origin: WEB, cookie: memberSignIn.cookie, 'content-type': 'application/json' }, payload: { invitationId },
    })
    await t.app.inject({
      method: 'POST', url: '/api/auth/organization/set-active',
      headers: { origin: WEB, cookie: memberSignIn.cookie, 'content-type': 'application/json' }, payload: { organizationId: org.orgId },
    })
    const memberClient = client(base, memberSignIn.cookie)
    const asMember = await memberClient.knowledge.list.query()
    expect(asMember.canManage).toBe(false)
    expect(asMember.caps).toEqual({ maxSources: 5, maxCrawlPages: 7 })
  })

  // ── startUpload / completeUpload ────────────────────────────────────────

  it('startUpload presigns a PUT and audits; completeUpload enqueues knowledge.ingest; a wrong kind is BAD_REQUEST', async () => {
    const org = await seedOrg()
    const res = await org.c.knowledge.startUpload.mutate({ fileName: 'manual.pdf', mime: 'application/pdf', byteSize: 2048 })
    expect(res.sourceId).toBeTruthy()
    expect(res.url).toContain(res.sourceId)
    expect(res.headers['content-type']).toBe('application/pdf')
    expect(res.expiresAt.getTime()).toBeGreaterThan(Date.now())

    const [row] = await t.api.withOrg(org.orgId, (tx) => tx.select().from(knowledgeSources).where(eq(knowledgeSources.id, res.sourceId)))
    expect(row).toMatchObject({ kind: 'upload', status: 'queued', title: 'manual.pdf', mime: 'application/pdf', byteSize: 2048 })
    expect(row!.storageKey).toContain(res.sourceId)
    expect(await auditRows(org.orgId, 'knowledge.source.created', res.sourceId)).toHaveLength(1)
    expect(sent).toEqual([])

    await org.c.knowledge.completeUpload.mutate({ sourceId: res.sourceId })
    expect(sent).toEqual([{ name: 'knowledge.ingest', data: { orgId: org.orgId, sourceId: res.sourceId }, opts: { entityId: res.sourceId } }])
    expect(await auditRows(org.orgId, 'knowledge.source.upload_completed', res.sourceId)).toHaveLength(1)

    const pasted = await org.c.knowledge.paste.mutate({ title: 'Notes', text: 'hello world' })
    await expect(org.c.knowledge.completeUpload.mutate({ sourceId: pasted.sourceId }))
      .rejects.toMatchObject({ data: { code: 'BAD_REQUEST' } })
  })

  it("startUpload's presign asks for exactly a 600-second URL (a recording spy wrapping the memory store, passed through createTestApi's store override)", async () => {
    const inner = createMemoryStore()
    const presignCalls: { key: string; opts: { contentType: string; expiresSeconds: number } }[] = []
    const spyStore: ObjectStore = {
      presignPut: async (key, opts) => { presignCalls.push({ key, opts }); return inner.presignPut(key, opts) },
      head: (key) => inner.head(key),
      get: (key) => inner.get(key),
      delete: (key) => inner.delete(key),
    }
    const t2 = await createTestApi({}, { store: spyStore })
    try {
      const base2 = await listen(t2.app)
      const signed = await signInWithOtp(t2.app, t2.mail, 'presign-spy@example.com', 'Owner')
      const c2 = client(base2, signed.cookie)
      await c2.workspace.create.mutate({ businessName: 'Acme', timezone: 'UTC' })
      const res = await c2.knowledge.startUpload.mutate({ fileName: 'a.txt', mime: 'text/plain', byteSize: 3 })

      expect(presignCalls).toHaveLength(1)
      expect(presignCalls[0]!.key).toContain(res.sourceId)
      expect(presignCalls[0]!.opts).toEqual({ contentType: 'text/plain', expiresSeconds: 600 })
    } finally {
      await t2.close()
    }
  })

  it('startUpload over knowledge.max_sources is FORBIDDEN with a clear message', async () => {
    const org = await seedOrg()
    await setCap(org.orgId, 'knowledge.max_sources', 1)
    await org.c.knowledge.startUpload.mutate({ fileName: 'first.txt', mime: 'text/plain', byteSize: 10 })

    await expect(org.c.knowledge.startUpload.mutate({ fileName: 'second.txt', mime: 'text/plain', byteSize: 10 }))
      .rejects.toMatchObject({ data: { code: 'FORBIDDEN' }, message: expect.stringContaining('knowledge.max_sources') })
  })

  // ── paste ────────────────────────────────────────────────────────────────

  it('paste inserts a queued source with a sha256 content_hash and enqueues knowledge.ingest', async () => {
    const org = await seedOrg()
    const res = await org.c.knowledge.paste.mutate({ title: 'FAQ', text: 'Our return window is 30 days.' })

    const [row] = await t.api.withOrg(org.orgId, (tx) => tx.select().from(knowledgeSources).where(eq(knowledgeSources.id, res.sourceId)))
    expect(row).toMatchObject({ kind: 'paste', status: 'queued', title: 'FAQ', pastedText: 'Our return window is 30 days.' })
    expect(row!.contentHash).toBe(createHash('sha256').update('Our return window is 30 days.', 'utf8').digest('hex'))
    expect(sent).toEqual([{ name: 'knowledge.ingest', data: { orgId: org.orgId, sourceId: res.sourceId }, opts: { entityId: res.sourceId } }])
    expect(await auditRows(org.orgId, 'knowledge.source.created', res.sourceId)).toHaveLength(1)
  })

  // ── startCrawl / refreshCrawl ────────────────────────────────────────────

  it('startCrawl dedupes a live source per URL: queued/processing return the same id with no new enqueue; a ready re-queue uses the CALLER\'s clamped maxPages, not the stored one; failed inserts a new row', async () => {
    const org = await seedOrg()
    await setCap(org.orgId, 'knowledge.max_crawl_pages', 300)
    const url = 'https://example.com/kb'

    const first = await org.c.knowledge.startCrawl.mutate({ url, maxPages: 50 })
    expect(sent).toEqual([{ name: 'knowledge.crawl', data: { orgId: org.orgId, sourceId: first.sourceId }, opts: { entityId: first.sourceId } }])
    expect(await auditRows(org.orgId, 'knowledge.source.created', first.sourceId)).toHaveLength(1)

    // Still `queued`: a second call returns the same id, no new enqueue, no new audit row.
    sent.length = 0
    const second = await org.c.knowledge.startCrawl.mutate({ url, maxPages: 999 })
    expect(second.sourceId).toBe(first.sourceId)
    expect(sent).toEqual([])
    expect(await auditRows(org.orgId, 'knowledge.source.created', first.sourceId)).toHaveLength(1)

    // Flip to `ready` (as the crawl job would) and call again with a DIFFERENT maxPages: the
    // caller's own clamped value (min(150, 300) = 150) wins over the stored 50 — minor #1 (an
    // owner re-asking to crawl a finished site gets what THEY just asked for, unlike the standalone
    // `refreshCrawl` below, which keeps the row's own stored budget instead).
    await t.api.withOrg(org.orgId, (tx) => tx.update(knowledgeSources)
      .set({ status: 'ready', crawlConfig: { maxPages: 50, progress: { fetched: 10, ingested: 9, skipped: 1 } } })
      .where(eq(knowledgeSources.id, first.sourceId)))
    sent.length = 0
    const third = await org.c.knowledge.startCrawl.mutate({ url, maxPages: 150 })
    expect(third.sourceId).toBe(first.sourceId)
    expect(sent).toEqual([{ name: 'knowledge.crawl', data: { orgId: org.orgId, sourceId: first.sourceId }, opts: { entityId: first.sourceId } }])
    expect(await auditRows(org.orgId, 'knowledge.source.crawl_requeued', first.sourceId)).toHaveLength(1)
    const [requeued] = await t.api.withOrg(org.orgId, (tx) => tx.select().from(knowledgeSources).where(eq(knowledgeSources.id, first.sourceId)))
    expect(requeued).toMatchObject({ status: 'queued' })
    expect((requeued!.crawlConfig as { progress?: unknown }).progress).toBeUndefined()
    expect((requeued!.crawlConfig as { maxPages: number }).maxPages).toBe(150) // the caller's clamped value, not the stored 50

    // Flip to `failed`: excluded from the dedupe match, so a new call inserts a fresh row.
    await t.api.withOrg(org.orgId, (tx) => tx.update(knowledgeSources).set({ status: 'failed' }).where(eq(knowledgeSources.id, first.sourceId)))
    const fourth = await org.c.knowledge.startCrawl.mutate({ url, maxPages: 5 })
    expect(fourth.sourceId).not.toBe(first.sourceId)
    const all = await t.api.withOrg(org.orgId, (tx) => tx.select().from(knowledgeSources).where(eq(knowledgeSources.orgId, org.orgId)))
    expect(all.filter((r) => r.kind === 'crawl')).toHaveLength(2)
  })

  it('startCrawl normalizes the URL: http:// is BAD_REQUEST, and case/fragment variants of one https URL dedupe to a single source', async () => {
    const org = await seedOrg()
    await expect(org.c.knowledge.startCrawl.mutate({ url: 'http://example.com/kb', maxPages: 10 }))
      .rejects.toMatchObject({ data: { code: 'BAD_REQUEST' }, message: expect.stringContaining('https://') })

    // `normalizeUrl` (packages/knowledge/src/crawler/url.ts) lowercases the host and strips the
    // fragment, but does NOT collapse a bare trailing slash (only a `/index.html` suffix) — so the
    // pair this dedupes on differs by case and fragment, not by trailing slash.
    const first = await org.c.knowledge.startCrawl.mutate({ url: 'https://Example.com/kb#section', maxPages: 10 })
    const second = await org.c.knowledge.startCrawl.mutate({ url: 'https://example.com/kb', maxPages: 10 })
    expect(second.sourceId).toBe(first.sourceId)

    const [row] = await t.api.withOrg(org.orgId, (tx) => tx.select().from(knowledgeSources).where(eq(knowledgeSources.id, first.sourceId)))
    expect(row).toMatchObject({ url: 'https://example.com/kb', title: 'https://example.com/kb' })

    const all = await t.api.withOrg(org.orgId, (tx) =>
      tx.select().from(knowledgeSources).where(and(eq(knowledgeSources.orgId, org.orgId), eq(knowledgeSources.kind, 'crawl'))))
    expect(all).toHaveLength(1)
  })

  it('startCrawl clamps maxPages to knowledge.max_crawl_pages and checks the source cap only when it inserts a new row', async () => {
    const org = await seedOrg()
    await setCap(org.orgId, 'knowledge.max_crawl_pages', 10)
    const res = await org.c.knowledge.startCrawl.mutate({ url: 'https://example.com/big', maxPages: 500 })
    const [row] = await t.api.withOrg(org.orgId, (tx) => tx.select().from(knowledgeSources).where(eq(knowledgeSources.id, res.sourceId)))
    expect((row!.crawlConfig as { maxPages: number }).maxPages).toBe(10)

    await setCap(org.orgId, 'knowledge.max_sources', 1)
    await expect(org.c.knowledge.startCrawl.mutate({ url: 'https://example.com/second', maxPages: 5 }))
      .rejects.toMatchObject({ data: { code: 'FORBIDDEN' } })
  })

  it('refreshCrawl re-queues a ready or failed crawl source, KEEPING its own stored maxPages budget (only reclamped to a shrunk cap), and enqueues knowledge.crawl; a queued source is BAD_REQUEST', async () => {
    const org = await seedOrg()
    const failed = await insertSource(org.orgId, {
      kind: 'crawl', status: 'failed', title: 'https://example.com/x', url: 'https://example.com/x',
      crawlConfig: { maxPages: 7 }, failureReason: 'crawl_failed', failureDetail: 'boom',
    })

    const res = await org.c.knowledge.refreshCrawl.mutate({ sourceId: failed.id })
    expect(res).toEqual({ ok: true })
    expect(sent).toEqual([{ name: 'knowledge.crawl', data: { orgId: org.orgId, sourceId: failed.id }, opts: { entityId: failed.id } }])
    expect(await auditRows(org.orgId, 'knowledge.source.crawl_requeued', failed.id)).toHaveLength(1)
    const [row] = await t.api.withOrg(org.orgId, (tx) => tx.select().from(knowledgeSources).where(eq(knowledgeSources.id, failed.id)))
    expect(row).toMatchObject({ status: 'queued', failureReason: null, failureDetail: null })
    // `refreshCrawl` takes no `maxPages` input — unlike `startCrawl`'s ready-requeue above, it keeps
    // the row's OWN stored budget (7), not the (unset, so default 200) cap.
    expect((row!.crawlConfig as { maxPages: number }).maxPages).toBe(7)

    // A stored budget above a cap that has since shrunk is reclamped down, not left over the cap.
    const overCap = await insertSource(org.orgId, {
      kind: 'crawl', status: 'ready', title: 'https://example.com/w', url: 'https://example.com/w', crawlConfig: { maxPages: 50 },
    })
    await setCap(org.orgId, 'knowledge.max_crawl_pages', 3)
    await org.c.knowledge.refreshCrawl.mutate({ sourceId: overCap.id })
    const [reclamped] = await t.api.withOrg(org.orgId, (tx) => tx.select().from(knowledgeSources).where(eq(knowledgeSources.id, overCap.id)))
    expect((reclamped!.crawlConfig as { maxPages: number }).maxPages).toBe(3)

    const queued = await insertSource(org.orgId, { kind: 'crawl', status: 'queued', title: 'https://example.com/y', url: 'https://example.com/y' })
    await expect(org.c.knowledge.refreshCrawl.mutate({ sourceId: queued.id })).rejects.toMatchObject({ data: { code: 'BAD_REQUEST' } })
  })

  // ── deleteSource ─────────────────────────────────────────────────────────

  it('deleteSource removes the row, bumps knowledgeVersion, audits and deletes the uploaded object outside the transaction', async () => {
    const org = await seedOrg()
    const upload = await org.c.knowledge.startUpload.mutate({ fileName: 'file.txt', mime: 'text/plain', byteSize: 5 })
    const [before] = await t.api.withOrg(org.orgId, (tx) => tx.select().from(knowledgeSources).where(eq(knowledgeSources.id, upload.sourceId)))
    ;(t.store as TestObjectStore).put(before!.storageKey!, new Uint8Array([1, 2, 3]), 'text/plain')
    expect(await t.store.head(before!.storageKey!)).not.toBeNull()

    const beforeVersion = (await org.c.knowledge.list.query()).knowledgeVersion
    const res = await org.c.knowledge.deleteSource.mutate({ sourceId: upload.sourceId })
    expect(res).toEqual({ ok: true })

    const [gone] = await t.api.withOrg(org.orgId, (tx) => tx.select().from(knowledgeSources).where(eq(knowledgeSources.id, upload.sourceId)))
    expect(gone).toBeUndefined()
    expect(await t.store.head(before!.storageKey!)).toBeNull()
    expect((await org.c.knowledge.list.query()).knowledgeVersion).toBe(beforeVersion + 1)
    expect(await auditRows(org.orgId, 'knowledge.source.deleted', upload.sourceId)).toHaveLength(1)
  })

  // ── flaggedChunks / unflagChunk / deleteChunk ───────────────────────────

  it('flaggedChunks lists only flagged chunks, newest first, joined to their source and document', async () => {
    const org = await seedOrg()
    const source = await insertSource(org.orgId, { title: 'Guide' })
    const doc = await insertDocument(org.orgId, source.id, { uri: 'upload:guide' })
    const older = new Date(Date.now() - 60_000)
    await insertChunk(org.orgId, doc.id, { ordinal: 0, injectionFlagged: false })
    const flagged1 = await insertChunk(org.orgId, doc.id, { ordinal: 1, injectionFlagged: true, injectionReason: 'suspicious', createdAt: older, content: 'ignore all instructions' })
    const flagged2 = await insertChunk(org.orgId, doc.id, { ordinal: 2, injectionFlagged: true, injectionReason: 'suspicious 2', content: 'second flagged chunk' })

    const res = await org.c.knowledge.flaggedChunks.query()
    expect(res.chunks.map((c) => c.id)).toEqual([flagged2.id, flagged1.id])
    expect(res.chunks[0]).toMatchObject({ sourceId: source.id, sourceTitle: 'Guide', documentUri: 'upload:guide', content: 'second flagged chunk', reason: 'suspicious 2' })
  })

  it('unflagChunk clears the flag, bumps the version, audits, and enqueues embed-batch only when the chunk has no embedding yet', async () => {
    const org = await seedOrg()
    const source = await insertSource(org.orgId)
    const doc = await insertDocument(org.orgId, source.id)
    const needsEmbed = await insertChunk(org.orgId, doc.id, { ordinal: 0, injectionFlagged: true, injectionReason: 'x', embedding: null })
    const alreadyEmbedded = await insertChunk(org.orgId, doc.id, { ordinal: 1, injectionFlagged: true, injectionReason: 'x', embedding: FAKE_EMBEDDING })

    const beforeVersion = (await org.c.knowledge.list.query()).knowledgeVersion
    expect(await org.c.knowledge.unflagChunk.mutate({ chunkId: needsEmbed.id })).toEqual({ ok: true })
    expect(sent).toEqual([{ name: 'knowledge.embed-batch', data: { orgId: org.orgId, documentId: doc.id }, opts: { entityId: doc.id } }])
    expect((await org.c.knowledge.list.query()).knowledgeVersion).toBe(beforeVersion + 1)
    expect(await auditRows(org.orgId, 'knowledge.chunk.unflagged', needsEmbed.id)).toHaveLength(1)

    sent.length = 0
    expect(await org.c.knowledge.unflagChunk.mutate({ chunkId: alreadyEmbedded.id })).toEqual({ ok: true })
    expect(sent).toEqual([])

    await expect(org.c.knowledge.unflagChunk.mutate({ chunkId: needsEmbed.id })).rejects.toMatchObject({ data: { code: 'NOT_FOUND' } })
  })

  it('deleteChunk removes a flagged chunk, bumps the version and audits; an unflagged chunk is NOT_FOUND', async () => {
    const org = await seedOrg()
    const source = await insertSource(org.orgId)
    const doc = await insertDocument(org.orgId, source.id)
    const flagged = await insertChunk(org.orgId, doc.id, { injectionFlagged: true, injectionReason: 'x' })
    const clean = await insertChunk(org.orgId, doc.id, { ordinal: 1, injectionFlagged: false })

    const beforeVersion = (await org.c.knowledge.list.query()).knowledgeVersion
    expect(await org.c.knowledge.deleteChunk.mutate({ chunkId: flagged.id })).toEqual({ ok: true })
    expect((await org.c.knowledge.list.query()).knowledgeVersion).toBe(beforeVersion + 1)
    expect(await auditRows(org.orgId, 'knowledge.chunk.deleted', flagged.id)).toHaveLength(1)
    const [gone] = await t.api.withOrg(org.orgId, (tx) => tx.select().from(knowledgeChunks).where(eq(knowledgeChunks.id, flagged.id)))
    expect(gone).toBeUndefined()

    await expect(org.c.knowledge.deleteChunk.mutate({ chunkId: clean.id })).rejects.toMatchObject({ data: { code: 'NOT_FOUND' } })
  })

  // ── gaps ─────────────────────────────────────────────────────────────────

  it('gaps: 30-day drafts/uncited counts and questions grouped case/whitespace-insensitively, top by count', async () => {
    const org = await seedOrg()
    const connectionId = await insertConnectedMailbox(t.api, org.orgId, org.userId, `support${seq}@acme.test`)
    const agentId = await insertAgent(t.api, org.orgId, connectionId, `support${seq}@acme.test`)
    const uncitedTicket = await insertTicket(t.api, org.orgId, { connectionId, agentId, status: 'resolved' })
    const citedTicket = await insertTicket(t.api, org.orgId, { connectionId, agentId, status: 'resolved' })
    const now = new Date()
    const expiresAt = new Date(now.getTime() + 86_400_000)

    await t.api.withOrg(org.orgId, (tx) => tx.insert(drafts).values({
      orgId: org.orgId, ticketId: uncitedTicket.id, version: 1, body: 'x', decision: 'review', decisionReason: 'ok',
      threadSnapshotAt: now, expiresAt, citedChunkIds: [],
      unresolvedQuestions: ['how long is the warranty?', 'HOW LONG IS THE WARRANTY?'],
    }))
    await t.api.withOrg(org.orgId, (tx) => tx.insert(drafts).values({
      orgId: org.orgId, ticketId: citedTicket.id, version: 1, body: 'x', decision: 'review', decisionReason: 'ok',
      threadSnapshotAt: now, expiresAt, citedChunkIds: [randomUUID()], unresolvedQuestions: [],
    }))

    const res = await org.c.knowledge.gaps.query()
    expect(res.windowDays).toBe(30)
    expect(res.drafts).toBe(2)
    expect(res.uncited).toBe(1)
    expect(res.questions).toHaveLength(1)
    expect(res.questions[0]!.count).toBe(2)
    expect(res.questions[0]!.text.toLowerCase()).toBe('how long is the warranty?')
    expect(res.questions[0]!.lastTicketId).toBe(uncitedTicket.id)
    expect(res.questions[0]!.lastAt).toBeInstanceOf(Date)
  })

  // ── workspace.updateGuidance ─────────────────────────────────────────────

  it('workspace.updateGuidance writes operating_guidance and audits the length, never the text', async () => {
    const org = await seedOrg()
    const text = 'Always mention our 30-day return window when asked about refunds.'
    const res = await org.c.workspace.updateGuidance.mutate({ operatingGuidance: text })
    expect(res.operatingGuidance).toBe(text)

    const [row] = await t.api.withOrg(org.orgId, (tx) => tx.select().from(workspaces).where(eq(workspaces.orgId, org.orgId)))
    expect(row!.operatingGuidance).toBe(text)

    const rows = await auditRows(org.orgId, 'workspace.guidance.update', org.orgId)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.detail).toEqual({ length: text.length })
    expect(JSON.stringify(rows[0]!.detail)).not.toContain('30-day')
  })

  // ── cross-org isolation ──────────────────────────────────────────────────

  it("a second org's session sees none of the first org's sources; deleteSource across orgs is NOT_FOUND", async () => {
    const org = await seedOrg()
    const other = await seedOrg()
    await insertSource(org.orgId, { title: 'Private doc' })

    expect((await other.c.knowledge.list.query()).sources).toEqual([])
    const [mine] = (await org.c.knowledge.list.query()).sources
    await expect(other.c.knowledge.deleteSource.mutate({ sourceId: mine!.id })).rejects.toMatchObject({ data: { code: 'NOT_FOUND' } })

    const [stillThere] = await t.api.withOrg(org.orgId, (tx) => tx.select().from(knowledgeSources).where(eq(knowledgeSources.id, mine!.id)))
    expect(stillThere).toBeDefined()
  })
})
