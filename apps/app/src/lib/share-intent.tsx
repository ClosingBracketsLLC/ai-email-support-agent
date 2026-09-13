import { ShareIntentProvider, useShareIntentContext, type ShareIntent } from 'expo-share-intent'
import type { ReactNode } from 'react'

export interface ShareIntentSafeState {
  hasShareIntent: boolean
  shareIntent: ShareIntent | null
  resetShareIntent: () => void
}

/**
 * The native half of the `expo-share-intent` seam — `share-intent.web.tsx` is the other. Metro's
 * platform-extension resolution (the SAME mechanism `screens/knowledge/drop-zone.tsx` /
 * `drop-zone.web.tsx` already rely on, `DropZoneProps` duplicated rather than cross-imported between
 * them) picks THIS file for iOS/Android and `share-intent.web.tsx` for a web build — never both — so
 * `expo-share-intent`'s native-module require is structurally excluded from the web bundle, not
 * merely dead-code-eliminated at a runtime branch. A `Platform.OS === 'web'` check here, instead of
 * this file split, still leaves the import statement itself (and the package's own top-level
 * `require()`/`createContext()` calls) in the ONE shared web entry chunk every route loads.
 *
 * BOTH of this package's entry points are re-exported from here rather than one: `_layout.tsx`
 * originally imported `ShareIntentProvider` straight from `expo-share-intent`, unconditionally at
 * the top of a UNIVERSAL file (used by every route) — the `Platform.select` around where it was USED
 * left the import itself, and so the whole package, in the shared web bundle exactly the same way
 * `useShareIntentSafe`'s own runtime branch did (task 10 fix round 1, finding 1's second half — the
 * first split alone was not enough). `ShareIntentProviderSafe` closes that off the same way:
 * `_layout.tsx` now imports it from `@/lib/share-intent` instead, so a web build never even resolves
 * to this file.
 *
 * `useShareIntentContext()` does NOT throw outside a `<ShareIntentProvider>` — the package creates
 * the context with its own default value (no share, nothing pending), so a caller mounted outside the
 * provider just reads that default. The root layout still wraps the native tree in
 * `<ShareIntentProviderSafe>`, on native only, because that default is never populated by a REAL
 * share otherwise — not because omitting the provider would crash.
 */
export function useShareIntentSafe(): ShareIntentSafeState {
  const { hasShareIntent, shareIntent, resetShareIntent } = useShareIntentContext()
  return { hasShareIntent, shareIntent, resetShareIntent: () => resetShareIntent() }
}

export function ShareIntentProviderSafe({ children }: { children: ReactNode }) {
  return <ShareIntentProvider>{children}</ShareIntentProvider>
}
