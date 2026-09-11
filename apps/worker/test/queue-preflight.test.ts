/**
 * `index.ts` calls `createQueueRetrying` for `JOB_NAMES.notifyDispatch`/`ticketTriage`/`ticketDraft`/
 * `agentSandbox`/`mailboxSync` unconditionally at boot, before any role-gated `registerJob` call —
 * because pg-boss 10's `insertJob` SQL INNER JOINs a new job against the queue table and silently
 * returns a `null` id (no error) when the named queue doesn't exist yet (fix review, Important 2: a
 * role-partitioned replica, or a dev box missing ANTHROPIC_API_KEY/the KEK ring/MAIL_FROM, would
 * otherwise never create these queues itself, and mailbox.poll-sweep's (a)/(d)/(e) and ticket.triage's
 * own hand-off enqueue into them regardless). This proves the fix directly: a boss with the queues
 * pre-created but NO job registered on any of them still returns a real id.
 */
import type PgBoss from 'pg-boss'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createQueueRetrying, defineJob, enqueue, JOB_NAMES } from '@aesa/queue'
import { deleteJobsForOrgs, startTestBoss } from './helpers/boss.ts'

describe('worker boot: pre-created queues accept sends with no registrations', () => {
  it.each([JOB_NAMES.notifyDispatch, JOB_NAMES.ticketTriage, JOB_NAMES.ticketDraft, JOB_NAMES.agentSandbox, JOB_NAMES.mailboxSync, JOB_NAMES.sendExecute])('enqueue(%s) returns a non-null id once the queue is pre-created, before any registerJob call', async (name) => {
    const boss: PgBoss = await startTestBoss()
    const orgId = crypto.randomUUID()
    try {
      // Mirrors index.ts's boot-time call exactly — no registerJob/registerCron for this name at all.
      await createQueueRetrying(boss, name)

      const def = defineJob({
        name,
        schema: z.object({ orgId: z.string() }),
        queue: { expireInSeconds: 60 },
        handler: async () => { throw new Error('never registered — must not run') },
      })
      const jobId = await enqueue(boss, def, { orgId }, { entityId: 'entity-1' })

      expect(jobId).not.toBeNull()
      expect(typeof jobId).toBe('string')
    } finally {
      await deleteJobsForOrgs(name, [orgId])
      await boss.stop({ graceful: false, wait: true })
    }
  })

  /** Phase 3 carry: a queue first created by an api-only boot stayed `standard` (pre-creation passed no
   *  options) until a worker replica ran `updateQueue`, so `enqueue`'s singletonKey was inert until then.
   *  This pins the CONTRACT — `createQueueRetrying(boss, name, { policy: 'short' })` actually sticks the
   *  policy on the queue row — on THROWAWAY names. It must not touch the real `ticket.draft`/
   *  `send.execute`/`agent.sandbox`/`notify.dispatch` queue rows: `pgboss_test` is shared and other
   *  worker suites use those queues concurrently, and deleting/recreating one mid-run would break them.
   *  The real four names carrying `{ policy: 'short' }` at boot is proven by reading index.ts's and
   *  boss.ts's pre-create lists directly — there is no cheaper runtime assertion than that. */
  it.each([JOB_NAMES.ticketDraft, JOB_NAMES.sendExecute, JOB_NAMES.agentSandbox, JOB_NAMES.notifyDispatch])('pre-creating %s carries policy short', async (name) => {
    const boss: PgBoss = await startTestBoss()
    const queueName = `preflight-policy-${name}-${crypto.randomUUID().slice(0, 8)}`
    try {
      // `name` here is redundant with the positional arg — pg-boss's own `PgBoss.Queue` type requires
      // it, but `manager.js`'s `createQueue` ignores it at runtime — it's here only to satisfy the type.
      await createQueueRetrying(boss, queueName, { name: queueName, policy: 'short' })
      const queue = await boss.getQueue(queueName)
      expect(queue?.policy).toBe('short')
    } finally {
      try { await boss.deleteQueue(queueName) } catch { /* best-effort cleanup of this test's own throwaway queue */ }
      await boss.stop({ graceful: false, wait: true })
    }
  })

  it('sanity check: WITHOUT createQueueRetrying, the exact same send silently returns null (the bug this fix prevents)', async () => {
    const boss: PgBoss = await startTestBoss()
    const orgId = crypto.randomUUID()
    const name = `preflight-unregistered-${crypto.randomUUID()}`
    try {
      const def = defineJob({
        name,
        schema: z.object({ orgId: z.string() }),
        queue: { expireInSeconds: 60 },
        handler: async () => { throw new Error('never registered — must not run') },
      })
      const jobId = await enqueue(boss, def, { orgId }, { entityId: 'entity-1' })

      expect(jobId).toBeNull()
    } finally {
      await boss.stop({ graceful: false, wait: true })
    }
  })
})
