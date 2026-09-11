/** Ordered table of prompt-injection patterns. `screenChunk` returns the FIRST rule that matches;
 * narrow a pattern (never widen) if a fixture forces a change, and pin the sentence in
 * `test/injection.test.ts`. */
const RULES: { reason: string; pattern: RegExp }[] = [
  { reason: 'override_instructions', pattern: /\b(ignore|disregard|forget|override)\b[^.]{0,40}\b(all |any |the )?(previous|prior|above|earlier|operating|system)\b[^.]{0,20}\b(instructions?|prompts?|rules?|guidance)\b/ },
  { reason: 'role_reassignment', pattern: /\b(you are (now )?(an? )?(ai|assistant|chatbot|language model|claude|chatgpt|gpt)\b|\bas an ai\b|\byou must (now )?(approve|refund|send|forward|reveal))/ },
  { reason: 'system_prompt', pattern: /\bsystem prompt\b|^\s*###?\s*(system|instruction)s?\s*:/m },
  { reason: 'concealment', pattern: /\b(do not|don't|never) (tell|reveal|mention|disclose|show)\b[^.]{0,40}\b(the )?(user|customer|owner|human|them)\b/ },
  { reason: 'role_marker', pattern: /^\s*(system|assistant|user)\s*:/m },
  { reason: 'forced_output', pattern: /\b(respond|reply|answer)\s+(only\s+)?with\b[^.]{0,40}\b(the following|exactly|this text)\b/ },
  { reason: 'exfiltration', pattern: /\b(send|forward|email|post|exfiltrate)\b[^.]{0,60}\b(api key|password|credentials?|token|secret)\b/ },
]

/** `\p{Cf}` — Unicode "format" characters: zero-width spaces/joiners, bidi controls, and similar
 * invisible-in-rendering characters that can hide instructions inside otherwise ordinary text. */
const FORMAT_CHAR_RE = /\p{Cf}/gu

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
export function screenChunk(content: string): { flagged: boolean; reason: string | null } {
  const normalized = content.normalize('NFKC')
  const formatCharCount = (normalized.match(FORMAT_CHAR_RE) ?? []).length
  if (formatCharCount > 8 || formatCharCount > normalized.length * 0.01) {
    return { flagged: true, reason: 'invisible_text' }
  }

  const matchText = normalizeForMatching(normalized)
  for (const rule of RULES) {
    if (rule.pattern.test(matchText)) return { flagged: true, reason: rule.reason }
  }
  return { flagged: false, reason: null }
}
