/**
 * One clock for both countdown surfaces — the ticket panel's bar (`undo-bar.tsx`) and the inbox
 * row's chip (`auto-send-chip.tsx`) — so the same window never reads two different ways.
 *
 * Two windows land on it. The 15-second undo after an approve is still spoken in bare seconds
 * ("Sending in 12s"), which is how a countdown that short reads naturally; an auto-send's hold
 * window is 2, 5 or 15 minutes (`AUTO_SEND_DELAY_CHOICES`), and "899s" is not a time anyone reads —
 * from a minute up it is `m:ss`.
 */
export function formatCountdown(secondsLeft: number): string {
  const seconds = Math.max(0, Math.floor(secondsLeft))
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}
