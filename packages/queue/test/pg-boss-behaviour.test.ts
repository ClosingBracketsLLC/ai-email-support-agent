import type PgBoss from 'pg-boss'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createQueueRetrying } from '../src/pg-boss.ts'
import { startTestBoss, uniqueName } from './helpers/boss.ts'

describe('pg-boss 10 behaviour we rely on', () => {
  let boss: PgBoss
  beforeAll(async () => { boss = await startTestBoss() })
  afterAll(async () => { await boss.stop({ graceful: false, wait: true }) })

  async function withQueue(policy: 'singleton' | 'stately' | 'standard', fn: (name: string) => Promise<void>) {
    const name = uniqueName(`test.${policy}`)
    await createQueueRetrying(boss, name, { name, policy })
    try { await fn(name) } finally { await boss.purgeQueue(name); await boss.deleteQueue(name) }
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
      const fetched = await boss.fetch(name)          // moves it to active
      expect(fetched?.[0]?.id).toBe(first)
      const second = await boss.send(name, {}, { singletonKey: 'a' })
      // Pinned observation (pg-boss 10.4.x indexes one job PER STATE): a created twin is accepted next to an active one.
      expect(second).not.toBeNull()
      // `first` is left ACTIVE (never completed/failed) by design of this test. `withQueue`'s
      // cleanup below does `purgeQueue` (which only removes state < active, i.e. created/retry)
      // then `deleteQueue` (which fails on a foreign-key violation while ANY job row for this
      // queue still exists, active included). `deleteJob` removes a job unconditionally of its
      // state, so clear the active job explicitly here; `second` is left in 'created' state and
      // is swept by the ordinary `purgeQueue` call.
      await boss.deleteJob(name, first as string)
    }))

  it("'singletonSeconds' debounces bursts on a standard queue", () =>
    withQueue('standard', async (name) => {
      expect(await boss.send(name, {}, { singletonSeconds: 10 })).not.toBeNull()
      expect(await boss.send(name, {}, { singletonSeconds: 10 })).toBeNull()
    }))
})
