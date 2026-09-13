import { render, renderHook, screen } from '@testing-library/react-native'
import { Text } from 'react-native'
import { ShareIntentProviderSafe, useShareIntentSafe } from './share-intent'

// Overrides `package.json`'s `moduleNameMapper` (which points `expo-share-intent` at the inert
// test-utils stub) for THIS file only, so the wrapper's own forwarding can be checked against a
// context carrying a real share — jest.mock() takes priority over moduleNameMapper for the specifier
// it registers. `ShareIntentProvider` is a plain passthrough here (this file is about `share-intent.tsx`'s
// OWN forwarding, not `expo-share-intent`'s real provider behavior).
const mockResetShareIntent = jest.fn()
const mockShareIntent = { webUrl: 'https://example.com', text: null, files: null, type: 'weburl' as const, meta: null }
let mockHasShareIntent = true
jest.mock('expo-share-intent', () => ({
  useShareIntentContext: () => ({ hasShareIntent: mockHasShareIntent, shareIntent: mockShareIntent, resetShareIntent: mockResetShareIntent, isReady: true, error: null }),
  ShareIntentProvider: ({ children }: { children: unknown }) => children,
}))

beforeEach(() => {
  mockHasShareIntent = true
  mockResetShareIntent.mockClear()
})

test('forwards hasShareIntent and shareIntent straight from the real context', async () => {
  const { result } = await renderHook(() => useShareIntentSafe())
  expect(result.current.hasShareIntent).toBe(true)
  expect(result.current.shareIntent).toEqual(mockShareIntent)
})

test('nothing shared forwards as hasShareIntent: false', async () => {
  mockHasShareIntent = false
  const { result } = await renderHook(() => useShareIntentSafe())
  expect(result.current.hasShareIntent).toBe(false)
})

test('resetShareIntent calls through to the context\'s own reset', async () => {
  const { result } = await renderHook(() => useShareIntentSafe())
  result.current.resetShareIntent()
  expect(mockResetShareIntent).toHaveBeenCalledTimes(1)
})

test('ShareIntentProviderSafe renders its children through the real ShareIntentProvider', async () => {
  await render(<ShareIntentProviderSafe><Text>inside</Text></ShareIntentProviderSafe>)
  expect(screen.getByText('inside')).toBeTruthy()
})
