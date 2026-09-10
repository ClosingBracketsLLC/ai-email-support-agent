import { useEffect, useRef, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { Button } from '@/components/button'
import { Body } from '@/components/typography'
import { radius, spacing, useColors } from '@/theme'
import { useCountdown } from './use-countdown'

/**
 * The 15-second window between "Approve" and `send.execute` claiming the send. It renders nothing
 * once the window closes — the send is the server's now — and tells its owner so, once.
 */
export function UndoBar({ untilAt, onUndo, busy, tickMs, onExpired, testID = 'undo-bar' }: {
  untilAt: Date
  onUndo: () => void
  busy: boolean
  tickMs?: number
  onExpired?: () => void
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
    <View style={[styles.bar, { borderColor: c.border, backgroundColor: c.info }]} testID={testID}>
      <Body style={styles.label}>{`Sending in ${secondsLeft}s`}</Body>
      <Button label="Undo" variant="secondary" onPress={undo} loading={busy} disabled={fired} testID="undo-button" />
    </View>
  )
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, borderWidth: 1, borderRadius: radius.md, padding: spacing.sm },
  label: { flex: 1 },
})
