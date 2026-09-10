import { StyleSheet, Switch, Text, View } from 'react-native'
import { spacing, typeScale, useColors } from '@/theme'

/** A labelled on/off control: label (and optional hint) on the left, the platform switch on the right. */
export function SwitchRow({
  label, value, onValueChange, disabled = false, hint, testID,
}: {
  label: string
  value: boolean
  onValueChange: (value: boolean) => void
  disabled?: boolean
  hint?: string
  testID?: string
}) {
  const c = useColors()
  return (
    <View style={styles.row}>
      <View style={styles.labels}>
        <Text style={[typeScale.body, styles.label, { color: c.text }]}>{label}</Text>
        {hint ? <Text style={[typeScale.caption, { color: c.muted }]}>{hint}</Text> : null}
      </View>
      <Switch
        value={value}
        // `disabled` has to stop the callback here: React Native's `Switch` keeps `onValueChange` on
        // the element either way (it is the native control that ignores touches), and a row that
        // says it is disabled must never emit.
        onValueChange={(next) => { if (!disabled) onValueChange(next) }}
        disabled={disabled}
        accessibilityRole="switch"
        accessibilityLabel={label}
        accessibilityState={{ checked: value, disabled }}
        trackColor={{ false: c.border, true: c.primary }}
        testID={testID}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  labels: { flex: 1, gap: spacing.xs },
  label: { fontWeight: '600' },
})
