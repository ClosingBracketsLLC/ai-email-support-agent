/**
 * A single top-level `Authentication-Results` method clause's opening `dmarc=<result>` token. The
 * lookahead `(?=$|\s|\()` requires the result word to be TERMINATED by whitespace, an opening
 * paren (the params group), or the clause end — which is exactly what distinguishes a genuine
 * `dmarc=pass` method from an attacker-forged look-alike buried in a param value. See
 * `parseAuthResults` for the full mechanism. Ported from doge-buddy's `DMARC_METHOD_RE`
 * (apps/ops/src/support/validator.ts).
 */
const DMARC_METHOD_RE = /^dmarc\s*=\s*(\w+)(?=$|\s|\()/i

export interface AuthResults {
  raw: string | null
  dmarcPass: boolean
}

/**
 * Parses the topmost `Authentication-Results` header, per doge-buddy's `dmarcPasses`.
 *
 * WHY a parser and not a substring test: the header value is attacker-INFLUENCEABLE.
 * `Authentication-Results` is `<authserv-id>; method=result params; method=result params; ...` —
 * methods are `;`-separated, and the params inside a method (e.g. `smtp.mailfrom=...` inside the
 * spf method) are space-separated. An attacker sending `MAIL FROM: dmarc=pass@evil.example`
 * (From: a victim under `p=none`) makes Gmail stamp `...spf=... smtp.mailfrom=dmarc=pass@evil.example;
 * dmarc=fail (p=NONE)...` — a naive `\bdmarc=pass\b` substring test then matches the mailfrom
 * param and waves through a message Gmail itself stamped dmarc=FAIL.
 *
 * Mechanism: split on `;`, trim each clause, and read the result only from a clause that BEGINS
 * with a real `dmarc=<result>` method token (`DMARC_METHOD_RE`). A `smtp.mailfrom=dmarc=pass@evil`
 * fragment never begins a clause (it sits after `smtp.mailfrom=` inside the spf clause), so it is
 * never read as dmarc. A quoted-local-part forgery `smtp.mailfrom="x;dmarc=pass"@evil` splits out a
 * `dmarc=pass"@evil...` fragment, but the `"` immediately after `pass` is not a valid method
 * terminator (the lookahead rejects it), so that fragment is not read as dmarc either. When more
 * than one clause matches (only reachable via injection), the LAST wins — Gmail appends the real
 * dmarc verdict as the FINAL method, after the dkim/spf clauses any mailfrom forgery lands in.
 * Missing header, dmarc=fail, dmarc=none and dmarc=bestguesspass are all non-pass.
 */
export function parseAuthResults(header: string | null): AuthResults {
  if (header === null) return { raw: header, dmarcPass: false }

  let result: string | null = null
  for (const clause of header.split(';')) {
    const m = DMARC_METHOD_RE.exec(clause.trim())
    if (m) result = m[1]!.toLowerCase()
  }
  return { raw: header, dmarcPass: result === 'pass' }
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
