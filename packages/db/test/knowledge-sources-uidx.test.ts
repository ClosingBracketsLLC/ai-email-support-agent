import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { knowledgeSources, withOrg } from '../src/index.ts'
import { createDb } from '../src/raw.ts'
import { createTestDatabase, createTestOrganization } from '../src/testing.ts'

describe('knowledge_sources_org_crawl_url_uidx', () => {
  let t: Awaited<ReturnType<typeof createTestDatabase>>
  let handle: ReturnType<typeof createDb>
  let orgId: string
  beforeAll(async () => { t = await createTestDatabase(); handle = createDb(t.url, { role: 'app' }); orgId = await createTestOrganization(handle) })
  afterAll(async () => { await handle.pool.end(); await t.drop() })

  const insert = (status: string) => withOrg(handle.db, orgId, (tx) =>
    tx.insert(knowledgeSources).values({ orgId, kind: 'crawl', status, url: 'https://example.test/', title: 'x' }).returning({ id: knowledgeSources.id }))

  it('refuses a second live crawl of the same URL but allows one beside a failed one', async () => {
    await insert('queued')
    await expect(insert('ready')).rejects.toMatchObject({ cause: { code: '23505' } })
    await insert('failed')          // a failed row never blocks
  })
})
