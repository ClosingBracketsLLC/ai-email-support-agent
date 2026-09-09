/**
 * Matches a genuine `dmarc=pass` method token — preceded by the start of the header, a `;`
 * clause separator, or whitespace, and terminated by a word boundary. This is what stops a
 * `smtp.mailfrom=dmarc=pass@evil.example` forgery buried inside another method's params from
 * being read as a passing DMARC verdict: the character immediately before that `dmarc=pass`
 * substring is `=`, not a clause boundary, so it never matches. Ported from doge-buddy's
 * `dmarcPasses` (apps/ops/src/support/validator.ts).
 */
const DMARC_PASS_RE = /(?:^|;|\s)dmarc=pass\b/i

export interface AuthResults {
  raw: string | null
  dmarcPass: boolean
}

/** Parses the topmost `Authentication-Results` header. Missing header, dmarc=fail, dmarc=none
 * and dmarc=bestguesspass are all non-pass. */
export function parseAuthResults(header: string | null): AuthResults {
  return {
    raw: header,
    dmarcPass: header !== null && DMARC_PASS_RE.test(header),
  }
}

export interface AutomationHeaders {
  autoSubmitted: string | null
  precedence: string | null
  listId: string | null
}

const BULK_PRECEDENCE = new Set(['bulk', 'list', 'junk'])

/**
 * True when the message carries any of the standard automated-mail signals: an `Auto-Submitted`
 * header present and not `no`, a `Precedence` of bulk/list/junk, or a `List-Id` header at all.
 */
export function detectAutomated(h: AutomationHeaders): boolean {
  if (h.autoSubmitted !== null && h.autoSubmitted.trim().toLowerCase() !== 'no') return true
  if (h.precedence !== null && BULK_PRECEDENCE.has(h.precedence.trim().toLowerCase())) return true
  if (h.listId !== null) return true
  return false
}
