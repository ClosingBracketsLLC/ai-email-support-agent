import { useEffect, useRef, useState } from 'react'

/** Four frames a second: fast enough that the undo bar never looks stuck on a second. */
const DEFAULT_TICK_MS = 250

/**
 * Seconds left until `until`, re-read on a timer. Both the tick and the clock are injectable so a
 * test can run a 40 ms window at a 5 ms tick — this codebase never uses fake timers (React 19's
 * awaited `act()` deadlocks with them).
 *
 * The interval stops itself the moment the window closes, so a finished countdown queues no further
 * state updates (an update landing after a test's last `act()` is what prints a spurious warning).
 */
export function useCountdown(
  until: Date | null,
  opts: { tickMs?: number; now?: () => Date } = {},
): { secondsLeft: number; done: boolean } {
  const tickMs = opts.tickMs ?? DEFAULT_TICK_MS
  const nowFn = useRef(opts.now)
  nowFn.current = opts.now
  const read = () => (nowFn.current ? nowFn.current() : new Date()).getTime()

  const untilMs = until === null ? null : until.getTime()
  const [nowMs, setNowMs] = useState(read)

  useEffect(() => {
    if (untilMs === null) return
    // Re-read on mount and whenever the window changes: `nowMs` may be a whole window old by then.
    setNowMs(read())
    const id = setInterval(() => {
      const t = read()
      setNowMs(t)
      if (t >= untilMs) clearInterval(id)
    }, tickMs)
    return () => clearInterval(id)
  }, [untilMs, tickMs])

  if (untilMs === null) return { secondsLeft: 0, done: true }
  const remainingMs = untilMs - nowMs
  return { secondsLeft: Math.max(0, Math.ceil(remainingMs / 1000)), done: remainingMs <= 0 }
}
