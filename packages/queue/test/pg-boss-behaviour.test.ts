import type PgBoss from 'pg-boss'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { JobDefinition } from '../src/define-job.ts'
import { enqueue } from '../src/enqueue.ts'
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

  // `singletonSeconds` ALONE is pg-boss's THROTTLE (`sendThrottled`): one job per wall-clock-aligned
  // slot, every further send in that slot DROPPED — and job_i4 excludes only `cancelled`, so a job
  // that already COMPLETED in the slot still blocks a new one. That is what `enqueue`'s
  // `debounceSeconds` inherited until PR #9: a customer follow-up landing in the same 10 s slot as
  // the ticket's previous triage enqueue was silently dropped (the Phase 7 E2E's R26 follow-up,
  // 2 of 3 CI runs), and only `mailbox.poll-sweep` (d) rescued it, ten minutes later.
  it("'singletonSeconds' alone THROTTLES a burst on a standard queue — the second send in the slot is dropped", () =>
    withQueue('standard', async (name) => {
      await waitForSlotStart(10)
      expect(await boss.send(name, {}, { singletonSeconds: 10 })).not.toBeNull()
      expect(await boss.send(name, {}, { singletonSeconds: 10 })).toBeNull()
    }), 20_000)

  // `enqueue`'s `debounceSeconds` is a DEBOUNCE (`sendDebounced`: `singletonSeconds` +
  // `singletonNextSlot`): a burst collapses to one job per slot, but the last event is never lost —
  // when the slot is taken, the job is inserted for the NEXT slot with `startAfter` at its boundary,
  // and only a send that finds the next slot taken too returns null (one is already pending, and it
  // will run after this send's cause was committed).
  it("enqueue's debounceSeconds DEBOUNCES: the second send in a slot lands in the next slot, the third finds it pending", () =>
    withQueue('standard', async (name) => {
      const def = { name, schema: z.object({ orgId: z.string() }) } as unknown as JobDefinition<{ orgId: string }>
      await waitForSlotStart(10)
      const first = await enqueue(boss, def, { orgId: 'o' }, { entityId: 'e', debounceSeconds: 10 })
      expect(first).not.toBeNull()
      const second = await enqueue(boss, def, { orgId: 'o' }, { entityId: 'e', debounceSeconds: 10 })
      expect(second).not.toBeNull()
      expect(second).not.toBe(first)
      const row = await boss.getJobById(name, second!)
      // Scheduled past the next slot boundary: pg-boss's `getDebounceStartAfter` is
      // `(N − secondsIntoSlot) + 1` seconds — the boundary plus a one-second guard — so 2 to N+1 s.
      const delayMs = row!.startAfter.getTime() - row!.createdOn.getTime()
      expect(delayMs).toBeGreaterThan(1_000)
      expect(delayMs).toBeLessThanOrEqual(11_500)
      expect(await enqueue(boss, def, { orgId: 'o' }, { entityId: 'e', debounceSeconds: 10 })).toBeNull()
    }), 20_000)
})

/** Park the test at the START of a `seconds`-wide wall-clock slot (≤ 1.5 s in), so the sends
 *  below cannot straddle a boundary and the "same slot" premise holds for the whole case. */
async function waitForSlotStart(seconds: number): Promise<void> {
  const slotMs = seconds * 1000
  const into = Date.now() % slotMs
  if (into > 1_500) await new Promise((r) => setTimeout(r, slotMs - into + 50))
}
