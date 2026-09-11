/**
 * The eight guardrail screens over a normalized reply body. Regex tables in this file are ported
 * VERBATIM from doge-buddy's `apps/ops/src/support/validator.ts` (lines 75-487) — every token was
 * added or removed there for a documented false positive/negative; each carries a one-line note on
 * its origin. `secret_leak` and `trusted_text_leak` are new (not in the reference).
 */
import type { GuardrailFinding } from './validator.ts'
import type { WorkspacePolicy } from './policy.ts'
import { normalizeForShingles, wordShingles, TRUSTED_TEXT_SHINGLE_WORDS } from './shingles.ts'

interface Span {
  start: number
  end: number
}

function overlapsAnySpan(start: number, end: number, spans: Span[]): boolean {
  return spans.some((s) => start >= s.start && end <= s.end)
}

/** Resets `re`'s own `lastIndex` and collects every match span — safe because every caller passes
 * a fresh reset before reuse (single-threaded, synchronous). */
function findMatches(re: RegExp, text: string): Span[] {
  const out: Span[] = []
  re.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) out.push({ start: m.index, end: m.index + m[0].length })
  return out
}

// -- Plain text --

/** Any HTML-tag-looking opener (`<b`, `<!--`, `</p`), EXCEPT `<https://...>` / `<http://...>` — a
 * plain-text convention for delimiting a link, not HTML. */
const HTML_TAG_RE = /<(?!https?:\/\/)[a-z!/]/i

export function screenEmptyBody(body: string): GuardrailFinding | null {
  if (body.trim() !== '') return null
  return { code: 'empty_body', severity: 'fail', detail: 'reply body is empty after normalization' }
}

export function screenHtmlNotAllowed(body: string): GuardrailFinding | null {
  if (!HTML_TAG_RE.test(body)) return null
  return { code: 'html_not_allowed', severity: 'fail', detail: 'reply body contains an HTML tag' }
}

export function screenBodyTooLong(body: string, maxChars: number): GuardrailFinding | null {
  if (body.length <= maxChars) return null
  return { code: 'body_too_long', severity: 'fail', detail: `reply body is ${body.length} chars (max ${maxChars})` }
}

/** Default-ignorable code points (`\p{Cf}` and the non-`Cf` ones alike) are stripped before this
 * ever runs (not failed) — this only catches a remaining `\p{Cc}` control character other than the
 * three whitespace ones every plain-text body legitimately contains. */
export function screenInvisibleChars(body: string): GuardrailFinding | null {
  const re = /\p{Cc}/gu
  let m: RegExpExecArray | null
  while ((m = re.exec(body))) {
    if (m[0] === '\n' || m[0] === '\r' || m[0] === '\t') continue
    return { code: 'invisible_chars', severity: 'fail', detail: 'reply body contains an invisible control character' }
  }
  return null
}

// -- secret_leak screen (new) --

const SECRET_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /sk-[A-Za-z0-9_-]{16,}/, label: 'API-key-shaped token' },
  { re: /Bearer\s+[A-Za-z0-9._-]{16,}/i, label: 'bearer token' },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, label: 'PEM private key' },
  { re: /AKIA[0-9A-Z]{16}/, label: 'AWS access key id' },
  { re: /xox[baprs]-[A-Za-z0-9-]{10,}/, label: 'Slack token' },
  { re: /ghp_[A-Za-z0-9]{36}/, label: 'GitHub personal access token' },
]

export function screenSecretLeak(body: string): GuardrailFinding | null {
  for (const { re, label } of SECRET_PATTERNS) {
    if (re.test(body)) {
      return { code: 'secret_leak', severity: 'fail', detail: `reply body contains what looks like a ${label}` }
    }
  }
  return null
}

// -- Promised-action screen --

/** Verbs/nouns describing an ACTION that resolves the customer's issue — active and
 * passive/perfect phrasings, plus `coupon(s)`/`discount(s)`/`... code(s)`: a workspace that
 * declines refunds and offers a discount code instead has no tool that issues one, so claiming
 * one was sent is an unbacked promise exactly like a refund promise. Quoting a STANDING code
 * (e.g. "use code SORRY10") carries no promise token, so it still passes. */
const ACTION_RE =
  /refund(ed)?|reimburs\w*|credit(ed)?|store credit|money back|compensat\w*|replacement|reship\w*|resend|cancel\w* (your|the) order|order (has been|was|is) cancel\w*|replacement has (been )?shipped|payment (returned|reversed)|funds back|coupon(s)?|discount(s)?|(discount|promo|coupon) code(s)?/gi

