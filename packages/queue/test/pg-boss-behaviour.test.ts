import type PgBoss from 'pg-boss'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createQueueRetrying } from '../src/pg-boss.ts'
import { deleteAllJobs, startTestBoss, uniqueName } from './helpers/boss.ts'

describe('pg-boss 10 behaviour we rely on', () => {
  let boss: PgBoss
  beforeAll(async () => { boss = await startTestBoss() })
  afterAll(async () => { await boss.stop({ graceful: false, wait: true }) })

  // `deleteAllJobs` (rather than `boss.purgeQueue`, which only removes state < active) runs
  // unconditionally in `finally` so a failed assertion inside `fn` — e.g. the exact regression the
  // ACTIVE-twin test below exists to catch — can never leave an active job (or the queue itself,
  // whose `deleteQueue` FK-checks against remaining job rows) behind in `pgboss_test`.
  async function withQueue(policy: 'singleton' | 'stately' | 'standard', fn: (name: string) => Promise<void>) {
    const name = uniqueName(`test.${policy}`)
    await createQueueRetrying(boss, name, { name, policy })
    try { await fn(name) } finally { await deleteAllJobs(name); await boss.deleteQueue(name) }
  }

  it("policy 'singleton' does NOT dedupe two queued sends with the same key", () =>
    withQueue('singleton', async (name) => {
      expect(await boss.send(name, {}, { singletonKey: 'a' })).not.toBeNull()
      expect(await boss.send(name, {}, { singletonKey: 'a' })).not.toBeNull()
    }))

  it("policy 'stately' dedupes a queued duplicate while the first is still created", () =>
    withQueue('stately', async (name) => {
      expect(await boss.send(name, {}, { singletonKey: 'a' })).not.toBeNull()
      expect(await boss.send(name, {}, { singletonKey: 'a' })).toBeNull()
    }))

  it("policy 'stately' ACCEPTS a new send while a job with the same key is ACTIVE (so it is not a mutex)", () =>
    withQueue('stately', async (name) => {
      const first = await boss.send(name, {}, { singletonKey: 'a' })
      if (!first) throw new Error('send returned null')
      const fetched = await boss.fetch(name)          // moves it to active
      expect(fetched?.[0]?.id).toBe(first)
      const second = await boss.send(name, {}, { singletonKey: 'a' })
      // Pinned observation (pg-boss 10.4.x indexes one job PER STATE): a created twin is accepted next to an active one.
      expect(second).not.toBeNull()
    }))

  it("'singletonSeconds' debounces bursts on a standard queue", () =>
    withQueue('standard', async (name) => {
      expect(await boss.send(name, {}, { singletonSeconds: 10 })).not.toBeNull()
      expect(await boss.send(name, {}, { singletonSeconds: 10 })).toBeNull()
    }))
})
