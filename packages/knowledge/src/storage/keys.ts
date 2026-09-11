import { z } from 'zod'

/** Where an upload's bytes live in the bucket. */
export function uploadKey(orgId: string, sourceId: string, fileName: string): string {
  return `orgs/${orgId}/uploads/${sourceId}/${fileName}`
}

export interface S3Config {
  endpoint: string
  region: string
  bucket: string
  accessKeyId: string
  /** Raw string here — the apps' own `loadConfig` wraps it in a `Secret` before it reaches
   * `createS3Store`; this package has no reason to hold a `Secret` it never logs itself. */
  secretAccessKey: string
  forcePathStyle: boolean
}

const S3_ENV_KEYS = ['S3_ENDPOINT', 'S3_REGION', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'S3_FORCE_PATH_STYLE'] as const

const RawS3Env = z.object({
  S3_ENDPOINT: z.string().min(1),
  S3_REGION: z.string().min(1),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_FORCE_PATH_STYLE: z.string().min(1),
})

/** All six `S3_*` variables are all-or-none: `null` when every one is absent (object storage is
 * simply not configured — dev without minio, or a role that never touches it), throws when only
 * some are set (a half-configured deploy), parses the six raw names into `S3Config` otherwise.
 * Shared by both apps so the api's connect flow and the worker's `createS3Store` read identical
 * config from identical env names. */
export function parseS3Env(env: Record<string, string | undefined>): S3Config | null {
  const present = S3_ENV_KEYS.filter((key) => env[key] !== undefined && env[key] !== '')
  if (present.length === 0) return null
  if (present.length < S3_ENV_KEYS.length) throw new Error('S3_* variables are all-or-none')

  const raw = RawS3Env.parse(Object.fromEntries(S3_ENV_KEYS.map((key) => [key, env[key]])))
  return {
    endpoint: raw.S3_ENDPOINT,
    region: raw.S3_REGION,
    bucket: raw.S3_BUCKET,
    accessKeyId: raw.S3_ACCESS_KEY_ID,
    secretAccessKey: raw.S3_SECRET_ACCESS_KEY,
    forcePathStyle: raw.S3_FORCE_PATH_STYLE === 'true',
  }
}
