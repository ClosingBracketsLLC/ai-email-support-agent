import { loadKekRing, type KekRing } from '@aesa/crypto'
import { z } from 'zod'
import { parseWorkerRoles, type WorkerRole } from './roles.ts'

const EnvSchema = z.object({ DATABASE_URL: z.string().min(1), WORKER_ROLES: z.string().optional(), LOG_LEVEL: z.string().default('info') })

export interface WorkerConfig { databaseUrl: string; roles: Set<WorkerRole>; kekRing: KekRing | null; logLevel: string }

export function loadConfig(env: NodeJS.ProcessEnv): WorkerConfig {
  const parsed = EnvSchema.safeParse(env)
  if (!parsed.success) throw new Error(`Invalid environment: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
  const hasKek = Object.keys(env).some((k) => /^AESA_KEK_V\d+$/.test(k))
  return {
    databaseUrl: parsed.data.DATABASE_URL,
    roles: parseWorkerRoles(parsed.data.WORKER_ROLES),
    kekRing: hasKek ? loadKekRing(env as Record<string, string | undefined>) : null,   // required from Phase 2 (mailbox credentials)
    logLevel: parsed.data.LOG_LEVEL,
  }
}
