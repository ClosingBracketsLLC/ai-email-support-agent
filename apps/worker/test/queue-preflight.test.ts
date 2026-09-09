/**
 * `index.ts` calls `createQueueRetrying` for `JOB_NAMES.notifyDispatch`/`ticketTriage`/`mailboxSync`
 * unconditionally at boot, before any role-gated `registerJob` call — because pg-boss 10's `insertJob`
 * SQL INNER JOINs a new job against the queue table and silently returns a `null` id (no error) when
 * the named queue doesn't exist yet (fix review, Important 2: a role-partitioned replica, or a dev box
 * missing ANTHROPIC_API_KEY/the KEK ring/MAIL_FROM, would otherwise never create these queues itself,
 * and mailbox.poll-sweep's (a)/(d)/(e) enqueue into them regardless). This proves the fix directly: a
 * boss with the three queues pre-created but NO job registered on any of them still returns a real id.
 */
import type PgBoss from 'pg-boss'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createQueueRetrying, defineJob, enqueue, JOB_NAMES } from '@aesa/queue'
import { deleteJobsForOrgs, startTestBoss } from './helpers/boss.ts'

describe('worker boot: pre-created queues accept sends with no registrations', () => {
  it.each([JOB_NAMES.notifyDispatch, JOB_NAMES.ticketTriage, JOB_NAMES.mailboxSync])('enqueue(%s) returns a non-null id once the queue is pre-created, before any registerJob call', async (name) => {
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
