import { Pressable, StyleSheet, Text, View } from 'react-native'
import { spacing, typeScale, useColors } from '@/theme'

export interface ListRowProps { title: string; subtitle?: string; badge?: string; onPress?: () => void; testID?: string }

/** A settings-style row. Without onPress it renders inert (used for "arrives with Phase N" placeholders). */
export function ListRow({ title, subtitle, badge, onPress, testID }: ListRowProps) {
  const c = useColors()
  return (
    <Pressable role={onPress ? 'button' : undefined} accessibilityLabel={title} disabled={!onPress} onPress={onPress} testID={testID}
      style={({ pressed }) => [styles.row, { borderColor: c.border, opacity: onPress ? (pressed ? 0.7 : 1) : 0.55 }]}>
      <View style={styles.text}>
        <Text style={[typeScale.body, { color: c.text }]}>{title}</Text>
        {subtitle ? <Text style={[typeScale.caption, { color: c.muted }]}>{subtitle}</Text> : null}
      </View>
      {badge ? <Text style={[typeScale.caption, { color: c.muted }]}>{badge}</Text> : onPress ? <Text style={{ color: c.muted }}>›</Text> : null}
    </Pressable>
  )
}
const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', minHeight: 56, paddingVertical: spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth, gap: spacing.md },
  text: { flex: 1, gap: 2 },
})
