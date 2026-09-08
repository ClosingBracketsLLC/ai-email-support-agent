import { loadKekRing, type KekRing } from '@aesa/crypto'
import { z } from 'zod'
import { parseWorkerRoles, type WorkerRole } from './roles.ts'

const EnvSchema = z.object({ DATABASE_URL: z.string().min(1), WORKER_ROLES: z.string().optional(), LOG_LEVEL: z.string().default('info') })

export interface WorkerConfig { databaseUrl: string; roles: Set<WorkerRole>; kekRing: KekRing | null; logLevel: string }

export function loadConfig(env: NodeJS.ProcessEnv): WorkerConfig {
  const parsed = EnvSchema.safeParse(env)
  if (!parsed.success) throw new Error(`Invalid environment: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
  // A *present but blank* AESA_KEK_V1 is the shipped .env.example shape; loadKekRing skips blanks and
  // then throws on AESA_KEK_ACTIVE, so presence alone must not claim a ring.
  const hasKek = Object.entries(env).some(([k, v]) => /^AESA_KEK_V\d+$/.test(k) && Boolean(v))
  return {
    databaseUrl: parsed.data.DATABASE_URL,
    roles: parseWorkerRoles(parsed.data.WORKER_ROLES),
    kekRing: hasKek ? loadKekRing(env as Record<string, string | undefined>) : null,   // required from Phase 2 (mailbox credentials)
    logLevel: parsed.data.LOG_LEVEL,
  }
}
