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

export function scrubForMemory(text: string, opts: { customerName?: string | null; customerEmail?: string | null } = {}): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  // 1. Drop a greeting on the first non-blank line.
  const firstIdx = lines.findIndex((l) => l.trim() !== '')
  if (firstIdx >= 0 && GREETING_RE.test(lines[firstIdx]!.trim())) lines.splice(firstIdx, 1)
  // 2. Drop everything from the LAST sign-off line onward, when it sits in the trailing half of the message
  //    (a greeting-only first line already removed can otherwise push a short sign-off block just
  //    outside a "trailing third" window; a half keeps the same "only near the end" intent).
  let cut = -1
  for (let i = lines.length - 1; i >= Math.floor(lines.length / 2); i--) {
    if (SIGNOFF_RE.test(lines[i]!.trim())) { cut = i; break }
  }
  const kept = cut >= 0 ? lines.slice(0, cut) : lines
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
