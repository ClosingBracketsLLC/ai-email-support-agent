import { z } from 'zod'

export const TONES = ['friendly', 'formal', 'concise'] as const
export type Tone = (typeof TONES)[number]

const isHttpUrl = (v: string) => { try { return ['http:', 'https:'].includes(new URL(v).protocol) } catch { return false } }
export const HttpUrl = z.string().trim().max(2048).refine(isHttpUrl, { message: 'must be an http(s) URL' })

/** `HttpUrl` narrowed to `https:` — for the inputs where plain http is never acceptable (the
 * crawler only ever fetches https, `normalizeUrl` drops an http URL outright). Kept next to
 * `HttpUrl` so the two messages stay a matched pair. */
const isHttpsUrl = (v: string) => { try { return new URL(v).protocol === 'https:' } catch { return false } }
export const HttpsUrl = z.string().trim().max(2048).refine(isHttpsUrl, { message: 'must be an https:// URL' })

export const CreateWorkspaceInput = z.object({
  businessName: z.string().trim().min(1).max(120),
  /** IANA zone from the device; the api validates it against Intl.supportedValuesOf('timeZone'). */
  timezone: z.string().trim().min(1).max(64),
})
export type CreateWorkspaceInput = z.infer<typeof CreateWorkspaceInput>

export const SetAgentEnabledInput = z.object({ enabled: z.boolean() })
export type SetAgentEnabledInput = z.infer<typeof SetAgentEnabledInput>

export const UpdateProfileInput = z.object({
  websiteUrl: HttpUrl.nullable(),
  description: z.string().trim().max(500),
  tone: z.enum(TONES),
  contactPhone: z.string().trim().min(3).max(40).nullable(),
  contactUrls: z.array(HttpUrl).max(10),
})
export type UpdateProfileInput = z.infer<typeof UpdateProfileInput>

/** The guardrail allowlist shown as "Replies may link only to …": hostnames of the website and contact URLs. */
export function deriveAllowedHosts(websiteUrl: string | null, contactUrls: readonly string[]): string[] {
  const hosts = new Set<string>()
  for (const raw of [websiteUrl, ...contactUrls]) {
    if (!raw) continue
    try { hosts.add(new URL(raw).hostname.toLowerCase().replace(/^www\./, '')) } catch { /* validated by HttpUrl upstream */ }
  }
  return [...hosts]
}

export const OPERATING_GUIDANCE_MAX = 8000
export const UpdateGuidanceInput = z.object({ operatingGuidance: z.string().trim().max(OPERATING_GUIDANCE_MAX) })
export type UpdateGuidanceInput = z.infer<typeof UpdateGuidanceInput>

export const SetKillSwitchInput = z.object({ on: z.boolean() })
export type SetKillSwitchInput = z.infer<typeof SetKillSwitchInput>

export const RETENTION_DAYS_MIN = 30
export const RETENTION_DAYS_MAX = 730
export const SetRetentionDaysInput = z.object({ retentionDays: z.number().int().min(RETENTION_DAYS_MIN).max(RETENTION_DAYS_MAX) })
export type SetRetentionDaysInput = z.infer<typeof SetRetentionDaysInput>

/** Must equal the business name exactly — the service checks that, not this schema. */
export const RequestDeletionInput = z.object({ confirm: z.string().trim().min(1).max(120) })
export type RequestDeletionInput = z.infer<typeof RequestDeletionInput>

/** Days a deleted workspace's data is retained before `workspace.purge` runs it for real. */
export const WORKSPACE_DELETE_GRACE_DAYS = 30

export const EXPORT_STATES = ['none', 'queued', 'ready', 'failed'] as const
export type ExportState = (typeof EXPORT_STATES)[number]

/**
 * Where a workspace's data export lives in the object store. It lives HERE, in contracts, because
 * two processes have to agree on it exactly: the api mints it into `workspaces.export_key` when it
 * queues the export, and the worker's `workspace.export` job refuses any row whose stored key is not
 * this exact string for the export id on its payload. Deriving it independently on either side is
 * the drift this function exists to make impossible.
 */
export function exportObjectKey(orgId: string, exportId: string): string {
  return `orgs/${orgId}/exports/${exportId}.ndjson`
}

export const WORKSPACE_ERROR_MESSAGES = {
  confirm_mismatch: 'Type the workspace name exactly to confirm.',
  deletion_pending: 'Deletion is already scheduled.',
  /** The mirror of `deletion_pending`: Cancel arriving at a workspace that is not scheduled — a
   *  second tap, or the purge having already claimed it. */
  not_pending: 'This workspace is not scheduled for deletion.',
  export_in_progress: 'An export is already running.',
  billing_cancel_failed: 'Could not cancel the subscription — deletion was not scheduled.',
} as const
export type WorkspaceErrorKey = keyof typeof WORKSPACE_ERROR_MESSAGES

/** Base for the Better Auth organization slug; the api appends a random suffix and retries on collision. */
export function slugify(name: string): string {
  const base = name
    .normalize('NFKD').replace(/\p{M}/gu, '')   // strip combining marks: Café → Cafe
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 40).replace(/-+$/, '')
  return base || 'workspace'
}
