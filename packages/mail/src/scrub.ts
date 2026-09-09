/** Candidate card-number run: 13-19 digits, spaces/dashes allowed between (not after) digits. */
const CANDIDATE_RE = /\b(?:\d[ -]?){13,19}\b/g

/** Luhn checksum (mod-10) over a plain digit string. */
function luhnValid(digits: string): boolean {
  if (digits.length === 0) return false
  let sum = 0
  let double = false
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let n = Number(digits[i])
    if (double) {
      n *= 2
      if (n > 9) n -= 9
    }
    sum += n
    double = !double
  }
  return sum % 10 === 0
}

/**
 * Masks Luhn-valid card numbers (13-19 digits, optionally grouped with spaces or dashes) with
 * `[card removed]`. Digit runs that fail the Luhn check — order numbers, phone numbers, tracking
 * ids — are left untouched. The candidate regex's trailing `[ -]?` can swallow a separator that
 * belongs to the surrounding text (e.g. the space before the next word); that trailing separator
 * is carried back into the output rather than eaten by the replacement.
 */
export function scrubCardNumbers(text: string): string {
  return text.replace(CANDIDATE_RE, (match) => {
    const trailingSep = /[ -]+$/.exec(match)?.[0] ?? ''
    const core = trailingSep ? match.slice(0, -trailingSep.length) : match
    const digits = core.replace(/[ -]/g, '')
    if (!luhnValid(digits)) return match
    return `[card removed]${trailingSep}`
  })
}
