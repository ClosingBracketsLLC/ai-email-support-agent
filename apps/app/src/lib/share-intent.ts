import { useShareIntentContext, type ShareIntent } from 'expo-share-intent'
import { Platform } from 'react-native'

export interface ShareIntentSafeState {
  hasShareIntent: boolean
  shareIntent: ShareIntent | null
  resetShareIntent: () => void
}

const WEB_STATE: ShareIntentSafeState = { hasShareIntent: false, shareIntent: null, resetShareIntent() {} }

/**
 * The ONE seam between this app and `expo-share-intent`'s native module (task brief's Step 2):
 * every caller reads a share intent through here, never the package directly. `expo-share-intent`
 * has no web build and cannot run inside Expo Go — it needs the config plugin's generated share
 * extension plus a dev/EAS build (`app.json`, this task's commit) — so `<ShareIntentProvider>`
 * (`src/app/_layout.tsx`) only ever wraps the NATIVE tree, and `useShareIntentContext()` throws
 * outside that provider. Routing through this thin wrapper, rather than the package's hooks
 * directly, is what lets both the web bundle and every jest test stay ignorant of that split:
 * `share.test.tsx` mocks this module, not `expo-share-intent` itself.
 *
 * `Platform.OS` is fixed for the whole life of a running process — never a value that changes
 * between renders of the SAME component instance — so branching before the hook call below is safe
 * despite reading like a conditional hook.
 */
export function useShareIntentSafe(): ShareIntentSafeState {
  if (Platform.OS === 'web') return WEB_STATE
  const { hasShareIntent, shareIntent, resetShareIntent } = useShareIntentContext()
  return { hasShareIntent, shareIntent, resetShareIntent: () => resetShareIntent() }
}
