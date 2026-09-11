import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { contrast, round2 } from './wcag.ts'

const tokens = JSON.parse(readFileSync(new URL('../tokens.json', import.meta.url), 'utf8'))
const L = tokens.light as Record<string, string>
const D = tokens.dark as Record<string, string>

/** [name, text, background, ground, pinned ratio, floor]. The floor is 4.5 (AA body) unless the pair is documented as large text (3.0). */
const LIGHT: [string, string, string, number, number][] = [
  ['primary on paper', L.primary!, L.paper!, 5.17, 4.5],
  ['ink on paper', L.ink!, L.paper!, 17.14, 4.5],
  ['slate on paper', L.slate!, L.paper!, 5.4, 4.5],
  ['ink on mist', L.ink!, L.mist!, 15.83, 4.5],
  ['slate on mist', L.slate!, L.mist!, 4.99, 4.5],
  ['primary on mist', L.primary!, L.mist!, 4.77, 4.5],
  ['ink on primaryTint (chips, selected cards)', L.ink!, L.primaryTint!, 14.78, 4.5],
  ['slate on primaryTint', L.slate!, L.primaryTint!, 4.66, 4.5],
  ['primary on primaryTint — LARGE TEXT ONLY', L.primary!, L.primaryTint!, 4.46, 3.0],
  ['primaryOn on primary (buttons)', L.primaryOn!, L.primary!, 5.17, 4.5],
  ['successText on successTint', L.successText!, L.successTint!, 4.54, 4.5],
  ['successText on paper', L.successText!, L.paper!, 5.35, 4.5],
  ['successOn on successSolid (solid success buttons use the darker green)', L.successOn!, L.successSolid!, 5.35, 4.5],
  ['warningText on warningTint', L.warningText!, L.warningTint!, 6.3, 4.5],
  ['warningText on paper', L.warningText!, L.paper!, 7.09, 4.5],
  ['warningOn (ink) on warning', L.warningOn!, L.warning!, 7.98, 4.5],
  ['dangerText on dangerTint', L.dangerText!, L.dangerTint!, 5.14, 4.5],
  ['dangerText on paper', L.dangerText!, L.paper!, 6.29, 4.5],
  ['dangerOn on danger', L.dangerOn!, L.danger!, 4.7, 4.5],
]

const DARK: [string, string, string, number, number][] = [
  ['paperOnNight on night', D.paperOnNight!, D.night!, 16.65, 4.5],
  ['paperOnNight on nightSurface', D.paperOnNight!, D.nightSurface!, 14.23, 4.5],
  ['slateOnNight on night', D.slateOnNight!, D.night!, 8.96, 4.5],
  ['slateOnNight on nightSurface', D.slateOnNight!, D.nightSurface!, 7.66, 4.5],
  ['lifted on night', D.lifted!, D.night!, 9.11, 4.5],
  ['lifted on nightSurface', D.lifted!, D.nightSurface!, 7.78, 4.5],
  ['liftedOn on lifted (buttons)', D.liftedOn!, D.lifted!, 9.11, 4.5],
  ['paperOnNight on liftedTint (chips)', D.paperOnNight!, D.liftedTint!, 13.59, 4.5],
  ['lifted on liftedTint', D.lifted!, D.liftedTint!, 7.43, 4.5],
  ['successText on successTint', D.successText!, D.successTint!, 8.49, 4.5],
  ['successText on night', D.successText!, D.night!, 9.74, 4.5],
  ['warningText on warningTint', D.warningText!, D.warningTint!, 9.36, 4.5],
  ['warningText on night', D.warningText!, D.night!, 11.22, 4.5],
  ['dangerText on dangerTint', D.dangerText!, D.dangerTint!, 6.51, 4.5],
  ['dangerText on night', D.dangerText!, D.night!, 6.96, 4.5],
  ['dangerOn on danger', D.dangerOn!, D.danger!, 4.7, 4.5],
  ['successOn on successSolid', D.successOn!, D.successSolid!, 5.35, 4.5],
]

describe('light theme pairs', () => {
  it.each(LIGHT)('%s', (_name, text, bg, pinned, floor) => {
    const ratio = round2(contrast(text, bg, L.paper!))
    expect(ratio).toBe(pinned)
    expect(ratio).toBeGreaterThanOrEqual(floor)
  })
})

describe('dark theme pairs (tints composited over night)', () => {
  it.each(DARK)('%s', (_name, text, bg, pinned, floor) => {
    const ratio = round2(contrast(text, bg, D.night!))
    expect(ratio).toBe(pinned)
    expect(ratio).toBeGreaterThanOrEqual(floor)
  })
})

describe('the numbers the spec calls out by name', () => {
  it('white on the base green is why solid success buttons use the darker shade', () => {
    expect(round2(contrast('#FFFFFF', L.success!, L.paper!))).toBe(3.39)
  })
  it('the light theme has exactly the documented keys', () => {
    expect(Object.keys(L).sort()).toEqual([
      'danger', 'dangerOn', 'dangerText', 'dangerTint', 'ink', 'line', 'mist', 'paper', 'primary', 'primaryOn', 'primaryTint',
      'slate', 'success', 'successOn', 'successSolid', 'successText', 'successTint', 'warning', 'warningOn', 'warningText', 'warningTint',
    ])
  })
  it('the dark theme has exactly the documented keys', () => {
    expect(Object.keys(D).sort()).toEqual([
      'danger', 'dangerOn', 'dangerText', 'dangerTint', 'lifted', 'liftedOn', 'liftedTint', 'lineOnNight', 'night', 'nightSurface',
      'paperOnNight', 'slateOnNight', 'success', 'successOn', 'successSolid', 'successText', 'successTint', 'warning', 'warningOn',
      'warningText', 'warningTint',
    ])
  })
})
