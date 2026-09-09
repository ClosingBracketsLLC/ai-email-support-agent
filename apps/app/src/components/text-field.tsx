import { StyleSheet, Text, TextInput, View, type TextInputProps } from 'react-native'
import { radius, spacing, typeScale, useColors } from '@/theme'

export interface TextFieldProps extends TextInputProps { label: string; error?: string | null; hint?: string }

export function TextField({ label, error, hint, style, ...input }: TextFieldProps) {
  const c = useColors()
  return (
    <View style={styles.wrap}>
      <Text style={[typeScale.caption, { color: c.muted }]}>{label}</Text>
      <TextInput
        accessibilityLabel={label} placeholderTextColor={c.muted}
        style={[styles.input, typeScale.body, { color: c.text, borderColor: error ? c.danger : c.border, backgroundColor: c.bg }, style]}
        {...input}
      />
      {error ? <Text style={[typeScale.caption, { color: c.danger }]}>{error}</Text> : hint ? <Text style={[typeScale.caption, { color: c.muted }]}>{hint}</Text> : null}
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.xs },
  input: { minHeight: 48, borderWidth: 1, borderRadius: radius.md, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
})
