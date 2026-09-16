/**
 * `runBillingReportUsage` against real Postgres and a recording `StripeUsagePort`. Every org gets a
 * FRESH fixture: the cron sweeps EVERY workspace with a `billing_subscriptions` row, so a leftover
 * org from an earlier test would be visited by the next one and its Stripe calls counted there.
 *
 * The centrepiece is the plan's worked example (deviation 3), run as three consecutive days against
 * the same row — the first report is a delta of 1 at conversation 601, the second a delta of 49, and
 * the third nothing at all. That is the spec's "an overage record appears at conversation 301",
 * scaled to this fixture's two domains.
 */
import { randomBytes } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import pino from 'pino'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  agents, auditLog, billingSubscriptions, mailboxConnections, notifications, SEND_METERS, usageCounters,
  user, withOrg, withPlatform, workspaces,
} from '@aesa/db'
import { createDb } from '@aesa/db/raw'
import { createTestDatabase, createTestOrganization } from '@aesa/db/testing'
import {
  runBillingReportUsage, TRIAL_ENDING_NOTICE_DAYS, type ReportUsageDeps,
} from '../src/billing/report-usage.ts'
import { createFakeStripeUsage, usageCallsTo, type FakeStripeUsage } from './helpers/fake-stripe-usage.ts'

const rand = () => randomBytes(4).toString('hex')

/** Mid-month, so the period's first and last day are both unambiguous. */
const DAY1 = new Date('2026-06-15T00:20:00Z')
const DAY2 = new Date('2026-06-16T00:20:00Z')
const DAY3 = new Date('2026-06-17T00:20:00Z')
const PERIOD_START = new Date('2026-06-01T00:00:00Z')
const PERIOD_END = new Date('2026-07-01T00:00:00Z')
const PERIOD_START_ISO = PERIOD_START.toISOString()

let t: Awaited<ReturnType<typeof createTestDatabase>>
let app: ReturnType<typeof createDb>
let userId: string
let orgId: string
let connectionId: string

beforeAll(async () => {
  t = await createTestDatabase()
  app = createDb(t.url)
  const [u] = await app.db.insert(user).values({ name: 'Owner', email: `owner-${rand()}@example.com` }).returning()
  userId = u!.id
})
afterAll(async () => {
  await app.pool.end()
  await t.drop()
})
beforeEach(async () => {
  // The cron sweeps EVERY workspace that has a `billing_subscriptions` row, and its counters are
  // pass-wide — so an earlier test's org would be visited by this one and counted in its totals.
  // Clearing the table is what makes `orgs`/`reported`/`trialNotices` exact numbers here.
  await withPlatform(app.db, 'test:billing-report-usage reset', (tx) => tx.delete(billingSubscriptions))
  orgId = await createTestOrganization(app)
  await withOrg(app.db, orgId, async (tx) => {
    await tx.insert(workspaces).values({ orgId, businessName: 'Acme', timezone: 'UTC' })
    const [conn] = await tx
      .insert(mailboxConnections)
      .values({
        orgId, provider: 'gmail', providerAccountId: `acct-${rand()}`, emailAddress: `support-${rand()}@acme.test`,
        status: 'connected', connectedByUserId: userId,
      })
      .returning({ id: mailboxConnections.id })
    connectionId = conn!.id
  })
})

// -- fixture helpers ---------------------------------------------------------

async function seedBilling(over: Partial<typeof billingSubscriptions.$inferInsert> = {}): Promise<void> {
  await withOrg(app.db, orgId, (tx) =>
    tx.insert(billingSubscriptions).values({
      orgId,
      plan: 'standard',
      status: 'active',
      stripeCustomerId: `cus_${rand()}`,
      stripeSubscriptionId: `sub_${rand()}`,
      stripeDomainItemId: `si_${rand()}`,
      domainQuantity: 2,
      currentPeriodStart: PERIOD_START,
      currentPeriodEnd: PERIOD_END,
      ...over,
    }))
}

