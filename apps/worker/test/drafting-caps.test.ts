/**
 * The advisory-locked draft gate (`drafting/caps.ts`) and the run bookkeeping (`drafting/runs.ts`)
 * against real Postgres. The gate's four refusals are checked in the order it evaluates them, and
 * the concurrency test runs two gates for the SAME org on two connections at once — the lock has to
 * serialize them without deadlocking, and both must come away with their own run row.
 */
import { randomBytes } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { INVARIANTS, PLANS, planSettingDefaults } from '@aesa/core'
import {
  agentRunEvents, agentRuns, LLM_METERS, mailboxConnections, tickets, usageCounters, user, withOrg, withPlatform, workspaces,
  type BillingStateView, type SettingSources,
} from '@aesa/db'
import { createDb } from '@aesa/db/raw'
import { createTestDatabase, createTestOrganization } from '@aesa/db/testing'
import { DRAFT_METER, gateAndRecordRun, PER_ORG_DRAFT_CONCURRENCY, readCapsUnlocked, utcMidnight } from '../src/drafting/caps.ts'
import { appendRunEvent, finishRun, markStuckRuns } from '../src/drafting/runs.ts'

const rand = () => randomBytes(4).toString('hex')
const NOW = new Date('2026-06-15T12:00:00Z')
const TODAY = '2026-06-15'
const YESTERDAY = '2026-06-14'
const YESTERDAY_DATE = new Date('2026-06-14T12:00:00Z')
const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60_000)
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const ZERO_USAGE = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, apiCalls: 0, costMicros: 0 }

let t: Awaited<ReturnType<typeof createTestDatabase>>
let app: ReturnType<typeof createDb>
let orgId: string
let connectionId: string
let ticketId: string

beforeAll(async () => {
  t = await createTestDatabase()
  app = createDb(t.url)
  orgId = await createTestOrganization(app)
  const [u] = await app.db.insert(user).values({ name: 'Owner', email: `owner-${rand()}@example.com` }).returning()
  await withOrg(app.db, orgId, async (tx) => {
    await tx.insert(workspaces).values({ orgId, businessName: 'Acme', timezone: 'UTC' })
    const [row] = await tx
      .insert(mailboxConnections)
      .values({ orgId, provider: 'gmail', providerAccountId: `acct-${rand()}`, emailAddress: `support-${rand()}@acme.test`, status: 'connected', connectedByUserId: u!.id })
      .returning({ id: mailboxConnections.id })
    connectionId = row!.id
  })
})
afterAll(async () => {
  await app.pool.end()
  await t.drop()
})

// One org is shared by every test, so agent_runs and usage_counters are shared state: a `running`
// row left behind by one test would trip the NEXT test's org-concurrency check, and a meter left
// high would cap it. Reset both before every test rather than relying on end-of-test cleanup.
// (The caps themselves are NOT org_settings rows here: the gate resolves them from the `settings`
// object its caller passes — the draft job is what reads org_settings, in Task 11.)
beforeEach(async () => {
  await withOrg(app.db, orgId, (tx) => tx.delete(agentRuns))   // agent_run_events cascade
  // Every day, not just today: the trial budget sums the whole history, so a counter one test
  // seeded on an earlier day would silently cap the next one.
  await withOrg(app.db, orgId, (tx) => tx.delete(usageCounters))
  ticketId = await seedTicket()
})

async function seedTicket(): Promise<string> {
  const [row] = await withOrg(app.db, orgId, (tx) =>
    tx.insert(tickets).values({ orgId, connectionId, providerThreadId: `thread-${rand()}`, status: 'triaged' }).returning({ id: tickets.id }))
  return row!.id
}

async function setUsageCounter(meter: string, value: number, day = TODAY): Promise<void> {
  await withOrg(app.db, orgId, (tx) =>
    tx.insert(usageCounters).values({ orgId, day, meter, value })
      .onConflictDoUpdate({ target: [usageCounters.orgId, usageCounters.day, usageCounters.meter], set: { value } }))
}

async function readUsageCounter(meter: string, day = TODAY): Promise<number> {
  const [row] = await withOrg(app.db, orgId, (tx) =>
    tx.select({ value: usageCounters.value }).from(usageCounters).where(and(eq(usageCounters.day, day), eq(usageCounters.meter, meter))))
  return row?.value ?? 0
}

