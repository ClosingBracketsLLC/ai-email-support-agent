import { renderHook } from '@testing-library/react-native'
import { BRAND_FONTS, useBrandFonts } from './fonts'

const mockUseFonts = jest.fn()
jest.mock('expo-font', () => ({ useFonts: (map: unknown) => mockUseFonts(map) }))

test('registers exactly the five faces the theme names', () => {
  expect(Object.keys(BRAND_FONTS).sort()).toEqual(['Fraunces_500Medium', 'Fraunces_600SemiBold', 'PlusJakartaSans_400Regular', 'PlusJakartaSans_500Medium', 'PlusJakartaSans_600SemiBold'])
})

// This version's `renderHook` is async (it renders through `render` under the hood), so each call is
// awaited before its `.result.current` is read — unlike a synchronous renderHook, awaiting it here
// changes nothing about what is asserted.
test('not ready while loading; ready once loaded; ready (with the error) when loading failed', async () => {
  mockUseFonts.mockReturnValue([false, null])
  expect((await renderHook(() => useBrandFonts())).result.current).toEqual({ ready: false, error: null })
  mockUseFonts.mockReturnValue([true, null])
  expect((await renderHook(() => useBrandFonts())).result.current).toEqual({ ready: true, error: null })
  const err = new Error('no font')
  mockUseFonts.mockReturnValue([false, err])
  expect((await renderHook(() => useBrandFonts())).result.current).toEqual({ ready: true, error: err })
  expect(mockUseFonts).toHaveBeenCalledWith(BRAND_FONTS)
})
