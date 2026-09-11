import { DRAFT_BODY_MAX } from '@aesa/contracts'
import { extractNumberTokens } from './validator.ts'

export interface WorkspacePolicy {
  /** Exact hostnames, lowercased. The worker builds it from workspaces.allowed_url_hosts (each
   * host AND its `www.` twin) plus the agent's own domain. No implicit subdomains. */
  allowedHostnames: string[]
  /** Suffix-matched, lowercased (`@` + domain). From workspaces.allowed_email_domains plus the
   * agent address's domain. */
  allowedEmailDomains: string[]
  /** Digit strings (separators stripped). From workspaces.contact_phone. Matched by digit
   * equality BEFORE the phone screen fails. */
  allowedPhoneNumbers: string[]
  /** Byte-equal exemptions (the reference's `trackingUrl` precedent). From workspaces.contact_urls. */
  allowedExactUrls: string[]
  maxChars: number
  /** ISO 639-1; drives the standalone-digit-run phone shape. 'en' today. */
  locale: string
  /** ISO 639-1 the customer wrote in (tickets.language); a reply in another language is a WARNING.
   * null = unknown, no check. */
  expectedLanguage: string | null
  /** Platform hard rules, persona text, workspace guidance, agent guidance — the leak screen's
   * sources. */
  trustedTexts: string[]
}

export interface PolicySource {
  allowedUrlHosts: string[]
  allowedEmailDomains: string[]
  contactPhone: string | null
  contactUrls: string[]
  locale: string
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)]
}

/** Shared by the worker (draft + send gates) and the api (approve gate) so the three gates screen
 * against ONE policy. */
export function buildWorkspacePolicy(p: {
  workspace: PolicySource
  agentDomain: string
  trustedTexts: string[]
  expectedLanguage: string | null
}): WorkspacePolicy {
  const agentDomain = p.agentDomain.toLowerCase()
  const allowedHostnames = dedupe([
    ...p.workspace.allowedUrlHosts.flatMap((h) => [h.toLowerCase(), `www.${h.toLowerCase()}`]),
    agentDomain,
    `www.${agentDomain}`,
  ])
  const allowedEmailDomains = dedupe([...p.workspace.allowedEmailDomains.map((d) => d.toLowerCase()), agentDomain])
  const allowedPhoneNumbers = p.workspace.contactPhone !== null ? [p.workspace.contactPhone.replace(/\D/g, '')] : []

  return {
    allowedHostnames,
    allowedEmailDomains,
    allowedPhoneNumbers,
    allowedExactUrls: p.workspace.contactUrls,
    maxChars: DRAFT_BODY_MAX,
    locale: p.workspace.locale,
    expectedLanguage: p.expectedLanguage,
    trustedTexts: p.trustedTexts,
  }
}

/** `extractNumberTokens` over every source, deduped — builds `ValidateOptions.groundedNumbers`
 * from the thread + profile + guidance + retrieved knowledge. */
export function collectGroundedNumbers(sources: readonly string[]): string[] {
  const tokens = new Set<string>()
  for (const source of sources) {
    for (const token of extractNumberTokens(source)) tokens.add(token)
  }
  return [...tokens]
}
