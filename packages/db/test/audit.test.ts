import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { audit, auditLog, withOrg, workspaces } from '../src/index.ts'
import { createDb } from '../src/raw.ts'
import { createTestDatabase, createTestOrganization } from './helpers/test-db.ts'

describe('audit()', () => {
  let t: Awaited<ReturnType<typeof createTestDatabase>>
  let app: ReturnType<typeof createDb>
  let orgId: string
  beforeAll(async () => {
    t = await createTestDatabase(); app = createDb(t.url); orgId = await createTestOrganization(app)
    await withOrg(app.db, orgId, (tx) => tx.insert(workspaces).values({ orgId, businessName: 'A', timezone: 'UTC' }))
  })
  afterAll(async () => { await app.pool.end(); await t.drop() })

  it('writes a row for the transaction organization with the given actor and a redacted detail', async () => {
    const userId = crypto.randomUUID()
    await withOrg(app.db, orgId, (tx) => audit(tx, { actor: `user:${userId}`, action: 'workspace.create', entityType: 'workspace', entityId: orgId, detail: { businessName: 'A' }, ip: '203.0.113.9', userAgent: 'test' }))
    const rows = await withOrg(app.db, orgId, (tx) => tx.select().from(auditLog).where(eq(auditLog.action, 'workspace.create')))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ orgId, actor: `user:${userId}`, entityType: 'workspace', entityId: orgId, detail: { businessName: 'A' }, ip: '203.0.113.9', userAgent: 'test' })
  })

  it('refuses an actor that is not user:/agent:/system:', async () => {
    await expect(withOrg(app.db, orgId, (tx) => audit(tx, { actor: 'owner' as never, action: 'x', entityType: 'x', entityId: 'x' }))).rejects.toThrow(/actor must be/)
  })
})
