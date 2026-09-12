/** UTC calendar day as YYYY-MM-DD — the same day-scoping convention ticket-triage.ts uses for its
 * escalation/cap dedupe keys (Task 14's controller ruling): a lifetime key would let the FIRST
 * notification ever sent for a key permanently win the dedupe unique index. */
export function utcDayString(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/** ISO-8601 week of the UTC date, as `YYYY-Www` (Thursday-anchored): `stats.rollup`'s Monday nudge
 * dedupe key, once per ISO week rather than once per literal Monday. The standard algorithm — shift
 * to the Thursday of the same ISO week, then the week number is that Thursday's ordinal day divided
 * by 7 — so it stays correct across a year boundary (e.g. 2025-12-29, a Monday, is `2026-W01`
 * because its Thursday, 2026-01-01, falls in 2026). */
export function utcWeekString(d: Date): string {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  const isoDayOfWeek = date.getUTCDay() || 7 // Monday=1 .. Sunday=7
  date.setUTCDate(date.getUTCDate() + 4 - isoDayOfWeek) // the Thursday of this ISO week
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1))
  const weekNo = Math.ceil(((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7)
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`
}