async function seedRun(overrides: Partial<typeof agentRuns.$inferInsert> = {}): Promise<string> {
  const [row] = await withOrg(app.db, orgId, (tx) =>
    tx.insert(agentRuns).values({
      orgId, kind: 'draft', ticketId, provider: 'anthropic', model: 'claude-x', status: 'succeeded', startedAt: minutesAgo(5), ...overrides,
    }).returning({ id: agentRuns.id }))
  return row!.id
}

async function runRows() {
  return withOrg(app.db, orgId, (tx) => tx.select().from(agentRuns))
}

/** What `readBillingState` returns, as `loadSettingSources` carries it on `SettingSources.billing`
 *  (ruling R27): the gate reads the derived `state` and the trial clock `agentEnabledAt` off it. */
function billingView(over: Partial<BillingStateView> = {}): BillingStateView {
  const plan = over.plan ?? 'standard'
  return {
    orgId, plan, status: plan === 'trial' ? 'trialing' : 'active', trialEndsAt: null,
    currentPeriodStart: null, currentPeriodEnd: null, domainQuantity: 1, includedConversationsPerDomain: 300,
    overageMode: 'automatic', overageUnitCents: 12, stripeCustomerId: null, stripeSubscriptionId: null,
    stripeDomainItemId: null, stripeOverageItemId: null, overageReported: 0, overageReportedPeriodStart: null,
    cancelAtPeriodEnd: false, lastStripeEventCreated: null,
    state: plan === 'trial' ? 'trialing' : 'active', active: true, allowance: plan === 'trial' ? 50 : 300,
    period: { start: new Date('2026-06-01T00:00:00Z'), end: new Date('2026-07-01T00:00:00Z') },
    missingRow: false, agentEnabledAt: null,
    ...over,
  }
}
/** What `loadSettingSources` returns for a workspace on the paid plan with no overrides — the
 *  shape `GateParams.settings` now takes (Phase 7: org rows AND the plan's defaults). */
const SETTINGS: SettingSources = { org: {}, plan: planSettingDefaults('standard'), planId: 'standard', billing: billingView() }
/** The same for a trial workspace: a 50-draft day, a $3 day and the $10 TOTAL trial budget. */
const TRIAL_SETTINGS: SettingSources = { org: {}, plan: planSettingDefaults('trial'), planId: 'trial', billing: billingView({ plan: 'trial' }) }

const gate = (over: Partial<Parameters<typeof gateAndRecordRun>[1]> = {}, db = app.db) =>
  withOrg(db, orgId, (tx) =>
    gateAndRecordRun(tx, {
      orgId, ticketId, agentId: null, kind: 'draft', provider: 'anthropic', model: 'claude-x',
      input: { redraft: false }, settings: SETTINGS, now: NOW, ...over,
    }))

