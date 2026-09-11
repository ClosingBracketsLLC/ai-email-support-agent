import type { GuardrailCode } from '@aesa/contracts'
import type { WorkspacePolicy } from './policy.ts'
import {
  scanSchemedUrls,
  screenBodyTooLong,
  screenContactChannel,
  screenEmptyBody,
  screenHtmlNotAllowed,
  screenInvisibleChars,
  screenPromisedAction,
  screenSecretLeak,
  screenTrustedTextLeak,
  screenUrlNotAllowed,
} from './screens.ts'

export type GuardrailSeverity = 'fail' | 'warn'

/** `detail` is audit-only (may quote the draft) — never surfaced to the customer. */
export interface GuardrailFinding {
  code: GuardrailCode
  severity: GuardrailSeverity
  detail: string
}

export interface GuardrailResult {
  /** No 'fail' findings. A 'warn'-only result is still ok:true. */
  ok: boolean
  /** NFKC + double default-ignorable strip of the input — what was screened is what is stored and sent. */
  normalizedBody: string
  /** Every finding, in screen order — not just the first. */
  findings: GuardrailFinding[]
  warningCount: number
}

export interface ValidateOptions {
  /** The model's own `customerLanguage`; compared with policy.expectedLanguage → language_mismatch (warn). */
  replyLanguage?: string | null
  /** Number-ish tokens present in the thread + profile + guidance + retrieved knowledge; a money
   * amount or a "N (business) days" timeframe in the reply that is not in this list → unbacked_number (warn). */
  groundedNumbers?: readonly string[]
}

/**
 * Strips the WHOLE default-ignorable set (`\p{Default_Ignorable_Code_Point}`) both BEFORE and AFTER
 * NFKC — NFKC can expand a compatibility char into a sequence that itself contains one, so a single
 * pass is not enough.
 *
 * Not just `\p{Cf}` (ZWSP, BOM, ZWNJ/ZWJ, word joiner, soft hyphen, the bidi controls): U+FE00–FE0F
 * (VARIATION SELECTOR-1..16) and U+034F (COMBINING GRAPHEME JOINER) are category `Mn`, render as
 * nothing, and survive NFKC — one of them inside a token used to turn a hard FAIL into a clean pass
 * on six of the eight screens (final-B I2). Default-ignorable is exactly the set Unicode defines as
 * "renders as nothing", which is the property that makes a character able to hide inside a token.
 */
function stripFormatChars(s: string): string {
  return s.replace(/\p{Default_Ignorable_Code_Point}/gu, '')
}

/** `unbacked_number` (warn) — only runs when `opts.groundedNumbers` is supplied. */
function screenUnbackedNumber(body: string, groundedNumbers: readonly string[] | undefined): GuardrailFinding | null {
  if (groundedNumbers === undefined) return null
  const mentioned = extractNumberTokens(body)
  const ungrounded = mentioned.filter((token) => !groundedNumbers.includes(token))
  if (ungrounded.length === 0) return null
  return {
    code: 'unbacked_number',
    severity: 'warn',
    detail: `reply body mentions a number not present in the grounding sources: ${ungrounded.join(', ')}`,
  }
}

/** `language_mismatch` (warn) — only when both sides are known and their primary subtags differ
 * (`en-US` vs `en` is not a mismatch). */
function screenLanguageMismatch(expectedLanguage: string | null, replyLanguage: string | null): GuardrailFinding | null {
  if (expectedLanguage === null || replyLanguage === null) return null
  const primarySubtag = (lang: string): string => lang.split('-')[0]!.toLowerCase()
  if (primarySubtag(expectedLanguage) === primarySubtag(replyLanguage)) return null
  return {
    code: 'language_mismatch',
    severity: 'warn',
    detail: `reply language "${replyLanguage}" does not match the customer's language "${expectedLanguage}"`,
  }
}

/**
 * Body-only guardrails (spec §Guardrails). Every screen runs and every finding is collected, in
 * screen order — `ok` is "no fail findings", not "stopped at the first one". Screen order: plain
 * text (empty_body, html_not_allowed, body_too_long, invisible_chars) → secret_leak →
 * promised_action → contact_channel → url_not_allowed → trusted_text_leak → unbacked_number (warn)
 * → language_mismatch (warn).
 *
 * Contact runs BEFORE the URL/domain screen so a bare `@domain.tld` mention with a real local part
 * (`help@gmail.com`) is reported as `contact_channel` first — both screens still independently
 * catch every bypass either way; this only decides which code comes first when a body trips both.
 *
 * Unicode-normalizes before ANY screen runs: NFKC folds compatibility look-alikes down to their
 * plain ASCII equivalents, and every default-ignorable code point (format characters AND the
 * non-`Cf` ones — variation selectors, the combining grapheme joiner) is stripped (not failed) so an
 * invisible character inside a token can't dodge a screen while rendering identically to the
 * customer. The stripped+normalized string is `normalizedBody` — what gets stored and sent.
 */
export function validateReplyBody(rawBody: string, policy: WorkspacePolicy, opts: ValidateOptions = {}): GuardrailResult {
  const body = stripFormatChars(stripFormatChars(rawBody).normalize('NFKC'))

  const findings: GuardrailFinding[] = []
  const record = (finding: GuardrailFinding | null): void => {
    if (finding) findings.push(finding)
  }

  record(screenEmptyBody(body))
  record(screenHtmlNotAllowed(body))
  record(screenBodyTooLong(body, policy.maxChars))
  record(screenInvisibleChars(body))
  record(screenSecretLeak(body))
  record(screenPromisedAction(body))
  const urlScan = scanSchemedUrls(body, policy)
  record(screenContactChannel(body, policy, urlScan))
  record(screenUrlNotAllowed(body, policy, urlScan))
  record(screenTrustedTextLeak(body, policy))
  record(screenUnbackedNumber(body, opts.groundedNumbers))
  record(screenLanguageMismatch(policy.expectedLanguage, opts.replyLanguage ?? null))

  const warningCount = findings.filter((f) => f.severity === 'warn').length
  const ok = findings.every((f) => f.severity !== 'fail')

  return { ok, normalizedBody: body, findings, warningCount }
}

/** The signature is appended by CODE after validation, never written by the model (spec
 * §Guardrails). A no-op for an empty (or whitespace-only) signature — no blank-line suffix with
 * nothing to sign. Idempotent for a non-empty signature: does not double-append. */
export function appendSignature(body: string, signature: string): string {
  if (signature.trim() === '') return body
  const suffix = `\n\n${signature}`
  return body.endsWith(suffix) ? body : `${body}${suffix}`
}

/** Number-ish tokens (`$12.50`, `12.50 USD`, `15%`, `30 days`, `3-5 business days`) a body
 * mentions, in order of appearance — used both by `unbacked_number` and to build
 * `groundedNumbers` from source texts (see `collectGroundedNumbers`). */
const NUMBER_TOKEN_RE = /\$\d+(?:\.\d+)?|\d+(?:\.\d+)?\s?(?:USD|usd)\b|\d+(?:\.\d+)?%|\d+(?:-\d+)?\s*(?:business\s+)?days\b/g

export function extractNumberTokens(text: string): string[] {
  const tokens: string[] = []
  const re = new RegExp(NUMBER_TOKEN_RE)
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) tokens.push(m[0])
  return tokens
}
