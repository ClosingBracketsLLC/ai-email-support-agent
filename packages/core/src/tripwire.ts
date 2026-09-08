/**
 * Deterministic escalation floor evaluated at ingest on every first-inserted inbound, before any model.
 * Phrases match on WORD BOUNDARIES after NFKC + lowercase + whitespace collapse — the reference's substring
 * matcher tripped "issue"/"express"/"minor" (adversarial review, blocker #1). Baseline phrases can never be
 * removed by a workspace; workspaces may add phrases (`workspaces.tripwire_extra_keywords`).
 */
export const TRIPWIRE_BASELINE: readonly string[] = [
  'chargeback', 'dispute', 'lawsuit', 'attorney', 'lawyer', 'legal action', 'sue you', 'suing', 'small claims',
  'injury', 'injured', 'hurt', 'hospital', 'recall', 'harass', 'harassment', 'threat', 'threaten', 'threatening',
  'police', 'subpoena', 'fraud', 'identity theft', 'suicide', 'self-harm', 'kill myself', 'under 18', 'my child',
  'delete my data', 'data deletion', 'gdpr', 'ccpa', 'press inquiry', 'journalist', 'reporter',
]

export function normalizeForMatch(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ')
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const cache = new Map<string, RegExp>()
function phraseRegex(phrase: string): RegExp {
  let re = cache.get(phrase)
  if (!re) {
    const words = normalizeForMatch(phrase).split(' ').map(escape).join('\\s+')
    re = new RegExp(`(?<![\\p{L}\\p{N}])${words}(?![\\p{L}\\p{N}])`, 'u')
    cache.set(phrase, re)
  }
  return re
}

/** Returns the first baseline-or-extra phrase found in `text`, or null. */
export function tripwireHit(text: string, extraPhrases: readonly string[] = []): string | null {
  const haystack = normalizeForMatch(text)
  for (const phrase of [...TRIPWIRE_BASELINE, ...extraPhrases]) {
    if (phrase.trim() && phraseRegex(phrase).test(haystack)) return normalizeForMatch(phrase)
  }
  return null
}
