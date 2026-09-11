import { sql } from 'drizzle-orm'
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
      const rows = await tx.execute(sql`SELECT ordinal, tsv::text AS tsv, (embedding <=> ${v(0)}::vector) AS distance FROM knowledge_chunks WHERE org_id = ${orgId} ORDER BY embedding <=> ${v(0)}::vector`)
      expect(rows.rows.map((r) => r.ordinal)).toEqual([0, 1])
      expect(String(rows.rows[0]!.tsv)).toContain("'returns'")   // simple config: no stemming, lowercased tokens — 'returns' stays 'returns'
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

  it('bumpKnowledgeVersion increments and returns the new version', async () => {
    const a = await withOrg(handle.db, orgId, (tx) => bumpKnowledgeVersion(tx, orgId))
    const b = await withOrg(handle.db, orgId, (tx) => bumpKnowledgeVersion(tx, orgId))
    expect(b).toBe(a + 1)
  })
})
