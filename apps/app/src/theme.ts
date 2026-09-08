import { useColorScheme } from 'react-native'

const light = { bg: '#FFFFFF', surface: '#F8FAFC', text: '#0F172A', muted: '#64748B', border: '#E2E8F0', primary: '#2563EB', onPrimary: '#FFFFFF', danger: '#DC2626', success: '#16A34A', info: '#EFF6FF' }
const dark = { bg: '#0F172A', surface: '#1E293B', text: '#F8FAFC', muted: '#94A3B8', border: '#334155', primary: '#60A5FA', onPrimary: '#0F172A', danger: '#F87171', success: '#4ADE80', info: '#1E3A5F' }
export type Colors = typeof light

export const spacing = { xs: 4, sm: 8, md: 16, lg: 24, xl: 32 } as const
export const radius = { sm: 6, md: 10, lg: 16 } as const
export const typeScale = {
  title: { fontSize: 28, fontWeight: '700' as const, lineHeight: 34 },
  heading: { fontSize: 20, fontWeight: '600' as const, lineHeight: 26 },
  body: { fontSize: 16, lineHeight: 22 },
  caption: { fontSize: 13, lineHeight: 18 },
}
/** Tablet landscape and desktop get the sidebar shell; below this it is tabs. */
export const WIDE_BREAKPOINT = 900

export function useColors(): Colors {
  return useColorScheme() === 'dark' ? dark : light
}
