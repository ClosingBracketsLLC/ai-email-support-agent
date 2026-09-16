/**
 * Expo Router's documented seam for rewriting a system URL before it is routed
 * (`redirectSystemPath`, `expo-router/build/types.d.ts` → `NativeIntent`; consulted by
 * `getLinkingConfig.js` for the initial URL and by `link/linking.js` for every later one). This
 * file is deliberately NOT a route: `getRoutesCore.js`'s ignore list drops `./+native-intent.*`
 * from the route table, so the web export stays at 27 routes.
 *
 * Why it exists (ruling R34): `expo-share-intent` reopens the app after an iOS share with
 * `aesa://dataUrl=aesaShareKey` (`expo-share-intent/build/utils.js` builds it, `useShareIntent.js`
 * reads it back off `Linking.useURL()` to fetch the shared payload). Expo Router's own
 * `extractPathFromURL` turns that into the path `dataUrl=aesaShareKey`, which matches no route and
 * renders `+not-found.tsx` — a ROOT route, so `(app)/_layout`'s `Shell` and its
 * `useShareIntentRouting` never mount, and the owner has to tap "Go home" before the share is
 * routed to `/share`. Landing on `/` instead mounts the shell, and the library — which reads the
 * RAW url off expo-linking, untouched by this rewrite — hands the intent to `useShareIntentRouting`
 * as it does on Android.
 *
 * Returning `null` means "no redirect" (the router's contract). Never throws: the docs warn a throw
 * here can crash the app at launch.
 */
export function redirectSystemPath({ path }: { path: string; initial: boolean }): string | null {
  try {
    return typeof path === 'string' && path.includes('dataUrl=') ? '/' : null
  } catch {
    return null
  }
}