/** Money-action verbs that make a gated auxiliary ("has been X", "we've X", "will be X") a real
 * promise — completed AND in-progress/imminent forms. */
const RESOLUTION_VERBS =
  'processed|process\\w*|issued|sent|approved|applied|refunded|reimburs\\w*|credited|cancel\\w*|reversed|complete\\w*|finali[sz]ed|posted|shipped|reflected|initiat\\w*|start\\w*|submit\\w*|authoriz\\w*|schedul\\w*|arrang\\w*|queued|releas\\w*|begun|emailed|mailed'

/** Words that PROMISE the action already happened or is imminent. `gone ahead and` (not bare
 * `i've`) and `funds back` living only in ACTION_RE (not dual-listed) are deliberate — see
 * doge-buddy's validator.ts doc comments for the false-positive history each token avoids. Vague
 * auxiliaries (`has been`, `we've`, `will be`, a bare `within N days`) are resolution-gated so a
 * policy explanation ("returns are accepted within 30 days") doesn't self-trigger. */
const PROMISE_RE = new RegExp(
  [
    'issued', 'processed', 'sent', 'approved', 'applied',
    'on its way', 'on the way', 'gone ahead and', 'is complete', 'has shipped',
    'expect (it|the funds|your (refund|money))',
    `(has|have|had) been (${RESOLUTION_VERBS})`,
    `will be (${RESOLUTION_VERBS})`,
    `(we have|we've) (${RESOLUTION_VERBS}|gone ahead)`,
    '(back|posted|credited|reflect\\w*|arriv\\w*|in your account) [^.]{0,25}within \\d+ (business )?days',
    'within \\d+ (business )?days [^.]{0,25}(back|posted|credited|reflect\\w*|arriv\\w*|in your account)',
  ].join('|'),
  'gi',
)

/** How close an ACTION token and a PROMISE token must be (whitespace-normalized chars) to count
 * as one promised-action hit. */
const PROMISE_PROXIMITY_CHARS = 200

function gapBetween(a: Span, b: Span): number {
  if (a.end <= b.start) return b.start - a.end
  if (b.end <= a.start) return a.start - b.end
  return 0
}

function hasPromisedActionHit(normalizedBody: string): boolean {
  const actions = findMatches(ACTION_RE, normalizedBody)
  if (actions.length === 0) return false
  const promises = findMatches(PROMISE_RE, normalizedBody)
  if (promises.length === 0) return false
  for (const a of actions) {
    for (const p of promises) {
      if (gapBetween(a, p) <= PROMISE_PROXIMITY_CHARS) return true
    }
  }
  return false
}

/** No sibling-refund exemption here (unlike the reference): a promise is always unbacked. */
export function screenPromisedAction(body: string): GuardrailFinding | null {
  const collapsed = body.replace(/\s+/g, ' ')
  if (!hasPromisedActionHit(collapsed)) return null
  return {
    code: 'promised_action',
    severity: 'fail',
    detail: 'reply body promises a resolved action with no refund attached to it',
  }
}

// -- URL / domain screen --

const SCHEMED_URL_RE = /https?:\/\/\S+/gi
const BARE_DOMAIN_RE = /\b[a-z0-9-]+(\.[a-z0-9-]+)+\b/gi
const PLAUSIBLE_TLDS = new Set([
  'com', 'net', 'org', 'io', 'co', 'shop', 'store', 'info', 'biz', 'us', 'uk', 'de', 'xyz', 'me', 'app', 'dev',
  'link', 'site',
])
/** Trailing punctuation that's prose, not part of the URL: `https://x.com.` — the sentence-ending
 * period is not part of the link. */
const TRAILING_URL_PUNCT_RE = /[.,;:!?)\]}'"]+$/

/** Strips a trailing sentence-punctuation run, and a trailing `>` when the char right before the
 * match is its opening `<` (`<https://.../help>` -> `https://.../help`, a plain-text link
 * delimiter, not part of the URL). */
function stripUrlToken(body: string, raw: string, matchStart: number): string {
  let s = raw
  if (body[matchStart - 1] === '<' && s.endsWith('>')) s = s.slice(0, -1)
  s = s.replace(TRAILING_URL_PUNCT_RE, '')
  return s
}

/** https + exact hostname in `policy.allowedHostnames`, OR byte-equal to a `policy.allowedExactUrls`
 * entry (a carrier tracking link that is legitimately off-domain). */
