import { randomBytes } from 'node:crypto'
import { getTableName, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadKekRing } from '@aesa/crypto'
import {
  agentCategoryPolicies, agentModelConfig, agentRunEvents, agentRuns, agents, audit,
  categories, categoryStatsDaily, draftActionTokens, drafts, gmailAccessRequests, guidanceSuggestions,
  knowledgeChunks, knowledgeDocuments, knowledgeSources, llmCalls, llmCredentialSecrets, llmCredentials,
  mailboxConnections, mailboxCredentials, messages, notificationDevices, notifications, oauthFlows,
  orgSettings, outboundSends, resolvedAnswers, tickets, usageCounters, withOrg, withPlatform, workspaces,
} from '../src/index.ts'
import { ensureBillingRow } from '../src/billing.ts'
import { provisionOrgKeys } from '../src/keys.ts'
import { PURGE_ORDER, purgeAuthRows, purgeWorkspace } from '../src/purge.ts'
import { createDb } from '../src/raw.ts'
import { createTestDatabase, createTestOrganization } from './helpers/test-db.ts'
import { EXPECTED_TABLES, RLS_EXEMPT } from './helpers/tables.ts'

const ring = loadKekRing({ AESA_KEK_V1: randomBytes(32).toString('base64'), AESA_KEK_ACTIVE: '1' })

describe('PURGE_ORDER', () => {
  it('covers every tenant table exactly once — pinned against the migration table list', () => {
    const expected = new Set(EXPECTED_TABLES.filter((name) => !RLS_EXEMPT.includes(name) && name !== 'workspaces'))
    const actual = PURGE_ORDER.map((table) => getTableName(table))
    expect(new Set(actual)).toEqual(expected)
    expect(actual).toHaveLength(expected.size)   // no table listed twice
  })
})