/** MANAGED conversations handled in this period — the ONE meter the allowance is measured against. */
async function setManagedUsed(value: number, day = '2026-06-10'): Promise<void> {
  await withOrg(app.db, orgId, (tx) =>
    tx.insert(usageCounters).values({ orgId, day, meter: SEND_METERS.aiHandledManaged, value })
      .onConflictDoUpdate({ target: [usageCounters.orgId, usageCounters.day, usageCounters.meter], set: { value } }))
}

async function seedAgents(domains: string[]): Promise<void> {
  await withOrg(app.db, orgId, (tx) =>
    tx.insert(agents).values(domains.map((domain, i) => ({
      orgId, connectionId, address: `support-${rand()}@${domain}`, domain,
      displayName: 'Acme Support', status: 'active', priority: i, signature: 'Acme',
    }))))
}

async function billingRow() {
  const [row] = await withOrg(app.db, orgId, (tx) =>
    tx.select().from(billingSubscriptions).where(eq(billingSubscriptions.orgId, orgId)))
  return row!
}

async function auditRows(action: string) {
  return withOrg(app.db, orgId, (tx) =>
    tx.select().from(auditLog).where(and(eq(auditLog.orgId, orgId), eq(auditLog.action, action))))
}

async function notificationRows() {
  return withOrg(app.db, orgId, (tx) => tx.select().from(notifications).where(eq(notifications.orgId, orgId)))
}

interface Harness {
  deps: ReportUsageDeps
  fake: FakeStripeUsage
  notified: string[]
  errors: Record<string, unknown>[]
  warns: Record<string, unknown>[]
}

function makeDeps(now: Date, over: { stripe?: 'fake' | null } = {}): Harness {
  const fake = createFakeStripeUsage()
  const notified: string[] = []
  const errors: Record<string, unknown>[] = []
  const warns: Record<string, unknown>[] = []
  const logger = pino({ level: 'silent' }) as unknown as ReportUsageDeps['logger']
  const spyLogger = {
    ...logger,
    error: (obj: Record<string, unknown>) => void errors.push(obj),
    warn: (obj: Record<string, unknown>) => void warns.push(obj),
    info: () => {},
  } as unknown as ReportUsageDeps['logger']
  const deps: ReportUsageDeps = {
    db: app.db,
    logger: spyLogger,
    stripe: over.stripe === null ? null : fake.port,
    enqueueNotify: async (_orgId, notificationId) => void notified.push(notificationId),
    now: () => now,
  }
  return { deps, fake, notified, errors, warns }
}

// -- the worked example ------------------------------------------------------

