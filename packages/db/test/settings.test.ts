import { planSettingDefaults, resolveSetting } from '@aesa/core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { billingSubscriptions, orgSettings, withOrg, workspaces } from '../src/index.ts'
import { createDb } from '../src/raw.ts'
import { loadSettingSources } from '../src/settings.ts'
import { createTestDatabase, createTestOrganization } from './helpers/test-db.ts'

describe('loadSettingSources', () => {
  let t: Awaited<ReturnType<typeof createTestDatabase>>
  let app: ReturnType<typeof createDb>

  beforeAll(async () => { t = await createTestDatabase(); app = createDb(t.url) })
  afterAll(async () => { await app.pool.end(); await t.drop() })

  const mkOrg = async (name: string) => {
    const id = await createTestOrganization(app, name)
    await withOrg(app.db, id, (tx) => tx.insert(workspaces).values({ orgId: id, businessName: name, timezone: 'UTC' }))
    return id
  }

  it('org carries only the requested keys; plan mirrors planSettingDefaults(trial) for a fresh org', async () => {
    const org = await mkOrg('Trial org')
    await withOrg(app.db, org, (tx) => tx.insert(orgSettings).values([
      { orgId: org, key: 'knowledge.max_sources', value: 7 },
      { orgId: org, key: 'sandbox.daily_cap', value: 3 },
    ]))

    const sources = await withOrg(app.db, org, (tx) => loadSettingSources(tx, ['knowledge.max_sources']))
    expect(sources.org).toEqual({ 'knowledge.max_sources': 7 })
    expect(sources.planId).toBe('trial')
    expect(sources.plan).toEqual(planSettingDefaults('trial'))
  })

  it('plan flips to standard once the billing row does', async () => {
    const org = await mkOrg('Flips to standard')
    await withOrg(app.db, org, (tx) => tx.insert(billingSubscriptions).values({ orgId: org, plan: 'standard', status: 'active' }))

    const sources = await withOrg(app.db, org, (tx) => loadSettingSources(tx, []))
    expect(sources.org).toEqual({})
    expect(sources.planId).toBe('standard')
    expect(sources.plan).toEqual(planSettingDefaults('standard'))
  })

  it('resolveSetting("knowledge.max_sources"): 10 on trial, 100 on standard, an org override of 7 wins on both', async () => {
    const trial = await mkOrg('Resolve trial')
    const trialSources = await withOrg(app.db, trial, (tx) => loadSettingSources(tx, ['knowledge.max_sources']))
    expect(resolveSetting('knowledge.max_sources', trialSources)).toBe(10)

    const standard = await mkOrg('Resolve standard')
    await withOrg(app.db, standard, (tx) => tx.insert(billingSubscriptions).values({ orgId: standard, plan: 'standard', status: 'active' }))
    const standardSources = await withOrg(app.db, standard, (tx) => loadSettingSources(tx, ['knowledge.max_sources']))
    expect(resolveSetting('knowledge.max_sources', standardSources)).toBe(100)

    await withOrg(app.db, trial, (tx) => tx.insert(orgSettings).values({ orgId: trial, key: 'knowledge.max_sources', value: 7 }))
    const trialOverride = await withOrg(app.db, trial, (tx) => loadSettingSources(tx, ['knowledge.max_sources']))
    expect(resolveSetting('knowledge.max_sources', trialOverride)).toBe(7)

    await withOrg(app.db, standard, (tx) => tx.insert(orgSettings).values({ orgId: standard, key: 'knowledge.max_sources', value: 7 }))
    const standardOverride = await withOrg(app.db, standard, (tx) => loadSettingSources(tx, ['knowledge.max_sources']))
    expect(resolveSetting('knowledge.max_sources', standardOverride)).toBe(7)
  })
})
