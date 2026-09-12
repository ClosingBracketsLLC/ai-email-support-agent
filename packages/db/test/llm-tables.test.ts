import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestDatabase } from './helpers/test-db.ts'

describe('Phase 6 tables', () => {
  let t: Awaited<ReturnType<typeof createTestDatabase>>; let c: pg.Client
  beforeAll(async () => { t = await createTestDatabase(); c = new pg.Client({ connectionString: t.url }); await c.connect() })
  afterAll(async () => { await c.end(); await t.drop() })

  it('aesa_app has NO privilege on llm_credential_secrets (the key never reaches the api)', async () => {
    const res = await c.query(`SELECT privilege_type FROM information_schema.role_table_grants WHERE table_name = 'llm_credential_secrets' AND grantee = 'aesa_app'`)
    expect(res.rows).toEqual([])
  })
  it('agent_model_config is unique per (org, agent, role) with NULL agent rows NOT distinct', async () => {
    const res = await c.query(`SELECT indexdef FROM pg_indexes WHERE indexname = 'agent_model_config_org_agent_role_uidx'`)
    expect(res.rows[0]?.indexdef).toMatch(/UNIQUE/); expect(res.rows[0]?.indexdef).toMatch(/NULLS NOT DISTINCT/)
  })
  it('model_pricing is seeded with the managed rows and at least the OpenAI/DeepSeek families', async () => {
    const res = await c.query<{ id: string }>(`SELECT id FROM model_pricing ORDER BY id`)
    const ids = res.rows.map((r) => r.id)
    for (const id of ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5', 'gpt-5', 'gpt-5-mini', 'deepseek-chat']) expect(ids).toContain(id)
  })
  it('aesa_app has ONLY SELECT on model_pricing (only migrations write it)', async () => {
    const res = await c.query<{ privilege_type: string }>(`SELECT privilege_type FROM information_schema.role_table_grants WHERE table_name = 'model_pricing' AND grantee = 'aesa_app' ORDER BY privilege_type`)
    expect(res.rows.map((r) => r.privilege_type)).toEqual(['SELECT'])
  })
})
