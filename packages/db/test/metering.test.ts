import { randomBytes } from 'node:crypto'
import type { MeterRecord } from '@aesa/llm'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createMeterSink, LLM_METERS, llmCalls, usageCounters, withOrg, workspaces } from '../src/index.ts'
import { createDb } from '../src/raw.ts'
import { createTestDatabase, createTestOrganization } from './helpers/test-db.ts'

function makeRecord(orgId: string, overrides: Partial<MeterRecord> = {}): MeterRecord {
  return {
    orgId,
    agentId: null,
    runId: null,
    role: 'draft',
    provider: 'anthropic',
    model: 'claude-sonnet-5',
    idempotencyKey: `idem-${randomBytes(6).toString('hex')}`,
    usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheWriteTokens: 5, apiCalls: 1 },
    costMicros: 1234,
    costUnknown: false,
    latencyMs: 42,
    finish: 'stop',
    parseStrategy: 'native',
    errorCode: null,
    ...overrides,
  }
}

describe('createMeterSink', () => {
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

  const utcDay = (d: Date) => d.toISOString().slice(0, 10)

  const meterRow = async (meter: string) => {
    const rows = await withOrg(app.db, orgId, (tx) =>
      tx.select().from(usageCounters).where(and(eq(usageCounters.orgId, orgId), eq(usageCounters.meter, meter))))
    return rows[0]
  }

  it('records one llm_calls row with every column mapped and bumps the four meters', async () => {
    const now = new Date()
    const sink = createMeterSink(app.db, { now: () => now })
    const rec = makeRecord(orgId, {
      agentId: null, runId: null, role: 'draft', provider: 'anthropic', model: 'claude-sonnet-5',
      usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheWriteTokens: 5, apiCalls: 1 },
      costMicros: 1234, latencyMs: 42, finish: 'stop', parseStrategy: 'native', errorCode: null,
    })

    await sink.record(rec)

    const rows = await withOrg(app.db, orgId, (tx) => tx.select().from(llmCalls).where(eq(llmCalls.idempotencyKey, rec.idempotencyKey)))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      orgId, runId: null, agentId: null, role: 'draft', provider: 'anthropic', model: 'claude-sonnet-5',
      idempotencyKey: rec.idempotencyKey, inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheWriteTokens: 5,
      apiCalls: 1, costMicros: 1234, latencyMs: 42, finish: 'stop', parseStrategy: 'native', errorCode: null,
    })

    const day = utcDay(now)
    expect((await meterRow(LLM_METERS.calls))?.day).toBe(day)
    expect((await meterRow(LLM_METERS.calls))?.value).toBe(1)
    expect((await meterRow(LLM_METERS.costMicros))?.value).toBe(1234)
    // input meter = inputTokens + cacheReadTokens + cacheWriteTokens = 100 + 10 + 5
    expect((await meterRow(LLM_METERS.inputTokens))?.value).toBe(115)
    expect((await meterRow(LLM_METERS.outputTokens))?.value).toBe(50)
  })

  it('rounds a fractional latencyMs before insert (12.7 -> 13) and still bumps the meters', async () => {
    // Regression for the production defect: `llm_calls.latency_ms` is `integer`, but a caller can
    // hand the sink a float (`performance.now()` never returns a whole number). Before the fix, the
    // insert throws a Postgres "invalid input syntax for type integer" error that `createMeterSink`
    // swallows by design — so this exercises the REAL sink against Postgres, not a mock, because the
    // bug lives in what Postgres does with the value, not in any JS-level type check.
    const now = new Date()
    const sink = createMeterSink(app.db, { now: () => now })
    const rec = makeRecord(orgId, { latencyMs: 12.7 })
    const callsBefore = (await meterRow(LLM_METERS.calls))?.value ?? 0

    await sink.record(rec)

    const rows = await withOrg(app.db, orgId, (tx) => tx.select().from(llmCalls).where(eq(llmCalls.idempotencyKey, rec.idempotencyKey)))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.latencyMs).toBe(13)
    expect((await meterRow(LLM_METERS.calls))?.value).toBe(callsBefore + 1)
  })

  it('the same idempotencyKey again inserts nothing and leaves the meters unchanged', async () => {
    const now = new Date()
    const sink = createMeterSink(app.db, { now: () => now })
    const rec = makeRecord(orgId, { costMicros: 500, usage: { inputTokens: 20, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, apiCalls: 1 } })

    await sink.record(rec)
    const callsAfterFirst = (await meterRow(LLM_METERS.calls))?.value
    const costAfterFirst = (await meterRow(LLM_METERS.costMicros))?.value

    await sink.record(rec) // same idempotencyKey

    const rows = await withOrg(app.db, orgId, (tx) => tx.select().from(llmCalls).where(eq(llmCalls.idempotencyKey, rec.idempotencyKey)))
    expect(rows).toHaveLength(1)
    expect((await meterRow(LLM_METERS.calls))?.value).toBe(callsAfterFirst)
    expect((await meterRow(LLM_METERS.costMicros))?.value).toBe(costAfterFirst)
  })

  it('two different keys accumulate llm_cost_micros', async () => {
    const now = new Date()
    const sink = createMeterSink(app.db, { now: () => now })
    const before = (await meterRow(LLM_METERS.costMicros))?.value ?? 0

    await sink.record(makeRecord(orgId, { costMicros: 111 }))
    await sink.record(makeRecord(orgId, { costMicros: 222 }))

    expect((await meterRow(LLM_METERS.costMicros))?.value).toBe(before + 333)
  })

  it('an error record (finish: error, errorCode: rate_limit) is stored with zero tokens', async () => {
    const now = new Date()
    const sink = createMeterSink(app.db, { now: () => now })
    const rec = makeRecord(orgId, {
      finish: 'error', errorCode: 'rate_limit', costMicros: 0,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, apiCalls: 0 },
    })

    await sink.record(rec)

    const rows = await withOrg(app.db, orgId, (tx) => tx.select().from(llmCalls).where(eq(llmCalls.idempotencyKey, rec.idempotencyKey)))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ finish: 'error', errorCode: 'rate_limit', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })
  })

  it('a non-uuid orgId calls onError and resolves (never throws)', async () => {
    const errors: unknown[] = []
    const sink = createMeterSink(app.db, { onError: (err) => errors.push(err) })
    const rec = makeRecord('not-a-uuid')

    await expect(sink.record(rec)).resolves.toBeUndefined()
    expect(errors).toHaveLength(1)

    const rows = await withOrg(app.db, orgId, (tx) => tx.select().from(llmCalls).where(eq(llmCalls.idempotencyKey, rec.idempotencyKey)))
    expect(rows).toHaveLength(0)
  })
})
