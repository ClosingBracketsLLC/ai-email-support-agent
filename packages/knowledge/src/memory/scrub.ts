/**
 * The structural PII scrub every resolved answer's question and answer pass through BEFORE storage
 * (spec §Learning loop, privacy). Structural on purpose: no model, no NER — a greeting line, a
 * sign-off block, and four token shapes (email, phone, long digit run, the customer's own name).
 * It is lossy by design; what survives is what the next draft needs to recognise a similar question.
 */
const GREETING_RE = /^(hi|hello|hey|dear|good (morning|afternoon|evening)|greetings)\b[^\n]*$/i
const SIGNOFF_RE = /^(thanks|thank you|many thanks|cheers|best|best regards|kind regards|regards|sincerely|warm regards|yours( sincerely| faithfully)?|--|—)\b/i
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi
/** 7+ digits with optional separators, an optional leading + and an optional (area) group. */
const PHONE_RE = /\+?\(?\d[\d\s().-]{5,}\d(?=\b)/g
/** A run of 5+ digits (order numbers, tracking, account ids); "30" and "2026" survive. */
const LONG_DIGITS_RE = /\d{5,}/g

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** A sign-off block is short — a closing line, a name, maybe a title and a company. Past this many
 *  non-blank lines after it, the "sign-off" line is prose that merely starts with a sign-off word. */
const SIGNOFF_MAX_TRAILING_LINES = 3

export function scrubForMemory(text: string, opts: { customerName?: string | null; customerEmail?: string | null } = {}): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const firstIdx = lines.findIndex((l) => l.trim() !== '')
  /**
   * 1. The sign-off cut: drop everything from the LAST qualifying sign-off line onward. Computed on
   *    the ORIGINAL lines, before the greeting is removed below, so both bounds below are the
   *    message's own.
   *
   *    THREE bounds, all load-bearing:
   *    - it sits in the trailing HALF of the message (a greeting-only first line can otherwise push
   *      a short sign-off block just outside a "trailing third" window);
   *    - it is NOT the message's first content line. A real reply can OPEN with a sign-off word —
   *      "Thanks for getting in touch. I have checked …" — and a one-line reply's only line IS its
   *      trailing half, so without this the whole answer was cut and `memory.capture` learned
   *      nothing from it (`memory.skipped`, `empty_after_scrub`);
   *    - at most `SIGNOFF_MAX_TRAILING_LINES` non-blank lines follow it, because a sign-off block is
   *      short. A middle paragraph opening "Thanks for confirming that." keeps the answer under it.
   *
   *    A greeting on the first content line is dropped by step 2, not by this cut — which is why an
   *    all-greeting-plus-sign-off message still scrubs to the empty string.
   */
  let cut = -1
  for (let i = lines.length - 1; i > firstIdx && i >= Math.floor(lines.length / 2); i--) {
    if (!SIGNOFF_RE.test(lines[i]!.trim())) continue
    if (lines.slice(i + 1).filter((l) => l.trim() !== '').length > SIGNOFF_MAX_TRAILING_LINES) continue
    cut = i
    break
  }
  const kept = cut >= 0 ? lines.slice(0, cut) : [...lines]
  // 2. Drop a greeting on the first non-blank line.
  if (firstIdx >= 0 && firstIdx < kept.length && GREETING_RE.test(kept[firstIdx]!.trim())) kept.splice(firstIdx, 1)
  let out = kept.join('\n')
  // 3. Token masks, most specific first. A phone match with no separator character (a bare digit
  //    run like an order number) is left for the long-digits mask below rather than [phone] — a
  //    phone number always carries a +, space, paren or dash, and a bare digit run is what the
  //    order-number test row is checking for.
  if (opts.customerEmail) out = out.replace(new RegExp(escapeRe(opts.customerEmail.trim()), 'gi'), '[email]')
  out = out.replace(EMAIL_RE, '[email]')
  out = out.replace(PHONE_RE, (m) => (/[\s().+-]/.test(m) && m.replace(/\D/g, '').length >= 7 ? '[phone]' : m))
  out = out.replace(LONG_DIGITS_RE, '[number]')
  const name = opts.customerName?.trim()
  if (name && name.length >= 2) {
    for (const part of name.split(/\s+/).filter((p) => p.length >= 2)) {
      out = out.replace(new RegExp(`\\b${escapeRe(part)}\\b`, 'gi'), '[name]')
    }
  }
  // 4. Whitespace: trim lines, collapse 3+ newlines to a blank line, trim the whole.
  return out.split('\n').map((l) => l.trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim()
}
