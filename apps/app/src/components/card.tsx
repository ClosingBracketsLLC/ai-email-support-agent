import type { ReactNode } from 'react'
import { StyleSheet, View } from 'react-native'
import { radius, spacing, useColors } from '@/theme'

export function Card({ children, testID }: { children: ReactNode; testID?: string }) {
  const c = useColors()
  return <View testID={testID} style={[styles.card, { backgroundColor: c.surface, borderColor: c.border }]}>{children}</View>
}
const styles = StyleSheet.create({ card: { borderWidth: 1, borderRadius: radius.lg, padding: spacing.md, gap: spacing.sm } })
