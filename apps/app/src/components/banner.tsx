import { StyleSheet, Text, View } from 'react-native'
import { radius, spacing, typeScale, useColors } from '@/theme'

export function Banner({ tone = 'info', children, testID }: { tone?: 'info' | 'error' | 'success'; children: string; testID?: string }) {
  const c = useColors()
  const color = tone === 'error' ? c.danger : tone === 'success' ? c.success : c.text
  return (
    <View accessibilityRole="alert" testID={testID} style={[styles.box, { backgroundColor: c.primaryTint, borderColor: color }]}>
      <Text style={[typeScale.body, { color }]}>{children}</Text>
    </View>
  )
}
const styles = StyleSheet.create({ box: { borderWidth: 1, borderRadius: radius.md, padding: spacing.md } })
