import { Text, type TextProps } from 'react-native'
import { typeScale, useColors } from '@/theme'

export function Title(p: TextProps) { const c = useColors(); return <Text accessibilityRole="header" {...p} style={[typeScale.title, { color: c.text }, p.style]} /> }
export function Heading(p: TextProps) { const c = useColors(); return <Text accessibilityRole="header" {...p} style={[typeScale.heading, { color: c.text }, p.style]} /> }
export function Body(p: TextProps) { const c = useColors(); return <Text {...p} style={[typeScale.body, { color: c.text }, p.style]} /> }
export function Muted(p: TextProps) { const c = useColors(); return <Text {...p} style={[typeScale.caption, { color: c.muted }, p.style]} /> }
