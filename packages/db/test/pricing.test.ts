import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { findPricing } from '@aesa/llm'
import { loadModelPricing } from '../src/index.ts'
import { createDb } from '../src/raw.ts'
import { createTestDatabase } from './helpers/test-db.ts'

describe('loadModelPricing', () => {
  let t: Awaited<ReturnType<typeof createTestDatabase>>
  let handle: ReturnType<typeof createDb>
  beforeAll(async () => { t = await createTestDatabase(); handle = createDb(t.url, { role: 'app' }) })
  afterAll(async () => { await handle.pool.end(); await t.drop() })

  it('returns rows as RegExp-pattern ModelPricing, most-specific pattern first so gpt-5-mini beats gpt-5', async () => {
    const rows = await loadModelPricing(handle.db)
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) expect(row.pattern).toBeInstanceOf(RegExp)
    expect(findPricing('gpt-5-mini', rows)?.id).toBe('gpt-5-mini')
    expect(findPricing('gpt-5', rows)?.id).toBe('gpt-5')
    expect(findPricing('claude-opus-5-20260909', rows)?.id).toBe('claude-opus-5')
  })
})