describe('gateAndRecordRun', () => {
  it('proceeds: writes the run row BEFORE the model call and bumps the draft meter', async () => {
    const result = await gate()

    expect(result.outcome).toBe('proceed')
    const rows = await runRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: result.outcome === 'proceed' ? result.runId : '', kind: 'draft', status: 'running', model: 'claude-x', provider: 'anthropic', ticketId, input: { redraft: false } })
    expect(rows[0]!.startedAt).toEqual(NOW)
    expect(await readUsageCounter(DRAFT_METER)).toBe(1)
  })

  it('ticket_capped: the per-ticket daily cap refuses without writing a run row', async () => {
    for (let i = 0; i < INVARIANTS.AGENT_MAX_RUNS_PER_TICKET_PER_DAY; i++) await seedRun()

    const result = await gate()

    expect(result).toEqual({ outcome: 'ticket_capped', runsToday: INVARIANTS.AGENT_MAX_RUNS_PER_TICKET_PER_DAY })
    expect(await runRows()).toHaveLength(INVARIANTS.AGENT_MAX_RUNS_PER_TICKET_PER_DAY)
    expect(await readUsageCounter(DRAFT_METER)).toBe(0)
  })

  it("a run that started yesterday does not count toward today's per-ticket cap", async () => {
    const yesterday = new Date(`${YESTERDAY}T23:30:00Z`)
    for (let i = 0; i < INVARIANTS.AGENT_MAX_RUNS_PER_TICKET_PER_DAY; i++) await seedRun({ startedAt: yesterday })

    expect((await gate()).outcome).toBe('proceed')
  })

  it("another ticket's runs do not count toward this ticket's cap", async () => {
    const other = await seedTicket()
    for (let i = 0; i < INVARIANTS.AGENT_MAX_RUNS_PER_TICKET_PER_DAY; i++) await seedRun({ ticketId: other })

    expect((await gate()).outcome).toBe('proceed')
  })

  it('org_busy: two live running draft runs hold the org at its concurrency limit', async () => {
    const other = await seedTicket()
    for (let i = 0; i < PER_ORG_DRAFT_CONCURRENCY; i++) await seedRun({ ticketId: other, status: 'running', startedAt: minutesAgo(1) })

    expect(await gate()).toEqual({ outcome: 'org_busy' })
    expect(await readUsageCounter(DRAFT_METER)).toBe(0)
  })

  it('org_busy ignores a running row older than the job expiry — that one is stuck, not live', async () => {
    const other = await seedTicket()
    const stale = new Date(NOW.getTime() - (INVARIANTS.DRAFT_JOB_EXPIRE_SECONDS + 60) * 1000)
    for (let i = 0; i < PER_ORG_DRAFT_CONCURRENCY; i++) await seedRun({ ticketId: other, status: 'running', startedAt: stale })

    expect((await gate()).outcome).toBe('proceed')
  })

  it("org_draft_capped: the caller's resolved daily draft cap is what the meter is measured against", async () => {
    await setUsageCounter(DRAFT_METER, 1)

    expect(await gate({ settings: { ...SETTINGS, org: { 'autonomy.daily_draft_cap': 1 } } })).toEqual({ outcome: 'org_draft_capped' })
    expect(await runRows()).toHaveLength(0)
    expect(await readUsageCounter(DRAFT_METER)).toBe(1)
  })

  it('org_spend_capped: the daily USD cap is compared in micros', async () => {
    await setUsageCounter('llm_cost_micros', 60_000_000)

    expect(await gate()).toEqual({ outcome: 'org_spend_capped', scope: 'daily', costMicros: 60_000_000 })
    expect(await runRows()).toHaveLength(0)
  })

  // Phase 7 branch 4b. The trial's TOTAL Managed-AI budget, summed over every day there has ever
  // been — the daily cap passes ($2.50 today against the trial's $3) and the trial total ($10.50
  // against $10) is what refuses. Worked with real numbers so the two caps cannot be confused.
  it("org_spend_capped/trial: the trial's TOTAL budget trips even when today's daily cap passes", async () => {
    await setUsageCounter(LLM_METERS.costMicros, 2_500_000)                       // $2.50 today  < $3 daily
    await setUsageCounter(LLM_METERS.costMicros, 5_000_000, '2026-06-13')         // $5.00 earlier
    await setUsageCounter(LLM_METERS.costMicros, 3_000_000, YESTERDAY)            // $3.00 earlier — $10.50 total

    expect(await gate({ settings: TRIAL_SETTINGS })).toEqual({
      outcome: 'org_spend_capped', scope: 'trial', costMicros: PLANS.trial.llmUsdBudget * 1_000_000 + 500_000,
    })
    expect(await runRows()).toHaveLength(0)
    expect(await readUsageCounter(DRAFT_METER)).toBe(0)
  })

  it('the same spend on a standard workspace proceeds — a paid plan has no total budget at all', async () => {
    await setUsageCounter(LLM_METERS.costMicros, 2_500_000)
    await setUsageCounter(LLM_METERS.costMicros, 5_000_000, '2026-06-13')
    await setUsageCounter(LLM_METERS.costMicros, 3_000_000, YESTERDAY)

    expect((await gate({ settings: SETTINGS })).outcome).toBe('proceed')
  })

  // Ruling R27: the budget applies to the derived STATE `trialing` alone. A cancelled workspace is
  // back on `plan = 'trial'` (deviation 8) with its whole paid-era spend behind it, and an expired
  // trial keeps its `trialing` row — both are already review-only via `subscription_inactive`.
  it('the same spend on a CANCELED workspace (plan trial, $500 of paid-era spend) and on an EXPIRED trial proceeds — only a live trial has the total budget', async () => {
    await setUsageCounter(LLM_METERS.costMicros, 2_500_000)
    await setUsageCounter(LLM_METERS.costMicros, 500_000_000, '2026-06-13')     // $500 while it paid

    const canceled: SettingSources = { ...TRIAL_SETTINGS, billing: billingView({ plan: 'trial', status: 'canceled', state: 'canceled', active: false }) }
    expect((await gate({ settings: canceled })).outcome).toBe('proceed')
    await withOrg(app.db, orgId, (tx) => tx.delete(agentRuns))

    const expired: SettingSources = { ...TRIAL_SETTINGS, billing: billingView({ plan: 'trial', state: 'trial_expired', active: false, trialEndsAt: YESTERDAY_DATE }) }
    expect((await gate({ settings: expired })).outcome).toBe('proceed')
  })

  it("the trial budget is summed from the trial's OWN clock (agent_enabled_at): spend that predates it does not count; with no clock, from the epoch", async () => {
    await setUsageCounter(LLM_METERS.costMicros, 2_500_000)                       // $2.50 today
    await setUsageCounter(LLM_METERS.costMicros, 9_000_000, '2026-06-01')         // $9.00 BEFORE the trial began

    const clocked: SettingSources = { ...TRIAL_SETTINGS, billing: billingView({ plan: 'trial', agentEnabledAt: new Date('2026-06-10T08:00:00Z') }) }
    expect((await gate({ settings: clocked })).outcome).toBe('proceed')
    await withOrg(app.db, orgId, (tx) => tx.delete(agentRuns))

    // The same counters with no clock at all: everything ever spent is the trial's.
    expect(await gate({ settings: TRIAL_SETTINGS })).toMatchObject({ outcome: 'org_spend_capped', scope: 'trial', costMicros: 11_500_000 })
  })

  it("org_draft_capped: the PLAN's daily draft cap is what gates, not the catalog default", async () => {
    await setUsageCounter(DRAFT_METER, PLANS.trial.dailyDraftCap)

    // 50 runs today is under the catalog default (2000) and AT the trial plan's own cap.
    expect(await gate({ settings: TRIAL_SETTINGS })).toEqual({ outcome: 'org_draft_capped' })
    expect((await gate({ settings: SETTINGS })).outcome).toBe('proceed')
  })

  it('evaluates the per-ticket cap FIRST — a capped ticket in a capped org still reads ticket_capped', async () => {
    for (let i = 0; i < INVARIANTS.AGENT_MAX_RUNS_PER_TICKET_PER_DAY; i++) await seedRun()
    await setUsageCounter('llm_cost_micros', 60_000_000)

    expect((await gate()).outcome).toBe('ticket_capped')
  })

  // (i) Contention: a gate really does WAIT on the org's advisory lock. A holder transaction on a
  // second connection takes the same lock and parks; the gate must not settle while it is held.
  it('blocks on the org advisory lock while another transaction holds it', async () => {
    const holder = createDb(t.url)
    let release!: () => void
    const lockGate = new Promise<void>((resolve) => { release = resolve })
    // `release()` also runs in the finally: a failed assertion below must not leave the holder
    // parked forever, or `pool.end()` would hang and the failure would surface as a timeout.
    let held: Promise<void> | undefined
    try {
      held = withOrg(holder.db, orgId, async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`draft-gate:${orgId}`}))`)
        await lockGate
      })
      await sleep(100)                       // the holder now owns the lock

      let settled = false
      const gating = gate().finally(() => { settled = true })
      await sleep(150)
      expect(settled).toBe(false)            // still waiting — the gate is genuinely serialized

      release()
      await held
      expect((await gating).outcome).toBe('proceed')
    } finally {
      release()
      await held
      await holder.pool.end()
    }
  })

  // (ii) The race the lock exists to stop: two workers gating for the same org against a cap of 1.
  // Unlocked, both read `draft_runs = 0` before either writes and BOTH proceed — one run over cap.
  // Serialized, the loser reads the winner's committed bump and is refused.
  it('serializes two concurrent gates: exactly one proceeds through a cap of 1', async () => {
    const otherTicketId = await seedTicket()       // hoisted: both gates must start together
    const second = createDb(t.url)
    const settings: SettingSources = { ...SETTINGS, org: { 'autonomy.daily_draft_cap': 1 } }
    try {
      // Warm the second pool first: establishing its connection takes long enough that an unwarmed
      // one would let the first gate finish before the second even began — no race to observe.
      await second.db.execute(sql`SELECT 1`)

      const results = await Promise.all([
        gate({ settings }),
        gate({ ticketId: otherTicketId, settings }, second.db),
      ])

      expect(results.map((r) => r.outcome).sort()).toEqual(['org_draft_capped', 'proceed'])
      expect(await runRows()).toHaveLength(1)
      expect(await readUsageCounter(DRAFT_METER)).toBe(1)
    } finally {
      await second.pool.end()
    }
  })
})

describe('readCapsUnlocked', () => {
  it('reports the three unlocked counts the pre-claim checks read', async () => {
    await seedRun()
    await seedRun()
    await seedRun({ ticketId: await seedTicket() })
    await setUsageCounter(DRAFT_METER, 7)
    await setUsageCounter('llm_cost_micros', 1_234_000)

    const caps = await withOrg(app.db, orgId, (tx) => readCapsUnlocked(tx, { orgId, ticketId, settings: SETTINGS, now: NOW }))

    expect(caps).toEqual({ ticketRunsToday: 2, orgCostMicrosToday: 1_234_000, orgDraftsToday: 7, orgTrialCostMicros: 1_234_000 })
  })

  it("mirrors the gate's trial budget read: orgTrialCostMicros sums every day from the trial's clock (every day ever, with no clock)", async () => {
    await setUsageCounter(LLM_METERS.costMicros, 2_500_000)
    await setUsageCounter(LLM_METERS.costMicros, 8_000_000, YESTERDAY)
    await setUsageCounter(LLM_METERS.costMicros, 4_000_000, '2026-06-01')

    const caps = await withOrg(app.db, orgId, (tx) => readCapsUnlocked(tx, { orgId, ticketId, settings: TRIAL_SETTINGS, now: NOW }))
    expect(caps.orgCostMicrosToday).toBe(2_500_000)
    expect(caps.orgTrialCostMicros).toBe(14_500_000)

    const clocked: SettingSources = { ...TRIAL_SETTINGS, billing: billingView({ plan: 'trial', agentEnabledAt: new Date('2026-06-10T08:00:00Z') }) }
    const fromClock = await withOrg(app.db, orgId, (tx) => readCapsUnlocked(tx, { orgId, ticketId, settings: clocked, now: NOW }))
    expect(fromClock.orgTrialCostMicros).toBe(10_500_000)
  })

  it('writes nothing — a capped ticket must never be stamped by a pre-check', async () => {
    for (let i = 0; i < INVARIANTS.AGENT_MAX_RUNS_PER_TICKET_PER_DAY; i++) await seedRun()

    await withOrg(app.db, orgId, (tx) => readCapsUnlocked(tx, { orgId, ticketId, settings: SETTINGS, now: NOW }))

    expect(await runRows()).toHaveLength(INVARIANTS.AGENT_MAX_RUNS_PER_TICKET_PER_DAY)
    expect(await readUsageCounter(DRAFT_METER)).toBe(0)
  })
})

describe('utcMidnight', () => {
  it('truncates to the UTC day, whatever the local zone', () => {
    expect(utcMidnight(NOW)).toEqual(new Date('2026-06-15T00:00:00Z'))
    expect(utcMidnight(new Date('2026-06-15T00:00:00Z'))).toEqual(new Date('2026-06-15T00:00:00Z'))
    expect(utcMidnight(new Date('2026-06-15T23:59:59.999Z'))).toEqual(new Date('2026-06-15T00:00:00Z'))
  })
})

describe('appendRunEvent', () => {
  it('numbers events 1, 2, 3 … per run, in the same transaction', async () => {
    const runId = await seedRun({ status: 'running' })
    const otherRunId = await seedRun({ status: 'running' })

    await withOrg(app.db, orgId, async (tx) => {
      await appendRunEvent(tx, runId, 'prompt', { blocks: 5 })
      await appendRunEvent(tx, runId, 'call', { attempt: 1 })
      await appendRunEvent(tx, otherRunId, 'error', { code: 'boom' })
      await appendRunEvent(tx, runId, 'decision', { outcome: 'reply' })
    })

    const rows = await withOrg(app.db, orgId, (tx) =>
      tx.select().from(agentRunEvents).where(eq(agentRunEvents.runId, runId)).orderBy(agentRunEvents.seq))
    expect(rows.map((r) => [r.seq, r.kind])).toEqual([[1, 'prompt'], [2, 'call'], [3, 'decision']])
    expect(rows[0]!.payload).toEqual({ blocks: 5 })
    expect(rows[0]!.orgId).toBe(orgId)

    const otherRows = await withOrg(app.db, orgId, (tx) => tx.select().from(agentRunEvents).where(eq(agentRunEvents.runId, otherRunId)))
    expect(otherRows.map((r) => r.seq)).toEqual([1])   // per run, not per org
  })
})

describe('finishRun', () => {
  it('writes the outcome and the usage totals, guarded on status running', async () => {
    const runId = await seedRun({ status: 'running' })

    const first = await withOrg(app.db, orgId, (tx) =>
      finishRun(tx, {
        runId, status: 'succeeded', output: { outcome: 'reply' },
        usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 5, cacheWriteTokens: 2, apiCalls: 2, costMicros: 4321 }, now: NOW,
      }))

    expect(first).toBe(true)
    const [row] = await withOrg(app.db, orgId, (tx) => tx.select().from(agentRuns).where(eq(agentRuns.id, runId)))
    expect(row).toMatchObject({
      status: 'succeeded', output: { outcome: 'reply' }, inputTokens: 10, outputTokens: 20,
      cacheReadTokens: 5, cacheWriteTokens: 2, apiCalls: 2, costMicros: 4321,
    })
    expect(row!.finishedAt).toEqual(NOW)

    // A second finish (a retry after the row already settled) must not rewrite it.
    const second = await withOrg(app.db, orgId, (tx) =>
      finishRun(tx, { runId, status: 'failed', errorCode: 'late', errorMessage: 'too late', usage: ZERO_USAGE, now: NOW }))
    expect(second).toBe(false)
    const [after] = await withOrg(app.db, orgId, (tx) => tx.select().from(agentRuns).where(eq(agentRuns.id, runId)))
    expect(after!.status).toBe('succeeded')
    expect(after!.errorCode).toBeNull()
  })

  it('records a failure with its scrubbed error code and message', async () => {
    const runId = await seedRun({ status: 'running' })

    await withOrg(app.db, orgId, (tx) =>
      finishRun(tx, { runId, status: 'failed', errorCode: 'model_error', errorMessage: 'provider 500', usage: ZERO_USAGE, now: NOW }))

    const [row] = await withOrg(app.db, orgId, (tx) => tx.select().from(agentRuns).where(eq(agentRuns.id, runId)))
    expect(row).toMatchObject({ status: 'failed', errorCode: 'model_error', errorMessage: 'provider 500' })
  })
})

describe('markStuckRuns', () => {
  it('flips only the running rows older than the cutoff, and reports them for the sweep to audit', async () => {
    const cutoff = new Date(NOW.getTime() - INVARIANTS.DRAFT_JOB_EXPIRE_SECONDS * 1000)
    const stuck = await seedRun({ status: 'running', startedAt: new Date(cutoff.getTime() - 60_000) })
    const live = await seedRun({ status: 'running', startedAt: new Date(cutoff.getTime() + 60_000) })
    const settled = await seedRun({ status: 'succeeded', startedAt: new Date(cutoff.getTime() - 60_000) })

    const flipped = await withPlatform(app.db, 'test:backstop-sweep', (tx) => markStuckRuns(tx, cutoff))

    expect(flipped).toEqual([{ id: stuck, orgId }])
    const byId = new Map((await runRows()).map((r) => [r.id, r]))
    expect(byId.get(stuck)).toMatchObject({ status: 'aborted', errorCode: 'stuck' })
    expect(byId.get(live)).toMatchObject({ status: 'running', errorCode: null })
    expect(byId.get(settled)).toMatchObject({ status: 'succeeded', errorCode: null })
  })

  it('returns an empty list when nothing is stuck', async () => {
    await seedRun({ status: 'running', startedAt: NOW })
    const cutoff = new Date(NOW.getTime() - INVARIANTS.DRAFT_JOB_EXPIRE_SECONDS * 1000)

    expect(await withPlatform(app.db, 'test:backstop-sweep', (tx) => markStuckRuns(tx, cutoff))).toEqual([])
  })
})
