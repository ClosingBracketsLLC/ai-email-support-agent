import { Fraunces_500Medium, Fraunces_600SemiBold } from '@expo-google-fonts/fraunces'
import { PlusJakartaSans_400Regular, PlusJakartaSans_500Medium, PlusJakartaSans_600SemiBold } from '@expo-google-fonts/plus-jakarta-sans'
import { useFonts } from 'expo-font'

/** The five faces the theme's `font` names (src/theme.ts) — bundled assets, so loading never touches the network. */
export const BRAND_FONTS = { Fraunces_500Medium, Fraunces_600SemiBold, PlusJakartaSans_400Regular, PlusJakartaSans_500Medium, PlusJakartaSans_600SemiBold }

/** `ready` once the faces are registered OR loading failed: a font may never keep the app off the screen — on error the platform fallback renders. */
export function useBrandFonts(): { ready: boolean; error: Error | null } {
  const [loaded, error] = useFonts(BRAND_FONTS)
  return { ready: loaded || error !== null, error }
}
