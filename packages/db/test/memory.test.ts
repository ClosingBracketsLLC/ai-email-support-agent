import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { customerHash, ensureCustomerHashSalt, resolvedAnswers, withOrg, workspaces } from '../src/index.ts'
import { createDb } from '../src/raw.ts'
import { createTestDatabase, createTestOrganization } from './helpers/test-db.ts'

describe('resolved_answers', () => {
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

  it('stores a scrubbed answer with its 1024-dim question vector and orders by cosine distance within the org', async () => {
    const v = (seed: number) => `[${Array.from({ length: 1024 }, (_, i) => (i === seed ? 1 : 0)).join(',')}]`
    await withOrg(handle.db, orgId, async (tx) => {
      await tx.insert(resolvedAnswers).values([
        { orgId, questionText: 'where is my order', answerBody: 'It ships tomorrow.', questionEmbedding: sql.raw(`'${v(0)}'::vector`) as never, embeddingModel: 'hash-v1', embeddingVersion: 1, expiresAt: new Date('2027-01-01') },
        { orgId, questionText: 'can i return this', answerBody: 'Yes, within 30 days.', questionEmbedding: sql.raw(`'${v(3)}'::vector`) as never, embeddingModel: 'hash-v1', embeddingVersion: 1, expiresAt: new Date('2027-01-01') },
      ])
      const rows = await tx.execute(sql`SELECT question_text, (question_embedding <=> ${v(0)}::vector) AS distance FROM resolved_answers WHERE org_id = ${orgId}::uuid ORDER BY question_embedding <=> ${v(0)}::vector`)
      expect(rows.rows.map((r) => r.question_text)).toEqual(['where is my order', 'can i return this'])
      expect(Number(rows.rows[0]!.distance)).toBeCloseTo(0, 6)
    })
  })

  it('refuses an unknown status (CHECK from the hardening migration)', async () => {
    // drizzle wraps pg errors in a DrizzleQueryError whose own .message is "Failed query: ..." — the
    // constraint name pg reports lives on .cause.constraint (knowledge.test.ts pattern), never on the
    // outer .message `toThrow(regex)` checks.
    await expect(withOrg(handle.db, orgId, (tx) =>
      tx.insert(resolvedAnswers).values({ orgId, questionText: 'q', answerBody: 'a', status: 'maybe' as never, expiresAt: new Date() }),
    )).rejects.toMatchObject({ cause: { constraint: 'resolved_answers_status_check' } })
  })

  it('ensureCustomerHashSalt mints one 32-byte salt per org and keeps it; customerHash is salted, case-insensitive and hex', async () => {
    const a = await withOrg(handle.db, orgId, (tx) => ensureCustomerHashSalt(tx, orgId))
    const b = await withOrg(handle.db, orgId, (tx) => ensureCustomerHashSalt(tx, orgId))
    expect(a).toHaveLength(32)
    expect(b.equals(a)).toBe(true)
    expect(customerHash(a, 'Casey@Customer.test')).toBe(customerHash(a, ' casey@customer.test '))
    expect(customerHash(a, 'casey@customer.test')).toMatch(/^[0-9a-f]{64}$/)
    expect(customerHash(Buffer.alloc(32, 1), 'casey@customer.test')).not.toBe(customerHash(a, 'casey@customer.test'))
  })
})