function isAllowedSchemedUrl(raw: string, policy: WorkspacePolicy): boolean {
  if (policy.allowedExactUrls.includes(raw)) return true
  try {
    const parsed = new URL(raw)
    return parsed.protocol === 'https:' && policy.allowedHostnames.includes(parsed.hostname.toLowerCase())
  } catch {
    return false
  }
}

export interface UrlScanResult {
  /** Spans (over the body) of every schemed URL that passed the allowlist — shared with the
   * contact screen so digits inside an allowed link are never misread as a phone number. */
  allowedSpans: Span[]
  /** Raw text of the first schemed URL that did NOT pass the allowlist, or null if all did. */
  disallowedRaw: string | null
}

/** Scans every schemed URL once, up front — shared by the contact screen and the URL/domain
 * screen (which owns reporting the actual `url_not_allowed` failure). Does not short-circuit on
 * the first bad URL: every allowed span is still collected. */
export function scanSchemedUrls(body: string, policy: WorkspacePolicy): UrlScanResult {
  const allowedSpans: Span[] = []
  let disallowedRaw: string | null = null

  const re = new RegExp(SCHEMED_URL_RE)
  let m: RegExpExecArray | null
  while ((m = re.exec(body))) {
    const matchStart = m.index
    const stripped = stripUrlToken(body, m[0], matchStart)
    if (isAllowedSchemedUrl(stripped, policy)) {
      allowedSpans.push({ start: matchStart, end: matchStart + stripped.length })
    } else if (disallowedRaw === null) {
      disallowedRaw = m[0]
    }
  }

  return { allowedSpans, disallowedRaw }
}

export function screenUrlNotAllowed(body: string, policy: WorkspacePolicy, urlScan: UrlScanResult): GuardrailFinding | null {
  if (urlScan.disallowedRaw !== null) {
    return { code: 'url_not_allowed', severity: 'fail', detail: `disallowed URL in reply body: ${urlScan.disallowedRaw}` }
  }

  const domainRe = new RegExp(BARE_DOMAIN_RE)
  let m: RegExpExecArray | null
  while ((m = domainRe.exec(body))) {
    const raw = m[0]
    const start = m.index
    const end = start + raw.length
    // Already covered by an allowed schemed URL — not a second, independent domain mention.
    // Deliberately NOT skipped for a leading `@` — an `@bare-domain.tld` with no local part
    // (a Telegram handle) is exactly the off-platform channel this screen exists to catch.
    if (overlapsAnySpan(start, end, urlScan.allowedSpans)) continue

    const lower = raw.toLowerCase()
    const labels = lower.split('.')
    const tld = labels[labels.length - 1]
    if (!tld || !PLAUSIBLE_TLDS.has(tld)) continue

    if (!policy.allowedHostnames.includes(lower)) {
      return { code: 'url_not_allowed', severity: 'fail', detail: `disallowed bare domain in reply body: ${raw}` }
    }
  }

  return null
}

// -- Contact screen --

const EMAIL_RE = /[\w.+-]+@[\w-]+(\.[\w-]+)+/g
/** A phone-like run of digits/separators. Deliberately loose (must catch `+1 (888) 555-0142`) —
 * `isPhoneLikeCandidate` below is what keeps `order #12345`, ISO dates, and long unseparated digit
 * runs (tracking numbers) from tripping it. */
const PHONE_RE = /[+(]?\d[\d\s().-]{6,}\d/g
const PHONE_MIN_DIGITS = 7
/** ISO date substrings (`2024-01-15`), exempted digit-by-digit (not by a whole-candidate check) so
 * a phone-regex candidate that merges two adjacent dates through a connecting space still has
 * every one of its digits correctly excluded. Digit-anchored on both ends so it can't land on a
 * 4-2-2 SLICE of a longer, non-date digit-dash run (a phone number regrouped as 4-2-2). */
const ISO_DATE_SPAN_RE = /(?<!\d)\d{4}-\d{2}-\d{2}(?!\d)/g
/** A separator INSIDE a candidate match — distinct from a leading `+`/`(`, checked separately. */
const PHONE_SEPARATOR_RE = /[\s().-]/
/** A standalone run of EXACTLY 10 or 11 digits, bounded by non-alphanumeric chars (or string
 * start/end) — the shape of a US phone number typed with no separators or leading `+`/`(` at all.
 * Independent of, and in addition to, the separator/prefix rule below. */
const STANDALONE_DIGIT_RUN_RE = /(?<![a-zA-Z0-9])\d{10,11}(?![a-zA-Z0-9])/g

/** Counts the digits inside `raw` that do NOT fall inside any of `excludeSpans` (ISO-date
 * occurrences) — a per-digit exemption, not a whole-match check. */
function digitsExcludingSpans(raw: string, matchStart: number, excludeSpans: Span[]): number {
  let count = 0
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!
    if (ch < '0' || ch > '9') continue
    const pos = matchStart + i
    if (excludeSpans.some((s) => pos >= s.start && pos < s.end)) continue
    count++
  }
  return count
}