describe('billing.report-usage: overage as meter-event deltas', () => {
  it("the plan's worked example, three days running: 601 → delta 1, 650 → delta 49, unchanged → no call", async () => {
    await seedBilling()
    await seedAgents(['acme.test', 'acme.co'])
    await setManagedUsed(601)

    // --- day 1: the first overage unit ever. 601 used against 300 × 2 domains = 600 included.
    const d1 = makeDeps(DAY1)
    const r1 = await runBillingReportUsage(d1.deps)

    expect(r1).toMatchObject({ orgs: 1, reported: 1, skipped: 0 })
    expect(usageCallsTo(d1.fake, 'reportOverage')).toEqual([
      { method: 'reportOverage', params: { customerId: (await billingRow()).stripeCustomerId, value: 1, identifier: `${orgId}:${PERIOD_START_ISO}:1` } },
    ])
    const afterDay1 = await billingRow()
    expect(afterDay1.overageReported).toBe(1)
    expect(afterDay1.overageReportedPeriodStart).toEqual(PERIOD_START)
    const audits1 = await auditRows('billing.overage_reported')
    expect(audits1).toHaveLength(1)
    expect(audits1[0]!.detail).toMatchObject({ used: 601, allowance: 600, delta: 1 })
    expect(audits1[0]!.actor).toBe('system:cron:billing.report-usage')

    // --- day 2: 650 used → 50 total overage, 49 of it not yet reported.
    await setManagedUsed(650)
    const d2 = makeDeps(DAY2)
    const r2 = await runBillingReportUsage(d2.deps)

    expect(r2.reported).toBe(1)
    expect(usageCallsTo(d2.fake, 'reportOverage')[0]!.params).toMatchObject({ value: 49, identifier: `${orgId}:${PERIOD_START_ISO}:50` })
    expect((await billingRow()).overageReported).toBe(50)

    // --- day 3: nothing new. No call at all — the delta is what is reported, not the total.
    const d3 = makeDeps(DAY3)
    const r3 = await runBillingReportUsage(d3.deps)

    expect(r3.reported).toBe(0)
    expect(usageCallsTo(d3.fake, 'reportOverage')).toEqual([])
    expect((await billingRow()).overageReported).toBe(50)
  })

  it('a new period resets the watermark: the whole of the new period’s overage is reported, not the difference from the old one', async () => {
    const nextStart = new Date('2026-07-01T00:00:00Z')
    await seedBilling({
      currentPeriodStart: nextStart,
      currentPeriodEnd: new Date('2026-08-01T00:00:00Z'),
      overageReported: 50,
      overageReportedPeriodStart: PERIOD_START,
    })
    await setManagedUsed(610, '2026-07-04')

    const h = makeDeps(new Date('2026-07-10T00:20:00Z'))
    await runBillingReportUsage(h.deps)

    // 610 − 600 = 10, reported in full: the 50 already billed belongs to the period that ended.
    expect(usageCallsTo(h.fake, 'reportOverage')[0]!.params).toMatchObject({
      value: 10, identifier: `${orgId}:${nextStart.toISOString()}:10`,
    })
    const row = await billingRow()
    expect(row.overageReported).toBe(10)
    expect(row.overageReportedPeriodStart).toEqual(nextStart)
  })

  it('overage_mode blocked never reports — a blocked workspace stops sending instead of accruing', async () => {
    await seedBilling({ overageMode: 'blocked' })
    await setManagedUsed(900)

    const h = makeDeps(DAY1)
    const result = await runBillingReportUsage(h.deps)

    expect(usageCallsTo(h.fake, 'reportOverage')).toEqual([])
    expect(result.reported).toBe(0)
    expect((await billingRow()).overageReported).toBe(0)
  })

  it('a trial row never reports — a trial has no Stripe subscription to bill against', async () => {
    await seedBilling({ plan: 'trial', status: 'trialing', stripeCustomerId: null, stripeSubscriptionId: null, stripeDomainItemId: null })
    await setManagedUsed(900)

    const h = makeDeps(DAY1)
    const result = await runBillingReportUsage(h.deps)

    expect(usageCallsTo(h.fake, 'reportOverage')).toEqual([])
    expect(result.reported).toBe(0)
  })

  it('stripe: null counts the org as skipped, warns, and leaves the row exactly as it was', async () => {
    await seedBilling()
    await setManagedUsed(601)

    const h = makeDeps(DAY1, { stripe: null })
    const result = await runBillingReportUsage(h.deps)

    expect(result.skipped).toBe(1)
    expect(result.reported).toBe(0)
    expect(h.warns.some((w) => w.reason === 'stripe_not_configured')).toBe(true)
    const row = await billingRow()
    expect(row.overageReported).toBe(0)
    expect(row.overageReportedPeriodStart).toBeNull()
    expect(await auditRows('billing.overage_reported')).toEqual([])
  })

  it('a phase-3 write failure AFTER a successful meter event alerts stripe_report_failed with op record', async () => {
    await seedBilling()
    await setManagedUsed(601)

    // The one money-losing state: Stripe accepted the charge and the watermark could not record it.
    // The database goes away between phase 2 and phase 3 — `Object.create` puts one overriding
    // `transaction` on a wrapper whose prototype IS the real handle, the same trick `withOrgIdentity`
    // uses, so phase 1 (already committed) is untouched and only the recording transaction fails.
    let down = false
    const brittleDb = Object.create(app.db) as typeof app.db
    brittleDb.transaction = (async (...args: Parameters<typeof app.db.transaction>) => {
      if (down) throw new Error('connection terminated unexpectedly')
      return app.db.transaction(...args)
    }) as typeof app.db.transaction

    const h = makeDeps(DAY1)
    const inner = h.deps.stripe!
    const deps: ReportUsageDeps = {
      ...h.deps,
      db: brittleDb,
      stripe: {
        reportOverage: async (p) => { await inner.reportOverage(p); down = true },
        setDomainQuantity: (p) => inner.setDomainQuantity(p),
      },
    }

    const result = await runBillingReportUsage(deps)

    // The meter event DID land — that is exactly why this is an alert and not a warn.
    expect(result.reported).toBe(1)
    expect(usageCallsTo(h.fake, 'reportOverage')).toHaveLength(1)
    const alert = h.errors.find((e) => e.alert === true && e.kind === 'stripe_report_failed' && e.op === 'record')
    expect(alert).toBeDefined()
    expect(alert!.orgId).toBe(orgId)
    // The watermark really did stay behind the charge: that is the state the operator is being told about.
    down = false
    expect((await billingRow()).overageReported).toBe(0)
  })

  it('a phase-3 write failure with NOTHING reported stays a plain warn — nothing can be double-billed', async () => {
    // A trial makes no Stripe call at all, so a failed write is only work redone tomorrow. Phase 1 is
    // the FIRST transaction of the pass and phase 3 the second, so failing everything after the
    // first fails exactly the recording one.
    await seedBilling({ plan: 'trial', status: 'trialing', trialEndsAt: new Date('2026-06-17T09:00:00Z') })

    let seen = 0
    const brittleDb = Object.create(app.db) as typeof app.db
    brittleDb.transaction = (async (...args: Parameters<typeof app.db.transaction>) => {
      seen += 1
      if (seen > 1) throw new Error('connection terminated unexpectedly')
      return app.db.transaction(...args)
    }) as typeof app.db.transaction

    const h = makeDeps(DAY1)
    const result = await runBillingReportUsage({ ...h.deps, db: brittleDb })

    expect(result.reported).toBe(0)
    expect(result.trialNotices).toBe(0)
    expect(h.errors.filter((e) => e.kind === 'stripe_report_failed')).toEqual([])
    expect(h.warns.some((w) => w.orgId === orgId)).toBe(true)
  })

  it('a port that throws alerts stripe_report_failed and leaves the row untouched — the write only follows a success', async () => {
    await seedBilling()
    await setManagedUsed(601)

    const h = makeDeps(DAY1)
    h.fake.failing.add('reportOverage')
    const result = await runBillingReportUsage(h.deps)

    expect(result.reported).toBe(0)
    expect(h.errors.some((e) => e.alert === true && e.kind === 'stripe_report_failed' && e.orgId === orgId)).toBe(true)
    const row = await billingRow()
    expect(row.overageReported).toBe(0)
    expect(row.overageReportedPeriodStart).toBeNull()
    expect(await auditRows('billing.overage_reported')).toEqual([])
  })
})

