import { StyleSheet, Text, View } from 'react-native'
import type { OnboardingStep } from '@aesa/contracts'
import { radius, spacing, typeScale, useColors } from '@/theme'

const STEPS: { key: Exclude<OnboardingStep, 'done'>; label: string }[] = [
  { key: 'profile', label: 'Profile' }, { key: 'mailbox', label: 'Mailbox' }, { key: 'knowledge', label: 'Knowledge' }, { key: 'go_live', label: 'Go live' },
]

export function Stepper({ current }: { current: OnboardingStep }) {
  const c = useColors()
  const at = STEPS.findIndex((s) => s.key === current)
  return (
    <View style={styles.row} accessibilityRole="tablist">
      {STEPS.map((s, i) => {
        const selected = s.key === current
        const done = i < at || current === 'done'
        return (
          <View key={s.key} testID={`step-${s.key}`} accessibilityRole="tab" accessibilityState={{ selected }}
            style={[styles.pill, { backgroundColor: selected ? c.primary : done ? c.surface : c.bg, borderColor: selected ? c.primary : c.border }]}>
            <Text style={[typeScale.caption, { color: selected ? c.onPrimary : c.muted }]}>{i + 1}. </Text>
            <Text style={[typeScale.caption, { color: selected ? c.onPrimary : c.muted }]}>{s.label}</Text>
          </View>
        )
      })}
    </View>
  )
}
const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  pill: { paddingHorizontal: spacing.md, paddingVertical: spacing.xs, borderRadius: radius.lg, borderWidth: 1 },
})
