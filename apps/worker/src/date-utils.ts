/** UTC calendar day as YYYY-MM-DD — the same day-scoping convention ticket-triage.ts uses for its
 * escalation/cap dedupe keys (Task 14's controller ruling): a lifetime key would let the FIRST
 * notification ever sent for a key permanently win the dedupe unique index. */
export function utcDayString(d: Date): string {
  return d.toISOString().slice(0, 10)
}
