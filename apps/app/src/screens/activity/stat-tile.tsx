import { StyleSheet, Text, View } from 'react-native'
import { radius, spacing, typeScale, useColors } from '@/theme'

export interface StatTileProps {
  label: string
  value: string
  /** The Approved tile's unchanged/edited split (task brief) — every other tile leaves this unset. */
  subtitle?: string
  testID?: string
}

/** One tile in the Activity screen's counts grid. Presentational only — the screen owns every read
 * (tRPC call, `formatUsd`, the unchanged/edited split); this just lays out a label/value/subtitle. */
export function StatTile({ label, value, subtitle, testID }: StatTileProps) {
  const c = useColors()
  return (
    <View testID={testID} style={[styles.tile, { borderColor: c.border, backgroundColor: c.surface }]}>
      <Text style={[typeScale.caption, { color: c.muted }]}>{label}</Text>
      <Text style={[typeScale.heading, styles.value, { color: c.text }]}>{value}</Text>
      {subtitle ? <Text style={[typeScale.caption, { color: c.muted }]}>{subtitle}</Text> : null}
    </View>
  )
}

const styles = StyleSheet.create({
  tile: { flexBasis: '47%', flexGrow: 1, borderWidth: 1, borderRadius: radius.md, padding: spacing.sm, gap: 2 },
  value: { fontWeight: '700' },
})
