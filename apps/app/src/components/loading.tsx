import { ActivityIndicator, StyleSheet, View } from 'react-native'
import { useColors } from '@/theme'

export function Loading({ testID = 'loading' }: { testID?: string }) {
  const c = useColors()
  return <View testID={testID} style={[styles.box, { backgroundColor: c.bg }]}><ActivityIndicator color={c.primary} /></View>
}
const styles = StyleSheet.create({ box: { flex: 1, alignItems: 'center', justifyContent: 'center' } })