// -- the daily quantity sync -------------------------------------------------

describe('billing.report-usage: the daily domain-quantity sync', () => {
  it('3 active domains against a stored quantity of 2 updates Stripe and then the row', async () => {
    await seedBilling({ domainQuantity: 2 })
    await seedAgents(['acme.test', 'acme.co', 'acme.io'])

    const h = makeDeps(DAY1)
    const result = await runBillingReportUsage(h.deps)

    expect(result.quantitySynced).toBe(1)
    const row = await billingRow()
    expect(usageCallsTo(h.fake, 'setDomainQuantity')).toEqual([
      { method: 'setDomainQuantity', params: { subscriptionId: row.stripeSubscriptionId, itemId: row.stripeDomainItemId, quantity: 3 } },
    ])
    expect(row.domainQuantity).toBe(3)
    const audits = await auditRows('billing.domain_quantity_synced')
    expect(audits).toHaveLength(1)
    expect(audits[0]!.detail).toMatchObject({ from: 2, to: 3 })
  })

  it('an unchanged count calls nothing', async () => {
    await seedBilling({ domainQuantity: 2 })
    await seedAgents(['acme.test', 'acme.co'])

    const h = makeDeps(DAY1)
    const result = await runBillingReportUsage(h.deps)

    expect(usageCallsTo(h.fake, 'setDomainQuantity')).toEqual([])
    expect(result.quantitySynced).toBe(0)
  })

  it('only ACTIVE agents count, and two agents on one domain are one domain', async () => {
    await seedBilling({ domainQuantity: 3 })
    await seedAgents(['acme.test', 'acme.test'])
    await withOrg(app.db, orgId, (tx) =>
      tx.insert(agents).values({
        orgId, connectionId, address: `retired-${rand()}@acme.co`, domain: 'acme.co',
        displayName: 'Old', status: 'disabled', priority: 9, signature: 'Acme',
      }))

    const h = makeDeps(DAY1)
    await runBillingReportUsage(h.deps)

    expect(usageCallsTo(h.fake, 'setDomainQuantity')[0]!.params).toMatchObject({ quantity: 1 })
    expect((await billingRow()).domainQuantity).toBe(1)
  })

  // Ruling R29: the floor is 1 everywhere — Checkout, `allowanceOf` and this sync agree.
  it('a standard workspace with NO active agent syncs to 1, never 0; at 1 already it calls nothing', async () => {
    await seedBilling({ domainQuantity: 2 })

    const h = makeDeps(DAY1)
    expect(await runBillingReportUsage(h.deps)).toMatchObject({ quantitySynced: 1 })
    expect(usageCallsTo(h.fake, 'setDomainQuantity')[0]!.params).toMatchObject({ quantity: 1 })
    expect((await billingRow()).domainQuantity).toBe(1)
    expect((await auditRows('billing.domain_quantity_synced'))[0]!.detail).toMatchObject({ from: 2, to: 1 })

    const again = makeDeps(DAY1)
    expect(await runBillingReportUsage(again.deps)).toMatchObject({ quantitySynced: 0 })
    expect(usageCallsTo(again.fake, 'setDomainQuantity')).toEqual([])
  })

  it('a row with no subscription item syncs nothing (a trial has no licensed line to update)', async () => {
    await seedBilling({ plan: 'trial', status: 'trialing', stripeSubscriptionId: null, stripeDomainItemId: null, domainQuantity: 0 })
    await seedAgents(['acme.test'])

    const h = makeDeps(DAY1)
    const result = await runBillingReportUsage(h.deps)

    expect(usageCallsTo(h.fake, 'setDomainQuantity')).toEqual([])
    expect(result.quantitySynced).toBe(0)
  })

  it('a failed quantity sync alerts and leaves domain_quantity alone', async () => {
    await seedBilling({ domainQuantity: 2 })
    await seedAgents(['acme.test', 'acme.co', 'acme.io'])

    const h = makeDeps(DAY1)
    h.fake.failing.add('setDomainQuantity')
    const result = await runBillingReportUsage(h.deps)

    expect(result.quantitySynced).toBe(0)
    expect(h.errors.some((e) => e.alert === true && e.kind === 'stripe_report_failed')).toBe(true)
    expect((await billingRow()).domainQuantity).toBe(2)
  })
})

