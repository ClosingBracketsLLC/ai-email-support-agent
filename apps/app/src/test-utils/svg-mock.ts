import type { ComponentType, ReactNode } from 'react'

/**
 * A jest.mock factory for `react-native-svg` (RNTL 14 removed UNSAFE_getByType, and the real host
 * <RNSVGPath> carries `fill` as a processed brush object, not the string a component passed). Each
 * element becomes a plain View that keeps EVERY prop it was given, so a test reads `viewBox`, `d`,
 * `fill` and `transform` back off `getByTestId`. Paths and groups get a default testID.
 * Use: `jest.mock('react-native-svg', () => require('@/test-utils/svg-mock').mockReactNativeSvg())`
 */
export function mockReactNativeSvg() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/consistent-type-imports
  const React = require('react') as typeof import('react')
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/consistent-type-imports
  const { View } = require('react-native') as typeof import('react-native')
  const element = (name: string, defaultTestID?: string): ComponentType<Record<string, unknown> & { children?: ReactNode }> => {
    const Mock = (props: Record<string, unknown> & { children?: ReactNode }) =>
      React.createElement(View, { ...props, testID: (props.testID as string | undefined) ?? defaultTestID }, props.children)
    Mock.displayName = name
    return Mock
  }
  const Svg = element('Svg')
  return { __esModule: true, default: Svg, Svg, Path: element('Path', 'svg-path'), G: element('G', 'svg-g') }
}
