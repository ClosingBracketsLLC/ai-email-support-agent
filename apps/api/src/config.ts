import { z } from 'zod'

const isHttpUrl = (v: string) => { try { return ['http:', 'https:'].includes(new URL(v).protocol) } catch { return false } }

const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  PORT: z.coerce.number().int().positive().default(3001),
  HOST: z.string().default('0.0.0.0'),
  APP_BASE_URL: z.string().refine(isHttpUrl, { message: 'APP_BASE_URL must be an http(s) URL' }).optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
})

export interface ApiConfig { databaseUrl: string; port: number; host: string; appBaseUrl?: string; logLevel: string }

export function loadConfig(env: NodeJS.ProcessEnv): ApiConfig {
  const kek = Object.keys(env).filter((k) => k.startsWith('AESA_KEK_'))
  if (kek.length) throw new Error(`api must not be configured with key material (${kek.join(', ')}); only the worker holds the KEK`)
  const parsed = EnvSchema.safeParse(env)
  if (!parsed.success) throw new Error(`Invalid environment: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
  const d = parsed.data
  return { databaseUrl: d.DATABASE_URL, port: d.PORT, host: d.HOST, logLevel: d.LOG_LEVEL, ...(d.APP_BASE_URL ? { appBaseUrl: d.APP_BASE_URL } : {}) }
}
