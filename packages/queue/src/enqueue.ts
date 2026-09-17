import type PgBoss from 'pg-boss'
import type { JobDefinition } from './define-job.ts'

export interface EnqueueOptions {
  /** The entity this job is about (ticket id, connection id…). singletonKey becomes `${orgId}:${entityId}`. */
  entityId: string
  startAfter?: Date | number
  priority?: number
  /** For push-triggered jobs: collapse a burst to ONE job per N-second wall-clock slot WITHOUT losing
   *  its last event — pg-boss's debounce (`singletonSeconds` + `singletonNextSlot`), not its throttle.
   *  When the slot is taken (by a job that may already have COMPLETED — pg-boss's slot index excludes
   *  only `cancelled`), the job is inserted for the NEXT slot with `startAfter` at its boundary; only
   *  a send that finds the next slot taken too returns null, and that pending job runs after this
   *  send's cause was committed. `singletonSeconds` alone DROPPED the second send, which left a
   *  customer follow-up landing in the same slot as the ticket's previous triage enqueue untriaged
   *  until `mailbox.poll-sweep` (d) rescued it ten minutes later (PR #9). */
  debounceSeconds?: number
}

/** The only way jobs are sent. Validates the payload (orgId required) and always sets an org-scoped singletonKey. */
export async function enqueue<T extends { orgId: string }>(boss: PgBoss, def: JobDefinition<T>, data: T, opts: EnqueueOptions): Promise<string | null> {
  const parsed = def.schema.parse(data)
  const sendOpts: PgBoss.SendOptions = { singletonKey: `${parsed.orgId}:${opts.entityId}` }
  if (opts.startAfter !== undefined) sendOpts.startAfter = opts.startAfter
  if (opts.priority !== undefined) sendOpts.priority = opts.priority
  if (opts.debounceSeconds !== undefined) {
    sendOpts.singletonSeconds = opts.debounceSeconds
    sendOpts.singletonNextSlot = true
  }
  return boss.send(def.name, parsed, sendOpts)
}
