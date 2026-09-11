import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  agentRunEvents, agentRuns, draftActionTokens, drafts, llmCalls, mailboxConnections, outboundSends, tickets, withOrg,
} from '../src/index.ts'
import { createDb } from '../src/raw.ts'
import { createTestDatabase, createTestOrganization } from './helpers/test-db.ts'

describe('draft/review/send schema (drafts, draft_action_tokens, outbound_sends, agent_runs/events, llm_calls)', () => {
  let t: Awaited<ReturnType<typeof createTestDatabase>>
  let app: ReturnType<typeof createDb>
  let orgId: string
  let userId: string
  let connectionId: string
  let ticketId: string

  beforeAll(async () => {
    t = await createTestDatabase()
    app = createDb(t.url)
    orgId = await createTestOrganization(app)
    const usr = await app.pool.query<{ id: string }>(
      `INSERT INTO "user" (name, email) VALUES ($1, $2) RETURNING id`,
      ['Owner', `owner-${randomBytes(4).toString('hex')}@example.com`],
    )
    userId = usr.rows[0]!.id
    connectionId = await withOrg(app.db, orgId, async (tx) => {
      const [row] = await tx.insert(mailboxConnections).values({
        orgId, provider: 'gmail', providerAccountId: 'acct-1', emailAddress: 'support@acme.com',
        status: 'connected', connectedByUserId: userId,
      }).returning({ id: mailboxConnections.id })
      return row!.id
    })
    ticketId = await withOrg(app.db, orgId, async (tx) => {
      const [row] = await tx.insert(tickets).values({
        orgId, connectionId, providerThreadId: 'thread-1',
      }).returning({ id: tickets.id })
      return row!.id
    })
  })
  afterAll(async () => { await app.pool.end(); await t.drop() })

  const draftValues = (overrides: Partial<typeof drafts.$inferInsert> = {}) => ({
    orgId, ticketId,
    body: 'Thanks for reaching out.',
    decision: 'review', decisionReason: 'low confidence',
    threadSnapshotAt: new Date(),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    ...overrides,
  })

  it('one live draft per ticket: a second pending draft on the same ticket conflicts', async () => {
    await withOrg(app.db, orgId, (tx) => tx.insert(drafts).values(draftValues({ status: 'pending' })))
    await expect(
      withOrg(app.db, orgId, (tx) => tx.insert(drafts).values(draftValues({ status: 'pending', version: 2 }))),
    ).rejects.toMatchObject({ cause: { code: '23505' } })
  })

  it('a superseded draft and a pending draft coexist on the same ticket', async () => {
    const [ticket] = await withOrg(app.db, orgId, (tx) =>
      tx.insert(tickets).values({ orgId, connectionId, providerThreadId: 'thread-coexist' }).returning({ id: tickets.id }))
    const otherTicketId = ticket!.id
    await withOrg(app.db, orgId, (tx) =>
      tx.insert(drafts).values(draftValues({ ticketId: otherTicketId, status: 'superseded' })))
    await expect(
      withOrg(app.db, orgId, (tx) => tx.insert(drafts).values(draftValues({ ticketId: otherTicketId, status: 'pending', version: 2 }))),
    ).resolves.not.toThrow()
  })

  it('drafts insert without thread_snapshot_at rejects (not-null violation)', async () => {
    const [ticket] = await withOrg(app.db, orgId, (tx) =>
      tx.insert(tickets).values({ orgId, connectionId, providerThreadId: 'thread-no-snapshot' }).returning({ id: tickets.id }))
    const values = draftValues({ ticketId: ticket!.id })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (values as any).threadSnapshotAt
    await expect(
      withOrg(app.db, orgId, (tx) => tx.insert(drafts).values(values)),
    ).rejects.toMatchObject({ cause: { code: '23502' } })
  })

  it('drafts.status rejects a value outside DRAFT_STATUSES (check violation)', async () => {
    const [ticket] = await withOrg(app.db, orgId, (tx) =>
      tx.insert(tickets).values({ orgId, connectionId, providerThreadId: 'thread-bogus-status' }).returning({ id: tickets.id }))
    await expect(
      withOrg(app.db, orgId, (tx) =>
        tx.insert(drafts).values(draftValues({ ticketId: ticket!.id, status: 'bogus' }))),
    ).rejects.toMatchObject({ cause: { code: '23514' } })
  })

  it('outbound_sends.draft_id is unique: a second row for one draft conflicts', async () => {
    const [ticket] = await withOrg(app.db, orgId, (tx) =>
      tx.insert(tickets).values({ orgId, connectionId, providerThreadId: 'thread-send' }).returning({ id: tickets.id }))
    const [draft] = await withOrg(app.db, orgId, (tx) =>
      tx.insert(drafts).values(draftValues({ ticketId: ticket!.id, status: 'approved' })).returning({ id: drafts.id }))
    const sendValues = { orgId, draftId: draft!.id, ticketId: ticket!.id, connectionId, sendAfter: new Date() }
    await withOrg(app.db, orgId, (tx) => tx.insert(outboundSends).values(sendValues))
    await expect(
      withOrg(app.db, orgId, (tx) => tx.insert(outboundSends).values(sendValues)),
    ).rejects.toMatchObject({ cause: { code: '23505' } })
  })

  it('agent_run_events (run_id, seq) is unique', async () => {
    const [run] = await withOrg(app.db, orgId, (tx) =>
      tx.insert(agentRuns).values({ orgId, kind: 'triage', ticketId, provider: 'anthropic', model: 'claude' }).returning({ id: agentRuns.id }))
    await withOrg(app.db, orgId, (tx) =>
      tx.insert(agentRunEvents).values({ orgId, runId: run!.id, seq: 1, kind: 'prompt' }))
    await expect(
      withOrg(app.db, orgId, (tx) => tx.insert(agentRunEvents).values({ orgId, runId: run!.id, seq: 1, kind: 'call' })),
    ).rejects.toMatchObject({ cause: { code: '23505' } })
  })

  it('llm_calls.idempotency_key is unique', async () => {
    const idempotencyKey = `idem-${randomBytes(4).toString('hex')}`
    const callValues = {
      orgId, role: 'triage', provider: 'anthropic', model: 'claude', idempotencyKey,
      inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0,
      apiCalls: 1, costMicros: 100, latencyMs: 500, finish: 'stop', parseStrategy: 'json',
    }
    await withOrg(app.db, orgId, (tx) => tx.insert(llmCalls).values(callValues))
    await expect(
      withOrg(app.db, orgId, (tx) => tx.insert(llmCalls).values(callValues)),
    ).rejects.toMatchObject({ cause: { code: '23505' } })
  })

  describe('resolve_draft_action_token', () => {
    let appDb: ReturnType<typeof createDb>
    let tokenHash: string
    let tokenId: string
    let draftId: string

    beforeAll(async () => {
      appDb = createDb(t.url, { role: 'app' })
      const [ticket] = await withOrg(app.db, orgId, (tx) =>
        tx.insert(tickets).values({ orgId, connectionId, providerThreadId: 'thread-token' }).returning({ id: tickets.id }))
      const [draft] = await withOrg(app.db, orgId, (tx) =>
        tx.insert(drafts).values(draftValues({ ticketId: ticket!.id, status: 'held' })).returning({ id: drafts.id }))
      draftId = draft!.id
      tokenHash = `hash-${randomBytes(8).toString('hex')}`
      const [token] = await withOrg(app.db, orgId, (tx) =>
        tx.insert(draftActionTokens).values({
          orgId, draftId, userId, tokenHash, expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        }).returning({ id: draftActionTokens.id }))
      tokenId = token!.id
    })
    afterAll(async () => { await appDb.pool.end() })

    it('resolves the token by hash with no app.org_id set, and returns nothing for a missing hash', async () => {
      const direct = await appDb.pool.query<{ count: string }>('SELECT count(*) FROM draft_action_tokens')
      expect(direct.rows[0]!.count).toBe('0')

      const res = await appDb.pool.query(`SELECT * FROM resolve_draft_action_token($1)`, [tokenHash])
      expect(res.rows).toEqual([{
        token_id: tokenId, org_id: orgId, draft_id: draftId, user_id: userId, expires_at: expect.any(Date), consumed_at: null,
      }])

      const none = await appDb.pool.query(`SELECT * FROM resolve_draft_action_token($1)`, ['no-such-hash'])
      expect(none.rows).toEqual([])
    })
  })

  it('RLS smoke: withOrg(orgA) sees only its own drafts', async () => {
    const mkFixture = async (org: string, label: string) => {
      const usr = await app.pool.query<{ id: string }>(
        `INSERT INTO "user" (name, email) VALUES ($1, $2) RETURNING id`,
        [label, `${label}-${randomBytes(4).toString('hex')}@example.com`],
      )
      return withOrg(app.db, org, async (tx) => {
        const [conn] = await tx.insert(mailboxConnections).values({
          orgId: org, provider: 'gmail', providerAccountId: `acct-${label}`, emailAddress: `${label}@example.com`,
          status: 'connected', connectedByUserId: usr.rows[0]!.id,
        }).returning({ id: mailboxConnections.id })
        const [ticket] = await tx.insert(tickets).values({
          orgId: org, connectionId: conn!.id, providerThreadId: `thread-${label}`,
        }).returning({ id: tickets.id })
        await tx.insert(drafts).values({
          orgId: org, ticketId: ticket!.id, body: 'body', decision: 'review', decisionReason: 'reason',
          threadSnapshotAt: new Date(), expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        })
      })
    }

    const orgA = await createTestOrganization(app)
    const orgB = await createTestOrganization(app)
    await mkFixture(orgA, 'a')
    await mkFixture(orgB, 'b')

    const seenFromA = await withOrg(app.db, orgA, (tx) => tx.select().from(drafts))
    expect(seenFromA).toHaveLength(1)
    expect(seenFromA[0]!.orgId).toBe(orgA)
  })
})
