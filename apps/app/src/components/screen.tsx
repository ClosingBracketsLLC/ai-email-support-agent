import type { ReactNode } from 'react'
import { ScrollView, StyleSheet, View, useWindowDimensions } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { WIDE_BREAKPOINT, spacing, useColors } from '@/theme'

/** Every screen body: safe area, scroll, and a centered 560px column once the window is wide. */
export function Screen({ children, testID }: { children: ReactNode; testID?: string }) {
  const c = useColors()
  const { width } = useWindowDimensions()
  const wide = width >= WIDE_BREAKPOINT
  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: c.bg }]} testID={testID}>
      <ScrollView contentContainerStyle={[styles.content, wide && styles.wide]} keyboardShouldPersistTaps="handled">
        <View style={styles.column}>{children}</View>
      </ScrollView>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  content: { padding: spacing.md, gap: spacing.md },
  wide: { alignItems: 'center', paddingTop: spacing.xl },
  column: { width: '100%', maxWidth: 560, gap: spacing.md },
})
