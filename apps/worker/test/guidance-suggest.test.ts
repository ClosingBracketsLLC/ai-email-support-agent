/**
 * `runGuidanceSuggest` against real Postgres with a `createFakeProvider` script — no pg-boss, no
 * real Anthropic call. One `it` per behavior in the task brief's `guidance.suggest` bullet list.
 */
import { randomBytes } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import pino from 'pino'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  agents, auditLog, categories, drafts, ensureDefaultCategories, guidanceSuggestions,
  mailboxConnections, orgSettings, platformState, tickets, usageCounters, user, withOrg, withPlatform,
  workspaces,
} from '@aesa/db'
import { createDb } from '@aesa/db/raw'
import { createTestDatabase, createTestOrganization } from '@aesa/db/testing'
import { createFakeProvider } from '@aesa/llm'
import { runGuidanceSuggest, type GuidanceSuggestDeps } from '../src/jobs/guidance-suggest.ts'
import { utcDayString } from '../src/date-utils.ts'

const rand = () => randomBytes(4).toString('hex')
const NOW = new Date('2026-09-11T12:00:00Z')
const TODAY = utcDayString(NOW)

let t: Awaited<ReturnType<typeof createTestDatabase>>
let app: ReturnType<typeof createDb>
let userId: string

interface Fixture { orgId: string; connectionId: string; agentId: string; categoryId: string }
let fx: Fixture

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
beforeEach(async () => { fx = await seedOrg() })

async function seedOrg(): Promise<Fixture> {
  const orgId = await createTestOrganization(app)
  return withOrg(app.db, orgId, async (tx) => {
    await tx.insert(workspaces).values({
      orgId, businessName: 'Acme Dog Supplies', timezone: 'UTC',
      operatingGuidance: 'Always confirm the order number before quoting a delivery window.',
    })
    await ensureDefaultCategories(tx)
    const [conn] = await tx.insert(mailboxConnections)
      .values({ orgId, provider: 'gmail', providerAccountId: `acct-${rand()}`, emailAddress: `support-${rand()}@acme.test`, status: 'connected', connectedByUserId: userId })
      .returning({ id: mailboxConnections.id })
    const [agent] = await tx.insert(agents)
      .values({ orgId, connectionId: conn!.id, address: `support-${rand()}@acme.test`, domain: 'acme.test', displayName: 'Acme Support', status: 'active', priority: 0, signature: 'Acme Support', guidanceExtra: 'Keep replies short.' })
      .returning({ id: agents.id })
    const cats = await tx.select({ id: categories.id, key: categories.key }).from(categories)
    return { orgId, connectionId: conn!.id, agentId: agent!.id, categoryId: cats.find((c) => c.key === 'order_status')!.id }
  })
}

interface SeedOpts {
  editDistanceRatio?: number
  decisionSource?: 'app' | 'email' | 'auto'
  body?: string
  finalBody?: string
}

/** The one draft column set `guidance.suggest` reads: no ticket needed — the job never touches one. */
async function seedApprovedDraft(opts: SeedOpts = {}): Promise<string> {
  const {
    editDistanceRatio = 0.4, decisionSource = 'app',
    body = 'Your order ships within five business days.', finalBody = 'Your order ships within two business days.',
  } = opts
  // guidance.suggest reads only drafts columns, but the FK to tickets is NOT NULL — a minimal ticket row.
  const [ticket] = await withOrg(app.db, fx.orgId, (tx) =>
    tx.insert(tickets).values({
      orgId: fx.orgId, connectionId: fx.connectionId, agentId: fx.agentId, providerThreadId: `thread-${rand()}`,
      status: 'resolved', categoryId: fx.categoryId,
    }).returning({ id: tickets.id }))
  const [draft] = await withOrg(app.db, fx.orgId, (tx) =>
    tx.insert(drafts).values({
      orgId: fx.orgId, ticketId: ticket!.id, agentId: fx.agentId, categoryId: fx.categoryId, version: 1,
      body, finalBody, decision: 'review', decisionReason: 'below_threshold', status: 'sent',
      threadSnapshotAt: NOW, expiresAt: new Date(NOW.getTime() + 86_400_000),
      decidedBy: userId, decidedAt: NOW, decisionSource, editDistanceRatio,
    }).returning({ id: drafts.id }))
  return draft!.id
}

async function setCapMeter(value: number): Promise<void> {
  await withOrg(app.db, fx.orgId, (tx) =>
    tx.insert(usageCounters).values({ orgId: fx.orgId, day: TODAY, meter: 'guidance_suggest_calls', value })
      .onConflictDoUpdate({ target: [usageCounters.orgId, usageCounters.day, usageCounters.meter], set: { value } }))
}

async function meter(name: string): Promise<number> {
  const [row] = await withOrg(app.db, fx.orgId, (tx) =>
    tx.select().from(usageCounters).where(and(eq(usageCounters.day, TODAY), eq(usageCounters.meter, name))))
  return row?.value ?? 0
}

const allSuggestions = async () => withOrg(app.db, fx.orgId, (tx) => tx.select().from(guidanceSuggestions))
const auditRows = async (entityId: string, action: string) =>
  withOrg(app.db, fx.orgId, (tx) => tx.select().from(auditLog).where(and(eq(auditLog.entityId, entityId), eq(auditLog.action, action))))

function makeDeps(provider: GuidanceSuggestDeps['provider'], over: Partial<GuidanceSuggestDeps> = {}): GuidanceSuggestDeps {
  return { db: app.db, provider, logger: pino({ level: 'silent' }), now: () => NOW, ...over }
}

const run = (deps: GuidanceSuggestDeps, draftId: string) =>
  runGuidanceSuggest(deps, { orgId: fx.orgId, draftId }, new AbortController().signal)

