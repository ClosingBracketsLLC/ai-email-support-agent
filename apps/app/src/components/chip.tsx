import { StyleSheet, Text, View } from 'react-native'
import { radius, spacing, typeScale, useColors } from '@/theme'

export type ChipTone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger'

/**
 * A status pill on the brand tints (spec §3: sent = success, on hold = warning, blocked = danger). The
 * text is always the tone's darker `*Text` shade — never the base hue on its own tint, which fails AA
 * (primary on primaryTint is 4.46; brand/test/contrast.test.ts). `primary` chips use the ink text.
 */
export function Chip({ tone = 'neutral', children, testID }: { tone?: ChipTone; children: string; testID?: string }) {
  const c = useColors()
  const look = tone === 'neutral' ? { bg: c.surface, fg: c.text, border: c.border }
    : tone === 'primary' ? { bg: c.primaryTint, fg: c.text, border: c.primary }
    : tone === 'success' ? { bg: c.successTint, fg: c.successText, border: c.successTint }
    : tone === 'warning' ? { bg: c.warningTint, fg: c.warningText, border: c.warningTint }
    : { bg: c.dangerTint, fg: c.dangerText, border: c.dangerTint }
  return (
    <View testID={testID} accessibilityLabel={children} style={[styles.chip, { backgroundColor: look.bg, borderColor: look.border }]}>
      <Text style={[typeScale.caption, { color: look.fg }]}>{children}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  chip: { alignSelf: 'flex-start', borderWidth: 1, borderRadius: radius.pill, paddingHorizontal: spacing.sm, paddingVertical: 2 },
})
