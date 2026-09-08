export const WORKER_ROLES = ['sync', 'agent', 'send', 'knowledge', 'cron'] as const
export type WorkerRole = (typeof WORKER_ROLES)[number]

/** WORKER_ROLES partitions one image into role-specific replicas so a knowledge burst can never starve sends. */
export function parseWorkerRoles(value: string | undefined): Set<WorkerRole> {
  if (!value || !value.trim()) return new Set(WORKER_ROLES)
  const roles = new Set<WorkerRole>()
  for (const raw of value.split(',')) {
    const r = raw.trim()
    if (!r) continue
    if (!(WORKER_ROLES as readonly string[]).includes(r)) throw new Error(`unknown worker role: ${r}`)
    roles.add(r as WorkerRole)
  }
  return roles
}
