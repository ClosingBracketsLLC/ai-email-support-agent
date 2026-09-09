import { fireEvent, render, screen } from '@testing-library/react-native'
import { ResponsiveShell } from './responsive-shell'

let mockMounts = 0
let mockUnmounts = 0
let mockDims = { width: 400, height: 800, scale: 1, fontScale: 1 }
const mockPush = jest.fn()

jest.mock('expo-router', () => ({
  usePathname: () => '/inbox',
  useRouter: () => ({ push: mockPush }),
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
  mockPush.mockClear()
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

test('while wide, pressing a sidebar item navigates with router.push (Link asChild crashed on web)', async () => {
  mockDims = { width: 1200, height: 800, scale: 1, fontScale: 1 }
  await render(<ResponsiveShell />)

  fireEvent.press(screen.getByTestId('nav-settings'))

  expect(mockPush).toHaveBeenCalledWith('/settings')
})
