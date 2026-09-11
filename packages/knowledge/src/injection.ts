import { type KnowledgeInjectionReason } from '@aesa/contracts'

/** Ordered table of prompt-injection patterns. `screenChunk` returns the FIRST rule that matches;
 * narrow a pattern (never widen) if a fixture forces a change, and pin the sentence in
 * `test/injection.test.ts`. The `reason` codes — and their order, which decides what an owner sees
 * when a chunk trips more than one rule — are the contract `KNOWLEDGE_INJECTION_REASONS` pins.
 *
 * The two verb rules (`override_instructions`, `exfiltration`) anchor their verb in IMPERATIVE
 * position — start of a line, after a sentence-ending mark, or after "and" — because ordinary
 * support prose uses the same verbs with a subject in front of them and must not be quarantined:
 * "We will never email you your password", "we send a one-time token to the address on file",
 * "If you forget your password, follow the above instructions" and "You can disregard the earlier
 * instructions if you have already updated" all flagged before the anchor went in (final review
 * A1), and are pinned as CLEAN fixtures now. An injected instruction, by contrast, is a command:
 * it has no subject, so it sits exactly where the anchor looks — or follows a politeness or modal
 * word ("Please ignore…", "You must ignore…", "Now disregard…", "Then send…", "Always send…"),
 * which the anchor therefore also admits (final review re-review NB1); a SUBJECT pronoun or noun
 * directly before the verb ("we send", "you forget", "can disregard", "never email") still does not. */
const RULES: { reason: KnowledgeInjectionReason; pattern: RegExp }[] = [
  { reason: 'override_instructions', pattern: /(^|[.!?:;,]\s*|\b(?:and|please|now|then|also|just|simply|always|must|should)\s+)(ignore|disregard|forget|override)\b[^.]{0,40}\b(all |any |the )?(previous|prior|above|earlier|operating|system)\b[^.]{0,20}\b(instructions?|prompts?|rules?|guidance)\b/m },
  { reason: 'role_reassignment', pattern: /\b(you are (now )?(an? )?(ai|assistant|chatbot|language model|claude|chatgpt|gpt)\b|\bas an ai\b|\byou must (now )?(approve|refund|send|forward|reveal))/ },
  { reason: 'system_prompt', pattern: /\bsystem prompt\b|^\s*###?\s*(system|instruction)s?\s*:/m },
  { reason: 'concealment', pattern: /\b(do not|don't|never) (tell|reveal|mention|disclose|show)\b[^.]{0,40}\b(the )?(user|customer|owner|human|them)\b/ },
  // Known false-positive class, accepted deliberately: a pasted support TRANSCRIPT ("User: how do
  // I return this?" / "Agent: ...") is a line-leading role label and flags here. Narrowing the
  // rule to exclude it would also let a real injected turn marker through, so the flag stands and
  // the owner-facing flagged-chunk view carries the copy that explains it (final review A1/C4).
  { reason: 'role_marker', pattern: /^\s*(system|assistant|user)\s*:/m },
  { reason: 'forced_output', pattern: /\b(respond|reply|answer)\s+(only\s+)?with\b[^.]{0,40}\b(the following|exactly|this text)\b/ },
  { reason: 'exfiltration', pattern: /(^|[.!?:;,]\s*|\b(?:and|please|now|then|also|just|simply|always|must|should)\s+)(send|forward|email|post|exfiltrate)\b[^.]{0,60}\b(api key|password|credentials?|token|secret)\b/m },
]

/** Zero-width and bidi format characters that can hide instructions inside otherwise ordinary
 * text: ZWSP/ZWNJ/ZWJ/LRM/RLM (U+200B-200F), bidi embedding/override controls (U+202A-202E),
 * word joiner and invisible math operators (U+2060-2064), bidi isolates (U+2066-2069), and
 * ZWNBSP/BOM (U+FEFF). Deliberately narrower than `\p{Cf}` (fix review #4): that broader class
 * also matches U+00AD SOFT HYPHEN, which Word/LaTeX PDF exports and `&shy;` produce routinely in
 * ordinary hyphenation and is never a concealment vector on its own. */
const FORMAT_CHAR_RE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g

const LETTER_RE = /\p{L}/u

/** How many format characters in `text` are actually hiding something. U+200C ZWNJ and U+200D ZWJ
 * BETWEEN two letters are ordinary orthography, not concealment — Persian and Arabic use ZWNJ to
 * break a ligature inside a word (Persian می + ZWNJ + خواهم), and Indic scripts use ZWJ the same way — so a
 * ZWNJ/ZWJ with a letter on each side is not counted. Every other occurrence (and every other
 * character in the class) still is. */
function invisibleCount(text: string): number {
  let count = 0
  for (const match of text.matchAll(FORMAT_CHAR_RE)) {
    const char = match[0]
    if (char === '\u200C' || char === '\u200D') {
      const before = text[match.index - 1]
      const after = text[match.index + 1]
      if (before !== undefined && after !== undefined && LETTER_RE.test(before) && LETTER_RE.test(after)) continue
    }
    count++
  }
  return count
}

/** NFKC-normalize and lowercase for pattern matching; collapse whitespace WITHIN each line (not
 * across lines) so the `^...` line-start rules stay meaningful for multi-line chunk content. */
function normalizeForMatching(text: string): string {
  return text
    .normalize('NFKC')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .join('\n')
    .toLowerCase()
}

/** Screen one knowledge chunk's text for prompt-injection content before it is ever eligible for
 * retrieval. A flagged chunk is stored but never retrieved until an owner clears the flag. */
export function screenChunk(content: string): { flagged: boolean; reason: KnowledgeInjectionReason | null } {
  const normalized = content.normalize('NFKC')
  const formatCharCount = invisibleCount(normalized)
  if (formatCharCount > 8 || formatCharCount > normalized.length * 0.01) {
    return { flagged: true, reason: 'invisible_text' }
  }

  const matchText = normalizeForMatching(normalized)
  for (const rule of RULES) {
    if (rule.pattern.test(matchText)) return { flagged: true, reason: rule.reason }
  }
  return { flagged: false, reason: null }
}
