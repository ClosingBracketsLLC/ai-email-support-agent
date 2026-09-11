import { and, eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bumpKnowledgeVersion, knowledgeChunks, knowledgeDocuments, knowledgeSources, withOrg, workspaces } from '../src/index.ts'
import { createDb } from '../src/raw.ts'
import { createTestDatabase, createTestOrganization } from './helpers/test-db.ts'

describe('knowledge tables', () => {
  let t: Awaited<ReturnType<typeof createTestDatabase>>
  let handle: ReturnType<typeof createDb>
  let orgId: string
  beforeAll(async () => {
    t = await createTestDatabase()
    handle = createDb(t.url, { role: 'app' })
    orgId = await createTestOrganization(handle)
    await withOrg(handle.db, orgId, (tx) => tx.insert(workspaces).values({ orgId, businessName: 'Acme', timezone: 'UTC' }))
  })
  afterAll(async () => { await handle.pool.end(); await t.drop() })

  it('stores a 1024-dim vector, generates the tsvector, and orders by cosine distance within the org', async () => {
    const v = (seed: number) => `[${Array.from({ length: 1024 }, (_, i) => (i === seed ? 1 : 0)).join(',')}]`
    await withOrg(handle.db, orgId, async (tx) => {
      const [src] = await tx.insert(knowledgeSources).values({ orgId, kind: 'paste', title: 'FAQ', pastedText: 'x' }).returning({ id: knowledgeSources.id })
      const [doc] = await tx.insert(knowledgeDocuments).values({ orgId, sourceId: src!.id, uri: 'paste:1', contentHash: 'h' }).returning({ id: knowledgeDocuments.id })
      await tx.insert(knowledgeChunks).values([
        { orgId, documentId: doc!.id, ordinal: 0, headingPath: ['Returns'], content: 'Returns are accepted within 30 days.', tokenCount: 9, embedding: sql.raw(`'${v(0)}'::vector`) as never, embeddingModel: 'hash-v1', embeddingVersion: 1 },
        { orgId, documentId: doc!.id, ordinal: 1, headingPath: ['Shipping'], content: 'We ship worldwide.', tokenCount: 5, embedding: sql.raw(`'${v(5)}'::vector`) as never, embeddingModel: 'hash-v1', embeddingVersion: 1 },
      ])
      // Probe with v(5) — ordinal 1's own embedding, NOT the vector either row was inserted first with —
      // so the ordering flip actually exercises ORDER BY embedding <=> :probe rather than coincidentally
      // matching insertion order the way probing with v(0) (ordinal 0's own embedding) would.
      const rows = await tx.execute(sql`SELECT ordinal, tsv::text AS tsv, (embedding <=> ${v(5)}::vector) AS distance FROM knowledge_chunks WHERE org_id = ${orgId} ORDER BY embedding <=> ${v(5)}::vector`)
      expect(rows.rows.map((r) => r.ordinal)).toEqual([1, 0])
      expect(String(rows.rows[0]!.tsv)).toContain("'worldwide'")   // simple config: no stemming, lowercased tokens
      expect(Number(rows.rows[0]!.distance)).toBeCloseTo(0, 6)
    })
  })

  it('refuses a chunk over 3000 characters and an unknown source kind (CHECKs from the hardening migration)', async () => {
    // drizzle wraps pg errors in a DrizzleQueryError whose own .message is "Failed query: ..." — the
    // constraint name pg reports lives on .cause.constraint (and inside .cause.message), never on the
    // outer .message `toThrow(regex)` checks — so match the cause the pg driver actually attaches.
    await expect(withOrg(handle.db, orgId, (tx) => tx.insert(knowledgeSources).values({ orgId, kind: 'rss' as never, title: 'x' })))
      .rejects.toMatchObject({ cause: { constraint: 'knowledge_sources_kind_check' } })
    await expect(withOrg(handle.db, orgId, async (tx) => {
      const [src] = await tx.insert(knowledgeSources).values({ orgId, kind: 'paste', title: 'x' }).returning({ id: knowledgeSources.id })
      const [doc] = await tx.insert(knowledgeDocuments).values({ orgId, sourceId: src!.id, uri: 'paste:2', contentHash: 'h' }).returning({ id: knowledgeDocuments.id })
      await tx.insert(knowledgeChunks).values({ orgId, documentId: doc!.id, ordinal: 0, content: 'x'.repeat(3001), tokenCount: 1 })
    })).rejects.toMatchObject({ cause: { constraint: 'knowledge_chunks_content_check' } })
  })

  it('claim_token is a nullable uuid: a claiming job writes one and a mismatched token matches nothing', async () => {
    const tokenA = crypto.randomUUID()
    const tokenB = crypto.randomUUID()
    await withOrg(handle.db, orgId, async (tx) => {
      const [src] = await tx.insert(knowledgeSources).values({ orgId, kind: 'crawl', title: 'shop.test', url: 'https://shop.test/' })
        .returning({ id: knowledgeSources.id, claimToken: knowledgeSources.claimToken })
      expect(src!.claimToken).toBeNull()   // nullable, and nothing defaults it

      await tx.update(knowledgeSources).set({ status: 'processing', claimToken: tokenA }).where(eq(knowledgeSources.id, src!.id))
      // The shape every guarded write of a claiming run uses: status AND token.
      const mismatched = await tx.update(knowledgeSources).set({ status: 'ready' })
        .where(and(eq(knowledgeSources.id, src!.id), eq(knowledgeSources.status, 'processing'), eq(knowledgeSources.claimToken, tokenB)))
        .returning({ id: knowledgeSources.id })
      expect(mismatched).toHaveLength(0)
      const matched = await tx.update(knowledgeSources).set({ status: 'ready', claimToken: null })
        .where(and(eq(knowledgeSources.id, src!.id), eq(knowledgeSources.status, 'processing'), eq(knowledgeSources.claimToken, tokenA)))
        .returning({ id: knowledgeSources.id })
      expect(matched).toHaveLength(1)
    })
  })

  it('bumpKnowledgeVersion increments and returns the new version', async () => {
    const a = await withOrg(handle.db, orgId, (tx) => bumpKnowledgeVersion(tx, orgId))
    expect(a).toBe(1)   // workspaces.knowledge_version defaults to 0; nothing earlier in this file bumps it
    const b = await withOrg(handle.db, orgId, (tx) => bumpKnowledgeVersion(tx, orgId))
    expect(b).toBe(a + 1)
  })

  it('bumpKnowledgeVersion rejects when the org has no workspace row', async () => {
    const orphanOrgId = await createTestOrganization(handle, 'Orphan Org')   // organization row, no matching workspaces row
    await expect(withOrg(handle.db, orphanOrgId, (tx) => bumpKnowledgeVersion(tx, orphanOrgId))).rejects.toThrow(/no workspace/)
  })
})
