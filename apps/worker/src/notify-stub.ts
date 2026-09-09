import type PgBoss from 'pg-boss'
import { z } from 'zod'
import { defineJob, enqueue, JOB_NAMES } from '@aesa/queue'

/**
 * Task 16 registers `notify.dispatch`'s real `JobDefinition` and handler. Until then, every job that
 * needs to fan a notification row out to the push pipeline (ticket.triage's escalations, mailbox.sync's
 * tripwire/reauth notices, mailbox.poll-sweep's stuck-pending retry) enqueues through this minimal
 * stand-in. `enqueue()` only ever reads `.name`/`.schema` off a `JobDefinition` — never `.handler` — so a
 * throwing placeholder handler here is safe: nothing calls it before Task 16 replaces this file's export
 * with the real one.
 *
 * `index.ts` calls `createQueueRetrying(boss, JOB_NAMES.notifyDispatch)` unconditionally at boot
 * (regardless of role) so a send through this stub never silently no-ops: pg-boss 10's `insertJob` SQL
 * INNER JOINs the new job against the `queue` table and returns zero rows — no error, just a `null`
 * job id — when the named queue does not exist yet. See the Task 15 report for the verification.
 */
const notifyDispatchStub = defineJob({
  name: JOB_NAMES.notifyDispatch,
  schema: z.object({ orgId: z.string(), notificationId: z.string() }),
  queue: { expireInSeconds: 60 },
  handler: async () => {
    throw new Error('notify.dispatch: registered by Task 16 — this stand-in is enqueue-only and must never run')
  },
})

export async function enqueueNotifyDispatch(boss: PgBoss, orgId: string, notificationId: string): Promise<void> {
  await enqueue(boss, notifyDispatchStub, { orgId, notificationId }, { entityId: notificationId })
}
