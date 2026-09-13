import { randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MANAGED_MODELS } from '@aesa/contracts'
import { agentModelConfig, agents, llmCredentials, mailboxConnections, resolveModelConfig, withOrg } from '../src/index.ts'
import { createDb } from '../src/raw.ts'
import { createTestDatabase, createTestOrganization } from './helpers/test-db.ts'

describe('resolveModelConfig', () => {
  let t: Awaited<ReturnType<typeof createTestDatabase>>
  let handle: ReturnType<typeof createDb>
  let orgId: string
  let userId: string
  let agentId: string
  let credentialId: string
  beforeAll(async () => {
    t = await createTestDatabase()
    handle = createDb(t.url, { role: 'app' })
    orgId = await createTestOrganization(handle)

    const usr = await handle.pool.query<{ id: string }>(
      `INSERT INTO "user" (name, email) VALUES ($1, $2) RETURNING id`,
      ['Owner', `owner-${randomBytes(4).toString('hex')}@example.com`],
    )
    userId = usr.rows[0]!.id

    await withOrg(handle.db, orgId, async (tx) => {
      const [conn] = await tx.insert(mailboxConnections).values({
        orgId, provider: 'gmail', providerAccountId: 'acct', emailAddress: 'support@acme.test',
        status: 'connected', connectedByUserId: userId,
      }).returning({ id: mailboxConnections.id })
      const [agent] = await tx.insert(agents).values({
        orgId, connectionId: conn!.id, address: 'support@acme.test', domain: 'acme.test', displayName: 'Support', status: 'active',
      }).returning({ id: agents.id })
      agentId = agent!.id
      const [cred] = await tx.insert(llmCredentials).values({
        orgId, provider: 'openai', label: 'Prod', keyFingerprint: 'abcdef12…9xyz', createdBy: 'user:x',
      }).returning({ id: llmCredentials.id })
      credentialId = cred!.id
    })
  })
  afterAll(async () => { await handle.pool.end(); await t.drop() })

  it('no row → the managed default for the role, tier calibrated, generation 1', async () => {
    const draft = await withOrg(handle.db, orgId, (tx) => resolveModelConfig(tx, agentId, 'draft'))
    expect(draft).toMatchObject({ mode: 'managed', credentialId: null, provider: 'anthropic', model: MANAGED_MODELS.draft, tier: 'calibrated', modelGeneration: 1, fallbackToManaged: false, credential: null })
    const triage = await withOrg(handle.db, orgId, (tx) => resolveModelConfig(tx, agentId, 'triage'))
    expect(triage.model).toBe(MANAGED_MODELS.triage)
    expect(await withOrg(handle.db, orgId, (tx) => resolveModelConfig(tx, null, 'draft'))).toMatchObject({ mode: 'managed' })
  })

  it('a byok row resolves its credential, the catalog tier, and the probe can only lower it', async () => {
    await withOrg(handle.db, orgId, (tx) => tx.insert(agentModelConfig).values({ orgId, agentId, role: 'draft', mode: 'byok', credentialId, model: 'gpt-5', effort: 'high', fallbackToManaged: true, modelGeneration: 3 }))
    let r = await withOrg(handle.db, orgId, (tx) => resolveModelConfig(tx, agentId, 'draft'))
    expect(r).toMatchObject({ mode: 'byok', credentialId, provider: 'openai', model: 'gpt-5', effort: 'high', fallbackToManaged: true, tier: 'standard', modelGeneration: 3 })
    expect(r.credential).toMatchObject({ label: 'Prod', healthStatus: 'unknown', lastProbe: null })

    await withOrg(handle.db, orgId, (tx) => tx.update(llmCredentials).set({ lastProbe: { ok: true, probedAt: new Date().toISOString(), models: null, chat: 'ok', structured: 'none', latencyMs: 5, error: null } }).where(eq(llmCredentials.id, credentialId)))
    r = await withOrg(handle.db, orgId, (tx) => resolveModelConfig(tx, agentId, 'draft'))
    expect(r.tier).toBe('limited')   // probe found no structured output → downgraded
  })

  it('a byok row whose credential was deleted falls back to managed (ON DELETE SET NULL, then mode managed)', async () => {
    await withOrg(handle.db, orgId, (tx) => tx.delete(llmCredentials).where(eq(llmCredentials.id, credentialId)))
    const r = await withOrg(handle.db, orgId, (tx) => resolveModelConfig(tx, agentId, 'draft'))
    expect(r).toMatchObject({ mode: 'managed', credentialId: null, provider: 'anthropic', model: MANAGED_MODELS.draft })
  })
})
