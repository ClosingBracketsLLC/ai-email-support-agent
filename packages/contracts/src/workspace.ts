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

export const UpdateGuidanceInput = z.object({ operatingGuidance: z.string().trim().max(8000) })
export type UpdateGuidanceInput = z.infer<typeof UpdateGuidanceInput>

/** Base for the Better Auth organization slug; the api appends a random suffix and retries on collision. */
export function slugify(name: string): string {
  const base = name
    .normalize('NFKD').replace(/\p{M}/gu, '')   // strip combining marks: Café → Cafe
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 40).replace(/-+$/, '')
  return base || 'workspace'
}
