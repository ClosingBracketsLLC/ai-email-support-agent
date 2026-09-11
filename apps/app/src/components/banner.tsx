import { StyleSheet, Text, View } from 'react-native'
import { radius, spacing, typeScale, useColors } from '@/theme'

/** `warning` is the fourth tone, on the theme's own `warningTint`/`warningText` pair: for something
 * the owner is about to do that has a consequence but is not an error and is not success — the
 * onboarding "Skip for now" confirmation, say. `info` (`primaryTint`) reads as neutral chrome, which
 * is exactly the wrong weight for a choice that needs a second look. */
export function Banner({ tone = 'info', children, testID }: { tone?: 'info' | 'error' | 'success' | 'warning'; children: string; testID?: string }) {
  const c = useColors()
  const look = tone === 'error'
    ? { bg: c.dangerTint, fg: c.dangerText }
    : tone === 'success' ? { bg: c.successTint, fg: c.successText }
      : tone === 'warning' ? { bg: c.warningTint, fg: c.warningText }
        : { bg: c.primaryTint, fg: c.text }
  return (
    <View accessibilityRole="alert" testID={testID} style={[styles.box, { backgroundColor: look.bg }]}>
      <Text style={[typeScale.body, { color: look.fg }]}>{children}</Text>
    </View>
  )
}
const styles = StyleSheet.create({ box: { borderRadius: radius.md, padding: spacing.md } })
