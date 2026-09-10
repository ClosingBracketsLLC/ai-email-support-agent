import { StyleSheet, Text, View } from 'react-native'
import { radius, spacing, typeScale, useColors } from '@/theme'

export function Banner({ tone = 'info', children, testID }: { tone?: 'info' | 'error' | 'success'; children: string; testID?: string }) {
  const c = useColors()
  const look = tone === 'error' ? { bg: c.dangerTint, fg: c.dangerText } : tone === 'success' ? { bg: c.successTint, fg: c.successText } : { bg: c.primaryTint, fg: c.text }
  return (
    <View accessibilityRole="alert" testID={testID} style={[styles.box, { backgroundColor: look.bg }]}>
      <Text style={[typeScale.body, { color: look.fg }]}>{children}</Text>
    </View>
  )
}
const styles = StyleSheet.create({ box: { borderRadius: radius.md, padding: spacing.md } })
