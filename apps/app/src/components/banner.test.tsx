import { render, screen } from '@testing-library/react-native'
import { palettes } from '@/theme'
import { Banner } from './banner'

const L = palettes.light

test.each([
  ['info', L.primaryTint, L.text],
  ['success', L.successTint, L.successText],
  ['warning', L.warningTint, L.warningText],
  ['error', L.dangerTint, L.dangerText],
] as const)('%s banner: the tone\'s tint background and its own text shade', async (tone, bg, fg) => {
  await render(<Banner tone={tone} testID="banner">Something happened</Banner>)
  expect(screen.getByTestId('banner')).toHaveStyle({ backgroundColor: bg })
  expect(screen.getByText('Something happened')).toHaveStyle({ color: fg })
})

test('defaults to the info tone and announces itself as an alert', async () => {
  await render(<Banner testID="banner">Something happened</Banner>)
  expect(screen.getByTestId('banner')).toHaveStyle({ backgroundColor: L.primaryTint })
  expect(screen.getByTestId('banner').props.accessibilityRole).toBe('alert')
})
