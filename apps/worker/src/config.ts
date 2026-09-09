import { loadKekRing, Secret, type KekRing } from '@aesa/crypto'
import { z } from 'zod'
import { parseWorkerRoles, type WorkerRole } from './roles.ts'

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().min(1),
  WORKER_ROLES: z.string().optional(),
  LOG_LEVEL: z.string().default('info'),
  // Optional here: registration (apps/worker/src/index.ts) is what enforces it's required in
  // production when the `agent` role is active — a missing key must never crash config loading
  // itself, only job registration, so local dev without a key still boots on every other role.
  ANTHROPIC_API_KEY: z.string().optional(),
})

export interface WorkerConfig {
  env: 'development' | 'test' | 'production'
  databaseUrl: string
  roles: Set<WorkerRole>
  kekRing: KekRing | null
  logLevel: string
  anthropicApiKey: Secret | null
}

export function loadConfig(env: NodeJS.ProcessEnv): WorkerConfig {
  const parsed = EnvSchema.safeParse(env)
  if (!parsed.success) throw new Error(`Invalid environment: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
  // A *present but blank* AESA_KEK_V1 is the shipped .env.example shape; loadKekRing skips blanks and
  // then throws on AESA_KEK_ACTIVE, so presence alone must not claim a ring.
  const hasKek = Object.entries(env).some(([k, v]) => /^AESA_KEK_V\d+$/.test(k) && Boolean(v))
  return {
    env: parsed.data.NODE_ENV,
    databaseUrl: parsed.data.DATABASE_URL,
    roles: parseWorkerRoles(parsed.data.WORKER_ROLES),
    kekRing: hasKek ? loadKekRing(env as Record<string, string | undefined>) : null,   // required from Phase 2 (mailbox credentials)
    logLevel: parsed.data.LOG_LEVEL,
    anthropicApiKey: parsed.data.ANTHROPIC_API_KEY ? new Secret(parsed.data.ANTHROPIC_API_KEY) : null,
  }
}