/** ≥7 digits outside any ISO-date span, AND (a leading `+`/`(` OR an interior separator) — a bare
 * unseparated digit run (an order/tracking number) is not phone-like no matter how long; that
 * case is caught separately, but only at exactly 10/11 digits, by STANDALONE_DIGIT_RUN_RE. */
function isPhoneLikeCandidate(raw: string, effectiveDigitCount: number): boolean {
  if (effectiveDigitCount < PHONE_MIN_DIGITS) return false
  const hasLeadingPrefix = raw[0] === '+' || raw[0] === '('
  const hasSeparator = PHONE_SEPARATOR_RE.test(raw)
  return hasLeadingPrefix || hasSeparator
}

export function screenContactChannel(body: string, policy: WorkspacePolicy, urlScan: UrlScanResult): GuardrailFinding | null {
  const emailRe = new RegExp(EMAIL_RE)
  let m: RegExpExecArray | null
  while ((m = emailRe.exec(body))) {
    const raw = m[0]
    const lower = raw.toLowerCase()
    const allowed = policy.allowedEmailDomains.some((domain) => lower.endsWith(`@${domain.toLowerCase()}`))
    if (!allowed) {
      return { code: 'contact_channel', severity: 'fail', detail: `disallowed email address in reply body: ${raw}` }
    }
  }

  const isoDateSpans = findMatches(ISO_DATE_SPAN_RE, body)

  const phoneRe = new RegExp(PHONE_RE)
  while ((m = phoneRe.exec(body))) {
    const raw = m[0]
    const start = m.index
    const end = start + raw.length
    // Digits inside an allowed URL (tracking number in a path/query) are not a phone number.
    if (overlapsAnySpan(start, end, urlScan.allowedSpans)) continue
    const effectiveDigits = digitsExcludingSpans(raw, start, isoDateSpans)
    if (isPhoneLikeCandidate(raw, effectiveDigits)) {
      // policy.allowedPhoneNumbers digit-equality exemption, applied BEFORE failing.
      if (policy.allowedPhoneNumbers.includes(raw.replace(/\D/g, ''))) continue
      return { code: 'contact_channel', severity: 'fail', detail: `phone-like token in reply body: ${raw}` }
    }
  }

  const standaloneRe = new RegExp(STANDALONE_DIGIT_RUN_RE)
  while ((m = standaloneRe.exec(body))) {
    const raw = m[0]
    const start = m.index
    const end = start + raw.length
    if (overlapsAnySpan(start, end, urlScan.allowedSpans)) continue
    if (policy.allowedPhoneNumbers.includes(raw)) continue
    return { code: 'contact_channel', severity: 'fail', detail: `phone-like token in reply body: ${raw}` }
  }

  return null
}

// -- trusted_text_leak screen (new) --

/** Fails when a 10-word shingle of the normalized body appears in the shingle set of any
 * `policy.trustedTexts` entry with >= 10 words — texts shorter than that never contribute
 * shingles, so they can never trip this screen even if quoted verbatim. */
export function screenTrustedTextLeak(body: string, policy: WorkspacePolicy): GuardrailFinding | null {
  const bodyWords = normalizeForShingles(body)
  if (bodyWords.length < TRUSTED_TEXT_SHINGLE_WORDS) return null
  const bodyShingles = wordShingles(bodyWords, TRUSTED_TEXT_SHINGLE_WORDS)

  for (const trustedText of policy.trustedTexts) {
    const trustedWords = normalizeForShingles(trustedText)
    if (trustedWords.length < TRUSTED_TEXT_SHINGLE_WORDS) continue
    const trustedShingles = wordShingles(trustedWords, TRUSTED_TEXT_SHINGLE_WORDS)
    for (const shingle of bodyShingles) {
      if (trustedShingles.has(shingle)) {
        return {
          code: 'trusted_text_leak',
          severity: 'fail',
          detail: `reply body shares a 10-word shingle with a trusted text: "${shingle}"`,
        }
      }
    }
  }

  return null
}
