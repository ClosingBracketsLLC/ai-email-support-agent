import { render, screen } from '@testing-library/react-native'
import { palettes } from '@/theme'
import { Chip } from './chip'

const L = palettes.light
test.each([
  ['neutral', L.surface, L.text, L.border],
  ['primary', L.primaryTint, L.text, L.primary],
  ['success', L.successTint, L.successText, L.successTint],
  ['warning', L.warningTint, L.warningText, L.warningTint],
  ['danger', L.dangerTint, L.dangerText, L.dangerTint],
] as const)('%s chip: tint background, the tone\'s text shade (never primary-on-tint), pill radius', async (tone, bg, fg, border) => {
  await render(<Chip tone={tone} testID="chip">On hold</Chip>)
  expect(screen.getByTestId('chip')).toHaveStyle({ backgroundColor: bg, borderColor: border, borderRadius: 999 })
  expect(screen.getByText('On hold')).toHaveStyle({ color: fg })
  expect(screen.getByLabelText('On hold')).toBeTruthy()
})
