import { BRAND } from '@aesa/contracts'
import { font, palettes, radius, spacing, typeScale } from './theme'

test('every palette value is a brand token of its own theme, and both themes share one key set', () => {
  const light = new Set<string>(Object.values(BRAND.light))
  const dark = new Set<string>(Object.values(BRAND.dark))
  // Jest's `expect()` takes exactly one argument (no vitest-style message param), so each assertion
  // below carries its own diagnostic in a comment rather than a second argument.
  for (const [, v] of Object.entries(palettes.light)) expect(light.has(v)).toBe(true) // every light.<k> = <v> must be a light-theme token
  for (const [, v] of Object.entries(palettes.dark)) expect(dark.has(v)).toBe(true) // every dark.<k> = <v> must be a dark-theme token
  expect(Object.keys(palettes.dark)).toEqual(Object.keys(palettes.light))
})

test('roles map to the documented tokens', () => {
  expect(palettes.light).toMatchObject({ bg: BRAND.light.paper, surface: BRAND.light.mist, text: BRAND.light.ink, muted: BRAND.light.slate, border: BRAND.light.line, primary: BRAND.light.primary, primaryTint: BRAND.light.primaryTint, onPrimary: BRAND.light.primaryOn })
  expect(palettes.dark).toMatchObject({ bg: BRAND.dark.night, surface: BRAND.dark.nightSurface, text: BRAND.dark.paperOnNight, muted: BRAND.dark.slateOnNight, border: BRAND.dark.lineOnNight, primary: BRAND.dark.lifted, primaryTint: BRAND.dark.liftedTint, onPrimary: BRAND.dark.liftedOn })
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
