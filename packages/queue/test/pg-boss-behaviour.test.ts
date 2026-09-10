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
  async function withQueue(policy: 'singleton' | 'stately' | 'standard' | 'short', fn: (name: string) => Promise<void>) {
    const name = uniqueName(`test.${policy}`)
    await createQueueRetrying(boss, name, { name, policy })
    try { await fn(name) } finally { await deleteAllJobs(name); await boss.deleteQueue(name) }
  }

  // fix wave W8 (final-A1 M3): `enqueue()` ALWAYS sets a singletonKey and two producers reason from
  // a null return ("the job already exists"). pg-boss 10.4.2 gates its singleton unique indexes on
  // the queue's POLICY (plans.js: job_i1 `state='created' AND policy='short'`, job_i2
  // `state='active' AND policy='singleton'`, job_i3 `state<=active AND policy='stately'`), so on a
  // `standard` queue — `defineJob`'s default — no index applies and the key is INERT. These two
  // cases pin both halves: the inertness that was assumed away, and the policy that fixes it.
  it("policy 'standard' does NOT dedupe two created sends with the same singletonKey (the key is inert)", () =>
    withQueue('standard', async (name) => {
      expect(await boss.send(name, {}, { singletonKey: 'a' })).not.toBeNull()
      expect(await boss.send(name, {}, { singletonKey: 'a' })).not.toBeNull()
    }))

  it("policy 'short' dedupes a duplicate while the first is still CREATED, and accepts one once it is active", () =>
    withQueue('short', async (name) => {
      const first = await boss.send(name, {}, { singletonKey: 'a' })
      expect(first).not.toBeNull()
      expect(await boss.send(name, {}, { singletonKey: 'a' })).toBeNull()
      // A different key on the same queue is never collapsed.
      expect(await boss.send(name, {}, { singletonKey: 'b' })).not.toBeNull()
      // Once the first is ACTIVE it no longer blocks a fresh one: the job that already read the
      // world must not swallow an event that arrived after it started.
      const fetched = await boss.fetch(name)
      expect(fetched?.[0]?.id).toBe(first)
      expect(await boss.send(name, {}, { singletonKey: 'a' })).not.toBeNull()
    }))

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
