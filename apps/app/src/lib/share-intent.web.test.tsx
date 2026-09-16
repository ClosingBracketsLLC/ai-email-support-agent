import { render, screen } from '@testing-library/react-native'
import { Text } from 'react-native'
import { ShareIntentProviderSafe, useShareIntentSafe } from './share-intent.web'

// Imported directly by its `.web` name (the same convention `drop-zone.web.test.tsx` uses) —
// jest-expo's default (non-web) project would otherwise resolve `./share-intent` to the NATIVE file.
// This file's whole point is that it imports nothing from `expo-share-intent`: nothing here mocks
// that package, so a regression that reintroduced such an import would fail this test suite's own
// module load (the mapped mock only hides that regression for `share-intent.tsx`, which this test
// never touches).
test('always reports nothing shared, and reset is a safe no-op', () => {
  const state = useShareIntentSafe()
  expect(state.hasShareIntent).toBe(false)
  expect(state.shareIntent).toBeNull()
  expect(() => state.resetShareIntent()).not.toThrow()
})

test('returns the SAME inert value on every call', () => {
  expect(useShareIntentSafe()).toEqual(useShareIntentSafe())
})

test('ShareIntentProviderSafe renders its children with nothing wrapping them', async () => {
  await render(<ShareIntentProviderSafe><Text>inside</Text></ShareIntentProviderSafe>)
  expect(screen.getByText('inside')).toBeTruthy()
})
