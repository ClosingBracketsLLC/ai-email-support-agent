// Each face from its own per-weight subpath, NOT the package barrel — the barrel re-exports all 18
// Fraunces statics and all 7 Plus Jakarta Sans statics (32 .ttf total, 2.9 MB), and a bundler that
// respects the package's module graph (Metro, jest, tsc all do here) pulls in every face the barrel
// imports, not just the five named below. Each subpath ships its own `index.js` + `index.d.ts`.
import { Fraunces_500Medium } from '@expo-google-fonts/fraunces/500Medium'
import { Fraunces_600SemiBold } from '@expo-google-fonts/fraunces/600SemiBold'
import { PlusJakartaSans_400Regular } from '@expo-google-fonts/plus-jakarta-sans/400Regular'
import { PlusJakartaSans_500Medium } from '@expo-google-fonts/plus-jakarta-sans/500Medium'
import { PlusJakartaSans_600SemiBold } from '@expo-google-fonts/plus-jakarta-sans/600SemiBold'
import { useFonts } from 'expo-font'

/** The five faces the theme's `font` names (src/theme.ts) — bundled assets, so loading never touches the network. */
export const BRAND_FONTS = { Fraunces_500Medium, Fraunces_600SemiBold, PlusJakartaSans_400Regular, PlusJakartaSans_500Medium, PlusJakartaSans_600SemiBold }

/** `ready` once the faces are registered OR loading failed: a font may never keep the app off the screen — on error the platform fallback renders. */
export function useBrandFonts(): { ready: boolean; error: Error | null } {
  const [loaded, error] = useFonts(BRAND_FONTS)
  return { ready: loaded || error !== null, error }
}