// -- the local notices -------------------------------------------------------

describe('billing.report-usage: the trial and allowance notices', () => {
  it(`a trial ending in ${TRIAL_ENDING_NOTICE_DAYS} days pages once per day, deduped on the day`, async () => {
    const now = new Date('2026-06-15T00:20:00Z')
    await seedBilling({
      plan: 'trial', status: 'trialing', stripeCustomerId: null, stripeSubscriptionId: null, stripeDomainItemId: null,
      trialEndsAt: new Date('2026-06-17T09:00:00Z'),
    })

    const h = makeDeps(now)
    const result = await runBillingReportUsage(h.deps)

    expect(result.trialNotices).toBe(1)
    const rows = await notificationRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'billing', dedupeKey: `billing:trial_ending:${orgId}:2026-06-15` })
    expect(h.notified).toEqual([rows[0]!.id])

    // The same day again inserts nothing and pages nobody.
    const again = makeDeps(now)
    expect((await runBillingReportUsage(again.deps)).trialNotices).toBe(0)
    expect(await notificationRows()).toHaveLength(1)
    expect(again.notified).toEqual([])
  })

  it('a trial ending further out than the notice window says nothing yet', async () => {
    await seedBilling({
      plan: 'trial', status: 'trialing', stripeCustomerId: null, stripeSubscriptionId: null, stripeDomainItemId: null,
      trialEndsAt: new Date('2026-06-25T09:00:00Z'),
    })

    const h = makeDeps(new Date('2026-06-15T00:20:00Z'))

    expect((await runBillingReportUsage(h.deps)).trialNotices).toBe(0)
    expect(await notificationRows()).toEqual([])
  })

  it('a trial that ended yesterday pages trial_ended exactly once, ever', async () => {
    await seedBilling({
      plan: 'trial', status: 'trialing', stripeCustomerId: null, stripeSubscriptionId: null, stripeDomainItemId: null,
      trialEndsAt: new Date('2026-06-14T09:00:00Z'),
    })

    const first = makeDeps(new Date('2026-06-15T00:20:00Z'))
    expect((await runBillingReportUsage(first.deps)).trialNotices).toBe(1)
    const rows = await notificationRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'billing', dedupeKey: `billing:trial_ended:${orgId}` })

    // A week later — still the one page: the trial only ends once.
    const later = makeDeps(new Date('2026-06-22T00:20:00Z'))
    expect((await runBillingReportUsage(later.deps)).trialNotices).toBe(0)
    expect(await notificationRows()).toHaveLength(1)
  })

  /**
   * Controller ruling R11: the page follows `isAllowanceExhausted`, so BOTH arms of that predicate
   * page — `standard` + `blocked`, and `trial` (whose flat allowance stops it whatever the overage
   * mode). `standard` + `automatic` is the one case that must stay silent: it is not exhausted, it
   * simply bills overage.
   */
  it('a standard + blocked workspace at its allowance pages allowance_reached once per PERIOD', async () => {
    await seedBilling({ overageMode: 'blocked' })
    await setManagedUsed(600)

    const h = makeDeps(DAY1)
    const result = await runBillingReportUsage(h.deps)

    expect(result.trialNotices).toBe(1)
    const rows = await notificationRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'billing', dedupeKey: `billing:allowance:${orgId}:${PERIOD_START_ISO}` })
    expect(rows[0]!.title).toBe('Included conversations used up')
    expect(rows[0]!.body).toContain('Automatic replies have paused')
    expect(rows[0]!.body).toContain('Drafts keep arriving for review')
    expect(rows[0]!.body).toContain('allow overage')
    expect(h.notified).toEqual([rows[0]!.id])

    // A later day in the SAME period says nothing more.
    const later = makeDeps(DAY3)
    expect((await runBillingReportUsage(later.deps)).trialNotices).toBe(0)
    expect(await notificationRows()).toHaveLength(1)
  })

  it('a TRIAL at its flat 50 pages too, under AUTOMATIC overage — the same predicate that stopped its Autopilot', async () => {
    await seedBilling({
      plan: 'trial', status: 'trialing', overageMode: 'automatic', domainQuantity: 0,
      stripeCustomerId: null, stripeSubscriptionId: null, stripeDomainItemId: null,
      // Far enough out that `trial_ending` cannot fire and confuse the count.
      trialEndsAt: new Date('2026-06-30T09:00:00Z'),
    })
    await setManagedUsed(50)          // BILLING_PRICING.trialIncludedConversations

    const h = makeDeps(DAY1)
    const result = await runBillingReportUsage(h.deps)

    expect(result.trialNotices).toBe(1)
    const rows = await notificationRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'billing', dedupeKey: `billing:allowance:${orgId}:${PERIOD_START_ISO}` })
    expect(rows[0]!.title).toBe('Included conversations used up')
    expect(rows[0]!.body).toContain('Automatic replies have paused')
    expect(rows[0]!.body).toContain('subscribe')
    expect(h.notified).toEqual([rows[0]!.id])

    // Nothing was reported to Stripe: a trial is never billed for overage.
    expect(usageCallsTo(h.fake, 'reportOverage')).toEqual([])
  })

  it('a STANDARD workspace on automatic overage past its allowance is NOT paged — it is simply billed', async () => {
    await seedBilling({ overageMode: 'automatic' })
    await setManagedUsed(700)

    const h = makeDeps(DAY1)
    const result = await runBillingReportUsage(h.deps)

    expect(result.trialNotices).toBe(0)
    expect(await notificationRows()).toEqual([])
    // …and the overage that silence stands for really was reported.
    expect(usageCallsTo(h.fake, 'reportOverage')[0]!.params).toMatchObject({ value: 100 })
  })
})

