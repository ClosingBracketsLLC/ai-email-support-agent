import { BRAND } from '@aesa/contracts'
import { render, screen } from '@testing-library/react-native'
import { ICON_NAMES, Icon } from './icon'

// See brand.test.tsx: RNTL 14 removed UNSAFE_getByType/UNSAFE_getAllByType, so react-native-svg is mocked
// with plain Views that keep every prop verbatim (apps/app/src/test-utils/svg-mock.ts).
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('react-native-svg', () => require('@/test-utils/svg-mock').mockReactNativeSvg())

test('the eight product icons, in name order', () => {
  expect(ICON_NAMES).toEqual(['activity', 'agent', 'approve', 'hold', 'inbox', 'reply', 'send', 'settings'])
})

test.each(ICON_NAMES)('%s: 24 grid, 2-unit round stroke, no fill, one <Path> per source path', async (name) => {
  await render(<Icon name={name} color="#123456" size={20} />)
  const svg = screen.getByTestId(`icon-${name}`)
  expect(svg.props).toMatchObject({ viewBox: '0 0 24 24', width: 20, height: 20, fill: 'none', stroke: '#123456', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' })
  expect(screen.getAllByTestId('svg-path').map((p) => p.props.d)).toEqual([...BRAND.icons[name]])
})