describe('guidance.suggest', () => {
  it('an edited approval yields one pending guidance_suggestions row from the model; the call is metered under guidance_suggest_calls with role guidance_suggest', async () => {
    const draftId = await seedApprovedDraft({ editDistanceRatio: 0.4 })
    const provider = createFakeProvider([], {
      byRole: { guidance_suggest: [{ parsed: { suggestion: 'Orders ship within two business days, not five.', rationale: 'The owner corrected the shipping estimate.' } }] },
    })
    const deps = makeDeps(provider)

    const outcome = await run(deps, draftId)

    expect(outcome).toBe('suggested')
    const rows = await allSuggestions()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.text).toBe('Orders ship within two business days, not five.')
    expect(rows[0]!.rationale).toBe('The owner corrected the shipping estimate.')
    expect(rows[0]!.status).toBe('pending')
    expect(rows[0]!.sourceDraftId).toBe(draftId)
    expect(rows[0]!.agentId).toBe(fx.agentId)
    expect(rows[0]!.categoryId).toBe(fx.categoryId)

    expect(await meter('guidance_suggest_calls')).toBe(1)
    const calls = provider.callsFor('guidance_suggest')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.meta.role).toBe('guidance_suggest')
    expect(calls[0]!.meta.orgId).toBe(fx.orgId)

    const suggested = await auditRows(draftId, 'guidance.suggested')
    expect(suggested).toHaveLength(1)
  })

  it('a cosmetic edit (ratio < 0.05) is skipped before any call', async () => {
    const draftId = await seedApprovedDraft({ editDistanceRatio: 0.01 })
    const provider = createFakeProvider([{ parsed: { suggestion: 'should never run', rationale: '' } }])
    const deps = makeDeps(provider)

    const outcome = await run(deps, draftId)

    expect(outcome).toBe('skipped')
    expect(await allSuggestions()).toHaveLength(0)
    expect(provider.calls).toHaveLength(0)
    expect(await meter('guidance_suggest_calls')).toBe(0)
  })

  it('a null suggestion inserts nothing; an exact duplicate of a pending/accepted suggestion inserts nothing', async () => {
    // A: a null suggestion.
    const nullDraftId = await seedApprovedDraft()
    const nullProvider = createFakeProvider([], { byRole: { guidance_suggest: [{ parsed: { suggestion: null, rationale: '' } }] } })
    expect(await run(makeDeps(nullProvider), nullDraftId)).toBe('none')
    expect(await allSuggestions()).toHaveLength(0)

    // B: an exact duplicate of an existing pending suggestion (seeded directly, on a DIFFERENT draft).
    const existingDraftId = await seedApprovedDraft()
    await withOrg(app.db, fx.orgId, (tx) =>
      tx.insert(guidanceSuggestions).values({
        orgId: fx.orgId, agentId: fx.agentId, categoryId: fx.categoryId, sourceDraftId: existingDraftId,
        text: 'Orders ship within two business days, not five.', rationale: 'earlier edit', status: 'pending',
      }))
    const dupDraftId = await seedApprovedDraft()
    const dupProvider = createFakeProvider([], {
      byRole: { guidance_suggest: [{ parsed: { suggestion: 'Orders ship within two business days, not five.', rationale: 'a second, unrelated edit' } }] },
    })
    const outcome = await run(makeDeps(dupProvider), dupDraftId)

    expect(outcome).toBe('none')
    expect(await allSuggestions()).toHaveLength(1)
  })

  it('the daily cap (guidance.daily_suggest_cap) is fail-closed: at the cap the job returns capped and makes no call', async () => {
    const draftId = await seedApprovedDraft()
    await setCapMeter(50) // the code default for guidance.daily_suggest_cap
    const provider = createFakeProvider([{ parsed: { suggestion: 'should never run', rationale: '' } }])
    const deps = makeDeps(provider)

    const outcome = await run(deps, draftId)

    expect(outcome).toBe('capped')
    expect(await allSuggestions()).toHaveLength(0)
    expect(provider.calls).toHaveLength(0)
    expect(await meter('guidance_suggest_calls')).toBe(50)
  })

  it('respects an org override of guidance.daily_suggest_cap', async () => {
    const draftId = await seedApprovedDraft()
    await withOrg(app.db, fx.orgId, (tx) =>
      tx.insert(orgSettings).values({ orgId: fx.orgId, key: 'guidance.daily_suggest_cap', value: 1 }))
    await setCapMeter(1)
    const provider = createFakeProvider([{ parsed: { suggestion: 'should never run', rationale: '' } }])
    const deps = makeDeps(provider)

    const outcome = await run(deps, draftId)

    expect(outcome).toBe('capped')
    expect(provider.calls).toHaveLength(0)
  })

  it('the platform kill lever is a policy no-op: skipped, no cap bump, no call, no row', async () => {
    await withPlatform(app.db, 'test:killswitch', (tx) =>
      tx.insert(platformState).values({ key: 'killswitch.global', value: true })
        .onConflictDoUpdate({ target: platformState.key, set: { value: true } }))
    const draftId = await seedApprovedDraft({ editDistanceRatio: 0.4 })
    const provider = createFakeProvider([{ parsed: { suggestion: 'should never run', rationale: '' } }])
    const deps = makeDeps(provider)

    let outcome: Awaited<ReturnType<typeof run>>
    try {
      outcome = await run(deps, draftId)
    } finally {
      await withPlatform(app.db, 'test:killswitch', (tx) => tx.delete(platformState).where(eq(platformState.key, 'killswitch.global')))
    }

    expect(outcome).toBe('skipped')
    expect(provider.calls).toHaveLength(0)
    expect(await allSuggestions()).toHaveLength(0)
    expect(await meter('guidance_suggest_calls')).toBe(0)
  })
})
