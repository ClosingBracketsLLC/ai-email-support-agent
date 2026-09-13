import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  agents, billingSubscriptions, mailboxConnections, SEND_METERS, usageCounters, withOrg, workspaces,
} from '../src/index.ts'
import { countActiveDomains, countManagedConversations, ensureBillingRow, readBillingState } from '../src/billing.ts'
import { createDb } from '../src/raw.ts'
import { createTestDatabase, createTestOrganization } from './helpers/test-db.ts'

describe('billing', () => {
  let t: Awaited<ReturnType<typeof createTestDatabase>>
  let app: ReturnType<typeof createDb>
  let orgId: string

  beforeAll(async () => {
    t = await createTestDatabase()
    app = createDb(t.url)
    orgId = await createTestOrganization(app)
    await withOrg(app.db, orgId, (tx) => tx.insert(workspaces).values({ orgId, businessName: 'A', timezone: 'UTC' }))
  })
  afterAll(async () => { await app.pool.end(); await t.drop() })

  const mkOrg = async (name: string) => {
    const id = await createTestOrganization(app, name)
    await withOrg(app.db, id, (tx) => tx.insert(workspaces).values({ orgId: id, businessName: name, timezone: 'UTC' }))
    return id
  }

  it('reads as a fresh trial when no row exists at all, never throwing', async () => {
    const now = new Date('2026-09-15T12:00:00Z')
    const view = await withOrg(app.db, orgId, (tx) => readBillingState(tx, now))
    expect(view.plan).toBe('trial')
    expect(view.state).toBe('trialing')
    expect(view.active).toBe(true)
    expect(view.missingRow).toBe(true)
    expect(view.allowance).toBe(50)
    expect(view.period).toEqual({ start: new Date(Date.UTC(2026, 8, 1)), end: new Date(Date.UTC(2026, 9, 1)) })
  })

  it('ensureBillingRow is idempotent: two calls leave exactly one row', async () => {
    const fresh = await mkOrg('Fresh')
    await withOrg(app.db, fresh, (tx) => ensureBillingRow(tx))
    await withOrg(app.db, fresh, (tx) => ensureBillingRow(tx))
    const rows = await withOrg(app.db, fresh, (tx) => tx.select().from(billingSubscriptions))
    expect(rows).toHaveLength(1)
  })

  // Ruling R6 regression: the missing-row default and a real trial row must read the SAME
  // allowance. Before the fix, `ensureBillingRow`'s row carried the column default (300, the
  // STANDARD per-domain rate) and `allowanceOf` read it verbatim for a trial, so a workspace with a
  // row read 300 while one without still read 50 — a 6x leak against the trial's $10 LLM budget.
  it('a trial org WITH a row (after ensureBillingRow) reads the same allowance as one without a row (both 50)', async () => {
    const withRow = await mkOrg('Trial with row')
    await withOrg(app.db, withRow, (tx) => ensureBillingRow(tx))
    const now = new Date('2026-09-15T12:00:00Z')
    const view = await withOrg(app.db, withRow, (tx) => readBillingState(tx, now))
    expect(view.missingRow).toBe(false)
    expect(view.plan).toBe('trial')
    expect(view.allowance).toBe(50)
  })

  it('a trial row whose included_conversations_per_domain has been hand-set to 999 still reads allowance 50', async () => {
    const handSet = await mkOrg('Trial hand-set 999')
    await withOrg(app.db, handSet, (tx) =>
      tx.insert(billingSubscriptions).values({ orgId: handSet, includedConversationsPerDomain: 999 }))
    const view = await withOrg(app.db, handSet, (tx) => readBillingState(tx, new Date('2026-09-15T12:00:00Z')))
    expect(view.plan).toBe('trial')
    expect(view.allowance).toBe(50)
  })

  it('trial_ends_at an hour in the past reads as trial_expired and inactive', async () => {
    const expired = await mkOrg('Expired')
    const now = new Date('2026-09-15T12:00:00Z')
    await withOrg(app.db, expired, (tx) =>
      tx.insert(billingSubscriptions).values({ orgId: expired, trialEndsAt: new Date(now.getTime() - 3_600_000) }))
    const view = await withOrg(app.db, expired, (tx) => readBillingState(tx, now))
    expect(view.state).toBe('trial_expired')
    expect(view.active).toBe(false)
  })

  it('a standard row with domainQuantity 2 and Stripe period dates reads allowance 600 and the Stripe period', async () => {
    const std = await mkOrg('Standard')
    const periodStart = new Date('2026-09-01T00:00:00Z')
    const periodEnd = new Date('2026-10-01T00:00:00Z')
    await withOrg(app.db, std, (tx) => tx.insert(billingSubscriptions).values({
      orgId: std, plan: 'standard', status: 'active', domainQuantity: 2,
      currentPeriodStart: periodStart, currentPeriodEnd: periodEnd,
    }))
    const view = await withOrg(app.db, std, (tx) => readBillingState(tx, new Date('2026-09-15T00:00:00Z')))
    expect(view.allowance).toBe(600)
    expect(view.period).toEqual({ start: periodStart, end: periodEnd })
  })

  describe('countManagedConversations', () => {
    it('sums only SEND_METERS.aiHandledManaged within [period.start, period.end) UTC days', async () => {
      const org = await mkOrg('Meter')
      const period = { start: new Date('2026-09-01T00:00:00Z'), end: new Date('2026-10-01T00:00:00Z') }
      await withOrg(app.db, org, (tx) => tx.insert(usageCounters).values([
        { orgId: org, day: '2026-09-01', meter: SEND_METERS.aiHandledManaged, value: 3 },
        { orgId: org, day: '2026-09-30', meter: SEND_METERS.aiHandledManaged, value: 4 },
        { orgId: org, day: '2026-10-01', meter: SEND_METERS.aiHandledManaged, value: 100 },        // outside: end is exclusive
        { orgId: org, day: '2026-09-15', meter: SEND_METERS.aiHandledConversations, value: 999 },  // wrong meter: ignored
      ]))
      const count = await withOrg(app.db, org, (tx) => countManagedConversations(tx, period))
      expect(count).toBe(7)
    })
  })

  describe('countActiveDomains', () => {
    it('counts distinct domains of active agents only', async () => {
      const org = await mkOrg('Domains')
      const usr = await app.pool.query<{ id: string }>(
        `INSERT INTO "user" (name, email) VALUES ($1, $2) RETURNING id`,
        ['Owner', `owner-${randomBytes(4).toString('hex')}@example.com`],
      )
      const userId = usr.rows[0]!.id
      await withOrg(app.db, org, async (tx) => {
        const [conn] = await tx.insert(mailboxConnections).values({
          orgId: org, provider: 'gmail', providerAccountId: 'acct-1', emailAddress: 'a@one.com',
          status: 'connected', connectedByUserId: userId,
        }).returning({ id: mailboxConnections.id })
        await tx.insert(agents).values([
          { orgId: org, connectionId: conn!.id, address: 'a@one.com', domain: 'one.com', displayName: 'A', status: 'active' },
          { orgId: org, connectionId: conn!.id, address: 'b@one.com', domain: 'one.com', displayName: 'B', status: 'active' },
          { orgId: org, connectionId: conn!.id, address: 'c@two.com', domain: 'two.com', displayName: 'C', status: 'active' },
          { orgId: org, connectionId: conn!.id, address: 'd@three.com', domain: 'three.com', displayName: 'D', status: 'pending_verification' },
        ])
      })
      const count = await withOrg(app.db, org, (tx) => countActiveDomains(tx))
      expect(count).toBe(2)
    })
  })

  describe('RLS + resolve_stripe_customer', () => {
    it("org B's billing row is invisible from org A's withOrg, and resolve_stripe_customer resolves cross-org", async () => {
      const orgA = await mkOrg('RLS-A')
      const orgB = await mkOrg('RLS-B')
      await withOrg(app.db, orgB, (tx) => tx.insert(billingSubscriptions).values({ orgId: orgB, stripeCustomerId: 'cus_B' }))

      const seenFromA = await withOrg(app.db, orgA, (tx) => tx.select().from(billingSubscriptions))
      expect(seenFromA).toHaveLength(0)

      const appPool = createDb(t.url, { role: 'app' })
      try {
        const res = await appPool.pool.query('SELECT * FROM resolve_stripe_customer($1)', ['cus_B'])
        expect(res.rows).toEqual([{ org_id: orgB }])

        const none = await appPool.pool.query('SELECT * FROM resolve_stripe_customer($1)', ['cus_unknown'])
        expect(none.rows).toEqual([])
      } finally {
        await appPool.pool.end()
      }
    })
  })
})
