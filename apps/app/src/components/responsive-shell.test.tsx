import { fireEvent, render, screen, within } from '@testing-library/react-native'
import { font } from '@/theme'
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
  const { View: RNView } = jest.requireActual('react-native')
  // Renders its children (the <Tabs.Screen>s below) rather than swallowing them — needed so the
  // tabBarLabel-calling Tabs.Screen mock (below) actually mounts and runs.
  function Tabs({ children }: { children?: unknown }) {
    ReactActual.useEffect(() => {
      mockMounts += 1
      return () => { mockUnmounts += 1 }
    }, [])
    return children ?? null
  }
  // The real Tabs.Screen renders nothing — it only registers `options` with the navigator, so nothing
  // exercises a caller-supplied `tabBarLabel` by default. To prove finding 3's weight cue (the only
  // surviving second channel besides colour now that the outline/filled icon pair is gone), call it
  // here the way react-navigation would — `focused` keyed on this mock's own fixed active tab, 'inbox'
  // (matches the mocked `usePathname` above) — and render the result under a testID keyed by screen
  // name so a test can find it without colliding with the Sidebar's own "Inbox"/"Activity"/"Settings"
  // text. This proves the label CAN carry the weight cue when react-navigation calls it focused; it
  // does not prove react-navigation actually calls it with `focused: true` for the active tab — that
  // wiring is react-navigation's own, untested here.
  // A typed callback param inside this factory trips babel-plugin-jest-hoist's out-of-scope-variable
  // scan (it mis-scopes the destructured TS parameter name as a real reference); `any` sidesteps the
  // parser without weakening runtime behaviour.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Tabs.Screen = ({ name, options }: any) => {
    if (typeof options?.tabBarLabel !== 'function') return null
    return ReactActual.createElement(
      RNView,
      { testID: `tab-label-${name}` },
      options.tabBarLabel({ focused: name === 'inbox', color: '#000', position: 'below-icon', children: options.title }),
    )
  }
  return { Tabs }
})

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
  expect(screen.getByTestId('brand-lockup')).toBeTruthy()
  expect(screen.getAllByTestId('icon-inbox').length).toBeGreaterThanOrEqual(1)
  // finding 2: `primary` text on `primaryTint` is 4.46, below AA — the active row's label is `c.text`
  // at `typeScale.bodyStrong` instead (14.78), carrying the weight cue `font.uiStrong` names.
  expect(within(screen.getByTestId('nav-inbox')).getByText('Inbox')).toHaveStyle({ fontFamily: font.uiStrong })
  expect(within(screen.getByTestId('nav-settings')).getByText('Settings')).not.toHaveStyle({ fontFamily: font.uiStrong })

  mockDims = { width: 400, height: 800, scale: 1, fontScale: 1 }
  await view.rerender(<ResponsiveShell />)
  expect(mockMounts).toBe(1)
  expect(mockUnmounts).toBe(0)
  expect(screen.queryByTestId('nav-inbox')).toBeNull()
  expect(screen.queryByTestId('brand-lockup')).toBeNull()
})

test('while wide, pressing a sidebar item navigates with router.push (Link asChild crashed on web)', async () => {
  mockDims = { width: 1200, height: 800, scale: 1, fontScale: 1 }
  await render(<ResponsiveShell />)

  fireEvent.press(screen.getByTestId('nav-settings'))

  expect(mockPush).toHaveBeenCalledWith('/settings')
})

// finding 3: the mocked Tabs.Screen above calls each screen's own `options.tabBarLabel` the way
// react-navigation would (see that mock's comment for exactly what this does and does not prove).
// This proves the weight cue exists in what the shell hands react-navigation, i.e. that a focused
// call renders `font.uiStrong` and an unfocused one does not — not that react-navigation calls it
// with `focused: true` for the active tab (that wiring is react-navigation's own).
test('the tab bar label carries a weight cue when called focused — the second channel besides colour (WCAG 1.4.1)', async () => {
  await render(<ResponsiveShell />)

  expect(within(screen.getByTestId('tab-label-inbox')).getByText('Inbox')).toHaveStyle({ fontFamily: font.uiStrong })
  expect(within(screen.getByTestId('tab-label-activity')).getByText('Activity')).not.toHaveStyle({ fontFamily: font.uiStrong })
  expect(within(screen.getByTestId('tab-label-settings')).getByText('Settings')).not.toHaveStyle({ fontFamily: font.uiStrong })
})
