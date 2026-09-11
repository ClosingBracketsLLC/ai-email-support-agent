import { render, screen } from '@testing-library/react-native'
import * as SplashScreen from 'expo-splash-screen'
import RootLayout from '../app/_layout'

// `_layout.tsx` calls preventAutoHideAsync() at MODULE scope — i.e. while the import above runs, before any
// `const mock…` in this file is initialised — so the spies are created inside the factory (jest.fn is in
// scope there) and read back through the mocked module rather than closed over.
jest.mock('expo-splash-screen', () => ({ preventAutoHideAsync: jest.fn(async () => true), hideAsync: jest.fn(async () => {}) }))
const mockPrevent = SplashScreen.preventAutoHideAsync as jest.Mock
const mockHide = SplashScreen.hideAsync as jest.Mock

// Read lazily during render (after this file's top level has run), so a plain `let` is safe here.
let mockFonts: { ready: boolean } = { ready: false }
jest.mock('@/lib/fonts', () => ({ useBrandFonts: () => mockFonts }))
jest.mock('@/components/providers', () => ({ Providers: ({ children }: { children: unknown }) => children }))
jest.mock('expo-router/stack', () => {
  // `require` (not an outer-scope import) because a jest.mock factory can only close over `mock`-prefixed
  // bindings — this keeps the factory fully self-contained, same reasoning as the SplashScreen spies above.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Text } = require('react-native')
  return { Stack: () => React.createElement(Text, { testID: 'stack' }, 'stack') }
})

test('holds the splash and renders nothing until the fonts are ready, then hides it once', async () => {
  expect(mockPrevent).toHaveBeenCalledTimes(1)             // module scope: ran on import
  mockFonts = { ready: false }
  const view = await render(<RootLayout />)
  expect(screen.queryByTestId('stack')).toBeNull()
  expect(view.toJSON()).toBeNull()
  expect(mockHide).not.toHaveBeenCalled()

  mockFonts = { ready: true }
  await view.rerender(<RootLayout />)
  expect(screen.getByTestId('stack')).toBeTruthy()
  expect(mockHide).toHaveBeenCalledTimes(1)

  await view.rerender(<RootLayout />)
  expect(mockHide).toHaveBeenCalledTimes(1)
})
