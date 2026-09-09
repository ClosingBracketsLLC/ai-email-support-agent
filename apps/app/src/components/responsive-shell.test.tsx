import { render, screen } from '@testing-library/react-native'
import type { ReactNode } from 'react'
import { ResponsiveShell } from './responsive-shell'

let mockMounts = 0
let mockUnmounts = 0
let mockDims = { width: 400, height: 800, scale: 1, fontScale: 1 }

jest.mock('expo-router', () => ({
  Link: ({ children }: { children: ReactNode }) => children,
  usePathname: () => '/inbox',
}))

jest.mock('expo-router/js-tabs', () => {
  const ReactActual = jest.requireActual('react')
  function Tabs() {
    ReactActual.useEffect(() => {
      mockMounts += 1
      return () => { mockUnmounts += 1 }
    }, [])
    return null
  }
  Tabs.Screen = () => null
  return { Tabs }
})

jest.mock('@expo/vector-icons/Ionicons', () => () => null)

// Mocking the whole 'react-native' barrel (spreading jest.requireActual('react-native')) forces every one of
// its lazy getters (DevMenu, Clipboard, ProgressBarAndroid, ...) to evaluate eagerly, which throws
// ("TurboModuleRegistry.getEnforcing(...): 'DevMenu' could not be found") in this jest environment. Mocking
// just the internal module useWindowDimensions is re-exported from keeps the rest of react-native's laziness
// intact while still controlling what the hook returns.
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true,
  default: () => mockDims,
}))

beforeEach(() => {
  mockMounts = 0
  mockUnmounts = 0
  mockDims = { width: 400, height: 800, scale: 1, fontScale: 1 }
})

test('the Tabs navigator survives crossing the wide breakpoint — one instance throughout', async () => {
  const view = await render(<ResponsiveShell />)
  expect(mockMounts).toBe(1)
  expect(mockUnmounts).toBe(0)
  expect(screen.queryByTestId('nav-inbox')).toBeNull()

  mockDims = { width: 1200, height: 800, scale: 1, fontScale: 1 }
  await view.rerender(<ResponsiveShell />)
  expect(mockMounts).toBe(1)
  expect(mockUnmounts).toBe(0)
  expect(screen.getByTestId('nav-inbox')).toBeTruthy()

  mockDims = { width: 400, height: 800, scale: 1, fontScale: 1 }
  await view.rerender(<ResponsiveShell />)
  expect(mockMounts).toBe(1)
  expect(mockUnmounts).toBe(0)
  expect(screen.queryByTestId('nav-inbox')).toBeNull()
})
