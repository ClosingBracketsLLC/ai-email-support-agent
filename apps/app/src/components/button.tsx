import { ActivityIndicator, Pressable, StyleSheet, Text } from 'react-native'
import { radius, spacing, typeScale, useColors } from '@/theme'

export interface ButtonProps { label: string; onPress: () => void; variant?: 'primary' | 'secondary' | 'danger'; loading?: boolean; disabled?: boolean; testID?: string }

export function Button({ label, onPress, variant = 'primary', loading = false, disabled = false, testID }: ButtonProps) {
  const c = useColors()
  const inactive = disabled || loading
  const bg = variant === 'primary' ? c.primary : variant === 'danger' ? c.danger : c.surface
  const fg = variant === 'secondary' ? c.text : variant === 'danger' ? c.onDanger : c.onPrimary
  return (
    <Pressable
      role="button" accessibilityLabel={label} accessibilityState={{ disabled: inactive, busy: loading }} disabled={inactive} onPress={onPress} testID={testID}
      style={({ pressed }) => [styles.base, { backgroundColor: bg, borderColor: variant === 'secondary' ? c.border : bg, opacity: inactive ? 0.6 : pressed ? 0.85 : 1 }]}
    >
      {loading ? <ActivityIndicator color={fg} /> : <Text style={[typeScale.bodyStrong, { color: fg }]}>{label}</Text>}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  base: { minHeight: 48, paddingHorizontal: spacing.lg, borderRadius: radius.md, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
})
