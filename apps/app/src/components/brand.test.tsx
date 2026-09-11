import { BRAND } from '@aesa/contracts'
import { render, screen } from '@testing-library/react-native'
import { palettes } from '@/theme'
import { Lockup, Mark, Wordmark } from './brand'

// RNTL 14 removed UNSAFE_getByType/UNSAFE_getAllByType (Test Renderer only renders host elements), and the
// real host <RNSVGPath> carries `fill` as a processed brush object rather than the string a component
// passed — so `react-native-svg` is mocked with plain Views that keep every prop verbatim, read back off
// getByTestId. See apps/app/src/test-utils/svg-mock.ts.
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('react-native-svg', () => require('@/test-utils/svg-mock').mockReactNativeSvg())

test('Mark: the derived path, tight box, the theme primary, 16 px minimum honoured by the caller (default 24)', async () => {
  await render(<Mark />)
  const svg = screen.getByTestId('brand-mark')
  expect(svg.props.viewBox).toBe(BRAND.paths.mark.viewBox)
  expect(svg.props.height).toBe(24)
  expect(svg.props.width).toBeCloseTo(24 * (1277 / 918), 6)
  expect(svg.props.accessibilityLabel).toBe('aesa')
  const path = screen.getByTestId('svg-path')
  expect(path.props.d).toBe(BRAND.paths.mark.d)
  expect(path.props.fill).toBe(palettes.light.primary)
})

test('Wordmark: the derived path in the text colour', async () => {
  await render(<Wordmark height={20} />)
  const svg = screen.getByTestId('brand-wordmark')
  expect(svg.props.viewBox).toBe(BRAND.paths.wordmark.viewBox)
  expect(svg.props.width).toBeCloseTo(20 * (3383 / 920), 6)
  expect(screen.getByTestId('svg-path').props.fill).toBe(palettes.light.text)
})

test('Lockup: the SAME geometry as brand/lockup-horizontal.svg — two groups with the generated transforms', async () => {
  await render(<Lockup height={30} />)
  const svg = screen.getByTestId('brand-lockup')
  const l = BRAND.paths.lockupHorizontal
  expect(svg.props.viewBox).toBe(l.viewBox)
  expect(svg.props.height).toBe(30)
  expect(svg.props.width).toBeCloseTo(30 * (l.width / l.height), 6)
  const groups = screen.getAllByTestId('svg-g')
  expect(groups.map((g) => g.props.transform)).toEqual([l.markTransform, l.wordmarkTransform])
  const paths = screen.getAllByTestId('svg-path')
  expect(paths.map((p) => [p.props.d, p.props.fill])).toEqual([[BRAND.paths.mark.d, palettes.light.primary], [BRAND.paths.wordmark.d, palettes.light.text]])
})
