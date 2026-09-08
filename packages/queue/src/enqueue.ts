import type PgBoss from 'pg-boss'
import type { JobDefinition } from './define-job.ts'

export interface EnqueueOptions {
  /** The entity this job is about (ticket id, connection id…). singletonKey becomes `${orgId}:${entityId}`. */
  entityId: string
  startAfter?: Date | number
  priority?: number
  /** For push-triggered jobs: collapse bursts within N seconds (pg-boss singletonSeconds) instead of relying on policy. */
  debounceSeconds?: number
}

/** The only way jobs are sent. Validates the payload (orgId required) and always sets an org-scoped singletonKey. */
export async function enqueue<T extends { orgId: string }>(boss: PgBoss, def: JobDefinition<T>, data: T, opts: EnqueueOptions): Promise<string | null> {
  const parsed = def.schema.parse(data)
  const sendOpts: PgBoss.SendOptions = { singletonKey: `${parsed.orgId}:${opts.entityId}` }
  if (opts.startAfter !== undefined) sendOpts.startAfter = opts.startAfter
  if (opts.priority !== undefined) sendOpts.priority = opts.priority
  if (opts.debounceSeconds !== undefined) sendOpts.singletonSeconds = opts.debounceSeconds
  return boss.send(def.name, parsed, sendOpts)
}