describe('purgeWorkspace / purgeAuthRows', () => {
  let t: Awaited<ReturnType<typeof createTestDatabase>>
  let app: ReturnType<typeof createDb>

  beforeAll(async () => { t = await createTestDatabase(); app = createDb(t.url) })
  afterAll(async () => { await app.pool.end(); await t.drop() })

  const countRows = async (table: string, orgId: string): Promise<number> =>
    withPlatform(app.db, 'test:purge-verify', async (tx) => {
      const res = await tx.execute(sql`SELECT count(*)::int AS c FROM ${sql.identifier(table)} WHERE org_id = ${orgId}`)
      return Number((res.rows[0] as { c: number } | undefined)?.c ?? 0)
    })

  /** One full tenant fixture — one row in every PURGE_ORDER table plus workspaces — labelled so two
   *  orgs (A and B) never collide on a table's own unique constraints. */
  async function seedFixture(label: string) {
    const orgId = await createTestOrganization(app, `Purge ${label}`)
    const usr = await app.pool.query<{ id: string }>(
      `INSERT INTO "user" (name, email) VALUES ($1, $2) RETURNING id`,
      [`Owner ${label}`, `owner-${label}-${randomBytes(4).toString('hex')}@example.com`],
    )
    const userId = usr.rows[0]!.id

    await withOrg(app.db, orgId, (tx) => tx.insert(workspaces).values({ orgId, businessName: `Biz ${label}`, timezone: 'UTC' }))
    await withOrg(app.db, orgId, (tx) => ensureBillingRow(tx))
    await withOrg(app.db, orgId, (tx) => provisionOrgKeys(tx, ring))

    const { connectionId, credentialId } = await withOrg(app.db, orgId, async (tx) => {
      const [conn] = await tx.insert(mailboxConnections).values({
        orgId, provider: 'gmail', providerAccountId: `acct-${label}`, emailAddress: `support-${label}@example.com`,
        status: 'connected', connectedByUserId: userId,
      }).returning({ id: mailboxConnections.id })
      const connectionId = conn!.id

      const [agent] = await tx.insert(agents).values({
        orgId, connectionId, address: `support-${label}@example.com`, domain: 'example.com', displayName: `Agent ${label}`,
      }).returning({ id: agents.id })
      const agentId = agent!.id

      const [category] = await tx.insert(categories).values({ orgId, key: 'general', label: 'General' }).returning({ id: categories.id })
      const categoryId = category!.id

      await tx.insert(agentCategoryPolicies).values({ orgId, agentId, categoryId })

      const [ticket] = await tx.insert(tickets).values({ orgId, connectionId, providerThreadId: `thread-${label}` }).returning({ id: tickets.id })
      const ticketId = ticket!.id

      await tx.insert(messages).values({ orgId, ticketId, connectionId, providerMessageId: `msg-${label}`, direction: 'inbound' })

      const [draft] = await tx.insert(drafts).values({
        orgId, ticketId, agentId, categoryId, body: 'Thanks', decision: 'review', decisionReason: 'r',
        threadSnapshotAt: new Date(), expiresAt: new Date(Date.now() + 3_600_000),
      }).returning({ id: drafts.id })
      const draftId = draft!.id

      await tx.insert(draftActionTokens).values({
        orgId, draftId, userId, tokenHash: `hash-${label}-${randomBytes(4).toString('hex')}`,
        expiresAt: new Date(Date.now() + 3_600_000),
      })

      await tx.insert(outboundSends).values({ orgId, draftId, ticketId, connectionId, sendAfter: new Date() })

      const [run] = await tx.insert(agentRuns).values({
        orgId, kind: 'draft', ticketId, agentId, provider: 'anthropic', model: 'claude',
      }).returning({ id: agentRuns.id })
      const runId = run!.id

      await tx.insert(agentRunEvents).values({ orgId, runId, seq: 1, kind: 'prompt' })

      await tx.insert(llmCalls).values({
        orgId, runId, agentId, role: 'draft', provider: 'anthropic', model: 'claude',
        idempotencyKey: `idem-${label}-${randomBytes(4).toString('hex')}`,
        inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, apiCalls: 1,
        costMicros: 1, latencyMs: 1, finish: 'stop', parseStrategy: 'native',
      })

      const [source] = await tx.insert(knowledgeSources).values({ orgId, kind: 'paste', title: `Doc ${label}`, pastedText: 'x' })
        .returning({ id: knowledgeSources.id })
      const [doc] = await tx.insert(knowledgeDocuments).values({ orgId, sourceId: source!.id, uri: `paste:${label}`, contentHash: 'h' })
        .returning({ id: knowledgeDocuments.id })
      await tx.insert(knowledgeChunks).values({ orgId, documentId: doc!.id, ordinal: 0, content: 'chunk', tokenCount: 1 })

      await tx.insert(resolvedAnswers).values({
        orgId, agentId, categoryId, questionText: 'q', answerBody: 'a', expiresAt: new Date(Date.now() + 3_600_000),
      })

      await tx.insert(guidanceSuggestions).values({ orgId, agentId, categoryId, sourceDraftId: draftId, text: 'text' })

      await tx.insert(notifications).values({
        orgId, kind: 'escalation', title: 't', body: 'b', dedupeKey: `dk-${label}-${randomBytes(4).toString('hex')}`,
      })

      await tx.insert(notificationDevices).values({ orgId, userId, expoPushToken: `ExponentPushToken[${label}]`, platform: 'ios' })

      await tx.insert(orgSettings).values({ orgId, key: 'knowledge.max_sources', value: 5 })

      await tx.insert(usageCounters).values({ orgId, day: '2026-09-01', meter: 'test_meter', value: 1 })

      await tx.insert(categoryStatsDaily).values({ orgId, agentId, categoryId, day: '2026-09-01' })

      const [cred] = await tx.insert(llmCredentials).values({
        orgId, provider: 'openai', label: `Cred ${label}`, keyFingerprint: 'abcd1234…7890', createdBy: 'user:test',
      }).returning({ id: llmCredentials.id })
      const credentialId = cred!.id

      await tx.insert(agentModelConfig).values({ orgId, agentId, role: 'draft', mode: 'byok', credentialId })

      await tx.insert(oauthFlows).values({
        orgId, userId, provider: 'gmail', nonceHash: `nonce-${label}-${randomBytes(4).toString('hex')}`,
        pkceCiphertext: Buffer.from('pkce'), platform: 'web', expiresAt: new Date(Date.now() + 600_000),
      })

      await tx.insert(gmailAccessRequests).values({ orgId, email: `req-${label}@example.com` })

      await audit(tx, { actor: 'system:test', action: 'test.seed', entityType: 'test', entityId: 'seed' })

      return { connectionId, credentialId }
    })

    // mailbox_credentials and llm_credential_secrets are platform-role-only (0006 / 0020 REVOKE
    // aesa_app's default DML entirely) — the api (and so `withOrg`) can never write them; only a
    // worker, as aesa_platform, does.
    await withPlatform(app.db, 'test:seed-platform-only', async (tx) => {
      await tx.insert(mailboxCredentials).values({
        connectionId, orgId, refreshTokenCiphertext: Buffer.from('refresh'), encryption: 'sealed',
      })
      await tx.insert(llmCredentialSecrets).values({ credentialId, orgId, keyCiphertext: Buffer.from('secret'), encryption: 'sealed' })
    })

    return orgId
  }

  it('purges every PURGE_ORDER table + workspaces for org A, leaves org B untouched, and deletes A\'s own audit trail', async () => {
    const orgA = await seedFixture('a')
    const orgB = await seedFixture('b')

    const allTables = [...PURGE_ORDER, workspaces].map((table) => getTableName(table))

    const beforeB: Record<string, number> = {}
    for (const name of allTables) {
      const countA = await countRows(name, orgA)
      const countB = await countRows(name, orgB)
      expect({ table: name, countA }).toEqual({ table: name, countA: 1 })   // sanity: the fixture actually seeded A
      expect({ table: name, countB }).toEqual({ table: name, countB: 1 })   // sanity: the fixture actually seeded B
      beforeB[name] = countB
    }

    const counts = await withPlatform(app.db, 'test:purge', (tx) => purgeWorkspace(tx, orgA))
    expect(counts[getTableName(workspaces)]).toBe(1)

    for (const name of allTables) {
      expect({ table: name, countA: await countRows(name, orgA) }).toEqual({ table: name, countA: 0 })
      expect({ table: name, countB: await countRows(name, orgB) }).toEqual({ table: name, countB: beforeB[name] })
    }
  })

  it('purgeAuthRows nulls session.active_organization_id and deletes the organization (cascading member/invitation) for A, leaves B', async () => {
    const orgA = await createTestOrganization(app, 'Auth A')
    const orgB = await createTestOrganization(app, 'Auth B')
    const usr = await app.pool.query<{ id: string }>(
      `INSERT INTO "user" (name, email) VALUES ($1, $2) RETURNING id`,
      ['Auth Owner', `owner-auth-${randomBytes(4).toString('hex')}@example.com`],
    )
    const userId = usr.rows[0]!.id

    await app.pool.query(
      `INSERT INTO session (expires_at, token, user_id, active_organization_id) VALUES (now() + interval '1 day', $1, $2, $3)`,
      [`token-a-${randomBytes(4).toString('hex')}`, userId, orgA],
    )
    await app.pool.query(
      `INSERT INTO session (expires_at, token, user_id, active_organization_id) VALUES (now() + interval '1 day', $1, $2, $3)`,
      [`token-b-${randomBytes(4).toString('hex')}`, userId, orgB],
    )
    await app.pool.query(`INSERT INTO member (organization_id, user_id, role) VALUES ($1, $2, 'owner')`, [orgA, userId])
    await app.pool.query(`INSERT INTO member (organization_id, user_id, role) VALUES ($1, $2, 'owner')`, [orgB, userId])
    await app.pool.query(
      `INSERT INTO invitation (organization_id, email, status, expires_at, inviter_id) VALUES ($1, $2, 'pending', now() + interval '1 day', $3)`,
      [orgA, 'invitee-a@example.com', userId],
    )
    await app.pool.query(
      `INSERT INTO invitation (organization_id, email, status, expires_at, inviter_id) VALUES ($1, $2, 'pending', now() + interval '1 day', $3)`,
      [orgB, 'invitee-b@example.com', userId],
    )

    await withPlatform(app.db, 'test:purge-auth', (tx) => purgeAuthRows(tx, orgA))

    const sessions = await app.pool.query<{ active_organization_id: string | null }>(
      `SELECT active_organization_id FROM session WHERE user_id = $1 ORDER BY active_organization_id NULLS FIRST`, [userId],
    )
    expect(sessions.rows.map((r) => r.active_organization_id)).toEqual([null, orgB])

    const orgs = await app.pool.query<{ id: string }>(`SELECT id FROM organization WHERE id = ANY($1)`, [[orgA, orgB]])
    expect(orgs.rows.map((r) => r.id)).toEqual([orgB])

    const members = await app.pool.query<{ organization_id: string }>(`SELECT organization_id FROM member WHERE organization_id = ANY($1)`, [[orgA, orgB]])
    expect(members.rows.map((r) => r.organization_id)).toEqual([orgB])

    const invitations = await app.pool.query<{ organization_id: string }>(`SELECT organization_id FROM invitation WHERE organization_id = ANY($1)`, [[orgA, orgB]])
    expect(invitations.rows.map((r) => r.organization_id)).toEqual([orgB])
  })
})