// -- the pass itself ---------------------------------------------------------

describe('billing.report-usage: the pass', () => {
  it('visits only workspaces with a billing row, and one failing org does not stop the rest', async () => {
    await seedBilling()
    await setManagedUsed(601)
    const firstOrg = orgId

    // A second workspace, also billable.
    const secondOrg = await createTestOrganization(app)
    await withOrg(app.db, secondOrg, async (tx) => {
      await tx.insert(workspaces).values({ orgId: secondOrg, businessName: 'Beta', timezone: 'UTC' })
      await tx.insert(billingSubscriptions).values({
        orgId: secondOrg, plan: 'standard', status: 'active', stripeCustomerId: `cus_${rand()}`,
        domainQuantity: 1, currentPeriodStart: PERIOD_START, currentPeriodEnd: PERIOD_END,
      })
      await tx.insert(usageCounters).values({ orgId: secondOrg, day: '2026-06-10', meter: SEND_METERS.aiHandledManaged, value: 305 })
    })
    // A third with NO billing row at all: it must never be visited.
    const thirdOrg = await createTestOrganization(app)
    await withOrg(app.db, thirdOrg, (tx) => tx.insert(workspaces).values({ orgId: thirdOrg, businessName: 'Gamma', timezone: 'UTC' }))

    const h = makeDeps(DAY1)
    const result = await runBillingReportUsage(h.deps)

    expect(result.orgs).toBe(2)
    expect(result.reported).toBe(2)
    const reported = usageCallsTo(h.fake, 'reportOverage').map((c) => (c.params as { identifier: string }).identifier)
    expect(reported).toContain(`${firstOrg}:${PERIOD_START_ISO}:1`)
    expect(reported).toContain(`${secondOrg}:${PERIOD_START_ISO}:5`)
  })

  // Ruling R28: no per-run window. The old `LIMIT 500` never rotated, so org 501+ was never billed
  // its overage and never told its trial was ending.
  it('visits EVERY workspace with a billing row — 501 orgs, and the lexicographically LAST is reported', async () => {
    await seedBilling()
    const orgIds: string[] = []
    for (let i = 0; i < 500; i += 1) orgIds.push(await createTestOrganization(app, `bulk-${i}`))
    await withPlatform(app.db, 'test:seed-501', async (tx) => {
      await tx.insert(billingSubscriptions).values(orgIds.map((id) => ({
        orgId: id, plan: 'standard', status: 'active', stripeCustomerId: `cus_${rand()}`,
        domainQuantity: 1, currentPeriodStart: PERIOD_START, currentPeriodEnd: PERIOD_END,
      })))
    })
    const last = [...orgIds, orgId].sort().at(-1)!
    await withOrg(app.db, last, (tx) =>
      tx.insert(usageCounters).values({ orgId: last, day: '2026-06-10', meter: SEND_METERS.aiHandledManaged, value: 301 })
        .onConflictDoUpdate({ target: [usageCounters.orgId, usageCounters.day, usageCounters.meter], set: { value: 301 } }))

    const h = makeDeps(DAY1)
    const result = await runBillingReportUsage(h.deps)

    expect(result.orgs).toBe(501)
    const reported = usageCallsTo(h.fake, 'reportOverage').map((c) => (c.params as { identifier: string }).identifier)
    expect(reported).toContain(`${last}:${PERIOD_START_ISO}:1`)
  }, 60_000)
})
