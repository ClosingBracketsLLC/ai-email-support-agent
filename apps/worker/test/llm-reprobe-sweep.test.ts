import { randomBytes } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { llmCredentials, withOrg, workspaces } from '@aesa/db'
import { createDb } from '@aesa/db/raw'
import { createTestDatabase, createTestOrganization } from '@aesa/db/testing'
import { runLlmReprobeSweep, type LlmReprobeSweepDeps } from '../src/jobs/llm-reprobe-sweep.ts'
import { createWorkerLogger } from '../src/logging.ts'

const rand = () => randomBytes(4).toString('hex')

describe('llm.reprobe-sweep', () => {
  let t: Awaited<ReturnType<typeof createTestDatabase>>
  let app: ReturnType<typeof createDb>
  let orgId: string

  beforeAll(async () => {
    t = await createTestDatabase()
    app = createDb(t.url)
    orgId = await createTestOrganization(app)
    await withOrg(app.db, orgId, (tx) => tx.insert(workspaces).values({ orgId, businessName: 'Acme', timezone: 'UTC' }))
  }, 60_000)

  afterAll(async () => {
    await app.pool.end()
    await t.drop()
  })

  async function createCredential(over: Partial<typeof llmCredentials.$inferInsert> = {}): Promise<string> {
    return withOrg(app.db, orgId, async (tx) => {
      const [row] = await tx.insert(llmCredentials).values({
        orgId, provider: 'openai', label: `key-${rand()}`, keyFingerprint: 'abcd1234…7890', createdBy: 'user:test', ...over,
      }).returning({ id: llmCredentials.id })
      return row!.id
    })
  }

  const hoursAgo = (h: number) => sql.raw(`now() - interval '${h} hours'`)

  it('enqueues only the credentials that are neither dead nor freshly probed', async () => {
    const stale = await createCredential({ healthStatus: 'healthy', lastProbedAt: hoursAgo(7) as never })
    await createCredential({ healthStatus: 'dead', lastProbedAt: hoursAgo(48) as never })
    await createCredential({ healthStatus: 'healthy', lastProbedAt: hoursAgo(1) as never })
    const neverProbed = await createCredential({ healthStatus: 'unknown' })

    const enqueued: { orgId: string; credentialId: string; reason: string }[] = []
    const deps: LlmReprobeSweepDeps = {
      db: app.db,
      logger: createWorkerLogger('silent'),
      enqueueProbe: async (org, credentialId, opts) => void enqueued.push({ orgId: org, credentialId, reason: opts.reason }),
    }

    const count = await runLlmReprobeSweep(deps)

    expect(count).toBe(2)
    expect(enqueued.map((e) => e.credentialId).sort()).toEqual([stale, neverProbed].sort())
    for (const e of enqueued) {
      expect(e.orgId).toBe(orgId)
      expect(e.reason).toBe('scheduled')
    }
  })

  it('one credential failing to enqueue does not stop the rest of the sweep', async () => {
    // Under RLS a bare `db.delete` matches nothing (no `app.org_id` is set) — it must run in the org.
    await withOrg(app.db, orgId, (tx) => tx.delete(llmCredentials))
    const first = await createCredential({ healthStatus: 'healthy' })
    const second = await createCredential({ healthStatus: 'healthy' })

    const seen: string[] = []
    const deps: LlmReprobeSweepDeps = {
      db: app.db,
      logger: createWorkerLogger('silent'),
      enqueueProbe: async (_org, credentialId) => {
        seen.push(credentialId)
        if (credentialId === seen[0]) throw new Error('boss is down')
      },
    }

    const count = await runLlmReprobeSweep(deps)

    expect(seen.sort()).toEqual([first, second].sort())
    // Only the one that actually made it onto the queue is counted.
    expect(count).toBe(1)
  })
})
