import { useEffect, useRef, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { Button } from '@/components/button'
import { Body } from '@/components/typography'
import { radius, spacing, useColors } from '@/theme'
import { useCountdown } from './use-countdown'

/**
 * The window between a decision and `send.execute` claiming the send. It renders nothing once the
 * window closes — the send is the server's now — and tells its owner so, once.
 *
 * Two windows land on this one bar, and only the words differ (Phase 5): the owner's own approval
 * opens a 15-second `Undo` on a reply they just decided to send, while an AUTO-send opens the
 * agent's `autoSendDelayMin` hold window on a reply nobody approved — there is nothing to undo
 * there, only a send to `Hold`. Both call the same `drafts.hold`.
 */
export function UndoBar({ untilAt, onUndo, busy, tickMs, onExpired, label = 'Undo', verb = 'Sending', testID = 'undo-bar' }: {
  untilAt: Date
  onUndo: () => void
  busy: boolean
  tickMs?: number
  onExpired?: () => void
  /** The button's word: 'Undo' for the owner's own approval, 'Hold' for an auto-send. */
  label?: string
  /** The countdown's verb: `${verb} in Ns`. */
  verb?: string
  testID?: string
}) {
  const c = useColors()
  const { secondsLeft, done } = useCountdown(untilAt, { tickMs })
  const [fired, setFired] = useState(false)

  // Held in a ref so an inline `onExpired={() => …}` cannot re-fire this on every render.
  const expired = useRef(onExpired)
  expired.current = onExpired
  useEffect(() => { if (done) expired.current?.() }, [done])

  if (done) return null

  function undo() {
    if (busy || fired) return
    setFired(true)
    onUndo()
  }

  return (
    <View style={[styles.bar, { borderColor: c.border, backgroundColor: c.primaryTint }]} testID={testID}>
      <Body style={styles.label}>{`${verb} in ${secondsLeft}s`}</Body>
      <Button label={label} variant="secondary" onPress={undo} loading={busy} disabled={fired} testID="undo-button" />
    </View>
  )
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, borderWidth: 1, borderRadius: radius.md, padding: spacing.sm },
  label: { flex: 1 },
})
