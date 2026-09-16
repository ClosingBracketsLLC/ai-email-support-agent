import type { ReactNode } from 'react'

export interface ShareIntentSafeState {
  hasShareIntent: boolean
  shareIntent: null
  resetShareIntent: () => void
}

const WEB_STATE: ShareIntentSafeState = { hasShareIntent: false, shareIntent: null, resetShareIntent() {} }

/**
 * The web half of the `expo-share-intent` seam — see `share-intent.tsx` for the native half and why
 * this is split into two files rather than one file with a runtime `Platform.OS` branch. This file
 * imports NOTHING from `expo-share-intent`, so Metro's platform-extension resolution (picking THIS
 * file over `share-intent.tsx` for a web build) makes it structurally impossible for the package's
 * native-module require to reach the browser — a runtime branch alone still left the import
 * statement, and the package's own top-level `require()`/`createContext()` calls, in the ONE shared
 * web entry chunk every route loads, even though the branch itself was dead-code-eliminated.
 *
 * Sharing into aesa only ever works from the iOS/Android apps — `ShareScreen`'s own
 * `Platform.OS === 'web'` branch is what actually tells the owner that, and it returns before calling
 * this hook at all. This file exists so that IF something ever did call it on web, the answer is this
 * safe, inert one rather than a crash.
 */
export function useShareIntentSafe(): ShareIntentSafeState {
  return WEB_STATE
}

/** `_layout.tsx`'s web half: nothing to provide, so just render `children` — see `share-intent.tsx`
 * for why `_layout.tsx` reads this through `@/lib/share-intent` at all rather than importing
 * `ShareIntentProvider` from `expo-share-intent` directly. */
export function ShareIntentProviderSafe({ children }: { children: ReactNode }) {
  return children
}
