/**
 * `trusted_text_leak` support: turns text into 10-word shingles so the guardrail can catch a
 * reply that quotes a trusted source (platform hard rules, persona text, workspace/agent
 * guidance) verbatim without needing exact-string matching.
 */

/** How many consecutive words make one shingle for the trusted-text leak screen. */
export const TRUSTED_TEXT_SHINGLE_WORDS = 10

/** Lowercase, NFKC-normalize, strip punctuation (keep letters/digits), and split on whitespace. */
export function normalizeForShingles(text: string): string[] {
  const folded = text.normalize('NFKC').toLowerCase()
  const lettersAndDigitsOnly = folded.replace(/[^\p{L}\p{N}\s]+/gu, ' ')
  return lettersAndDigitsOnly.split(/\s+/).filter((w) => w.length > 0)
}

/** Every contiguous run of `n` words, joined by a single space. Fewer than `n` words → empty set. */
export function wordShingles(words: string[], n = TRUSTED_TEXT_SHINGLE_WORDS): Set<string> {
  const shingles = new Set<string>()
  for (let i = 0; i + n <= words.length; i++) {
    shingles.add(words.slice(i, i + n).join(' '))
  }
  return shingles
}
