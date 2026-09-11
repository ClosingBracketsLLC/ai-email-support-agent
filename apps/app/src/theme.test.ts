import { BRAND } from '@aesa/contracts'
import { font, palettes, radius, spacing, typeScale } from './theme'

test('every palette value is a brand token of its own theme, and both themes share one key set', () => {
  const light = new Set<string>(Object.values(BRAND.light))
  const dark = new Set<string>(Object.values(BRAND.dark))
  // A failure here names the offending key rather than just reporting a boolean.
  expect(Object.entries(palettes.light).filter(([, v]) => !light.has(v))).toEqual([])
  expect(Object.entries(palettes.dark).filter(([, v]) => !dark.has(v))).toEqual([])
  expect(Object.keys(palettes.dark)).toEqual(Object.keys(palettes.light))
})

test('roles map to the documented tokens', () => {
  const L = BRAND.light
  const D = BRAND.dark
  expect(palettes.light).toMatchObject({
    bg: L.paper, surface: L.mist, text: L.ink, muted: L.slate, border: L.line, primary: L.primary, primaryTint: L.primaryTint, onPrimary: L.primaryOn,
    success: L.success, successTint: L.successTint, successText: L.successText, successSolid: L.successSolid, onSuccess: L.successOn,
    warning: L.warning, warningTint: L.warningTint, warningText: L.warningText, onWarning: L.warningOn,
    danger: L.danger, dangerTint: L.dangerTint, dangerText: L.dangerText, onDanger: L.dangerOn,
  })
  expect(palettes.dark).toMatchObject({
    bg: D.night, surface: D.nightSurface, text: D.paperOnNight, muted: D.slateOnNight, border: D.lineOnNight, primary: D.lifted, primaryTint: D.liftedTint, onPrimary: D.liftedOn,
    success: D.success, successTint: D.successTint, successText: D.successText, successSolid: D.successSolid, onSuccess: D.successOn,
    warning: D.warning, warningTint: D.warningTint, warningText: D.warningText, onWarning: D.warningOn,
    danger: D.danger, dangerTint: D.dangerTint, dangerText: D.dangerText, onDanger: D.dangerOn,
  })
})

test('the type scale names a family per weight and never a fontWeight', () => {
  const families = new Set<string>(Object.values(font))
  for (const [, style] of Object.entries(typeScale)) {
    expect(style).not.toHaveProperty('fontWeight')
    expect(families.has((style as { fontFamily: string }).fontFamily)).toBe(true)
  }
  expect(typeScale.title).toEqual({ fontFamily: 'Fraunces_600SemiBold', fontSize: 28, lineHeight: 34, letterSpacing: -0.28 })
  expect(typeScale.heading).toEqual({ fontFamily: 'PlusJakartaSans_600SemiBold', fontSize: 20, lineHeight: 26 })
  expect(typeScale.body).toEqual({ fontFamily: 'PlusJakartaSans_400Regular', fontSize: 15, lineHeight: 22 })
  expect(typeScale.bodyStrong).toEqual({ fontFamily: 'PlusJakartaSans_600SemiBold', fontSize: 15, lineHeight: 22 })
  expect(typeScale.caption).toEqual({ fontFamily: 'PlusJakartaSans_400Regular', fontSize: 13, lineHeight: 18 })
  expect(typeScale.label).toEqual({ fontFamily: 'PlusJakartaSans_600SemiBold', fontSize: 12, lineHeight: 16, letterSpacing: 0.72, textTransform: 'uppercase' })
})

test('spacing and radius come from the tokens', () => {
  expect(spacing).toEqual(BRAND.spacing)
  expect(radius).toEqual(BRAND.radius)
})
