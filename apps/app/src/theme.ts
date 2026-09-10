import { BRAND } from '@aesa/contracts'
import { Platform, useColorScheme } from 'react-native'

const L = BRAND.light
const D = BRAND.dark

/**
 * The theme is a ROLE-keyed view over the brand tokens (brand/tokens.json → BRAND): light uses the
 * spec's light names, dark maps the night/lifted names onto the same roles. theme.test.ts pins that
 * every value here is a token of its theme — a colour that is not in tokens.json cannot appear in the app.
 */
export const palettes = {
  light: {
    bg: L.paper, surface: L.mist, text: L.ink, muted: L.slate, border: L.line,
    primary: L.primary, primaryTint: L.primaryTint, onPrimary: L.primaryOn,
    success: L.success, successTint: L.successTint, successText: L.successText, successSolid: L.successSolid, onSuccess: L.successOn,
    warning: L.warning, warningTint: L.warningTint, warningText: L.warningText, onWarning: L.warningOn,
    danger: L.danger, dangerTint: L.dangerTint, dangerText: L.dangerText, onDanger: L.dangerOn,
  },
  dark: {
    bg: D.night, surface: D.nightSurface, text: D.paperOnNight, muted: D.slateOnNight, border: D.lineOnNight,
    primary: D.lifted, primaryTint: D.liftedTint, onPrimary: D.liftedOn,
    success: D.success, successTint: D.successTint, successText: D.successText, successSolid: D.successSolid, onSuccess: D.successOn,
    warning: D.warning, warningTint: D.warningTint, warningText: D.warningText, onWarning: D.warningOn,
    danger: D.danger, dangerTint: D.dangerTint, dangerText: D.dangerText, onDanger: D.dangerOn,
  },
}
export type Colors = { [K in keyof typeof palettes.light]: string }

/**
 * Family names as expo-font registers the bundled faces (src/lib/fonts.ts): ONE family per weight.
 * Styles never set `fontWeight` — with a single-face family Android fakes the bold and iOS ignores
 * it; name the 600 face instead.
 */
export const font = {
  display: 'Fraunces_600SemiBold',
  displayMedium: 'Fraunces_500Medium',
  ui: 'PlusJakartaSans_400Regular',
  uiMedium: 'PlusJakartaSans_500Medium',
  uiStrong: 'PlusJakartaSans_600SemiBold',
  /** The draft body keeps the platform monospace so whitespace is exact (spec §4). */
  mono: Platform.select({ ios: BRAND.type.mono.ios, android: BRAND.type.mono.android, default: BRAND.type.mono.web }) as string,
} as const

const S = BRAND.type.scale
export const typeScale = {
  title: { fontFamily: font.display, fontSize: S.title.fontSize, lineHeight: S.title.lineHeight, letterSpacing: S.title.fontSize * S.title.letterSpacing },
  heading: { fontFamily: font.uiStrong, fontSize: S.heading.fontSize, lineHeight: S.heading.lineHeight },
  body: { fontFamily: font.ui, fontSize: S.body.fontSize, lineHeight: S.body.lineHeight },
  bodyStrong: { fontFamily: font.uiStrong, fontSize: S.bodyStrong.fontSize, lineHeight: S.bodyStrong.lineHeight },
  caption: { fontFamily: font.ui, fontSize: S.small.fontSize, lineHeight: S.small.lineHeight },
  label: { fontFamily: font.uiStrong, fontSize: S.label.fontSize, lineHeight: S.label.lineHeight, letterSpacing: S.label.fontSize * S.label.letterSpacing, textTransform: 'uppercase' as const },
} as const

export const spacing = BRAND.spacing
export const radius = BRAND.radius
/** Tablet landscape and desktop get the sidebar shell; below this it is tabs. */
export const WIDE_BREAKPOINT = 900

export function useColors(): Colors {
  return useColorScheme() === 'dark' ? palettes.dark : palettes.light
}
