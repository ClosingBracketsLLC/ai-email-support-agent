import { useRouter, type Href } from 'expo-router'
import { useEffect, useReducer, useRef } from 'react'
import { setNextPath } from './next-path'
import { useShareIntentSafe } from './share-intent'

/** The one thing `pathForShareIntent` needs from a real `ShareIntent` — kept local (rather than
 * importing `expo-share-intent`'s own type) so this pure mapper never pulls the native module's
 * types into anything that reads it, jest included. */
export interface ShareIntentLike {
  webUrl?: string | null
  text?: string | null
  files?: readonly unknown[] | null
}

const SHARE_PATH = '/share' as const

/**
 * Whether a shared intent carries anything worth taking the owner to `/share` for: a link
 * (`webUrl`), non-empty text, or at least one file. The plugin's activation rules (`app.json`) cap a
 * share at exactly one file and text-or-a-page for iOS, one MIME match for Android — but this stays
 * a length check rather than an exact-one check, so a looser rule later still routes correctly.
 */
export function pathForShareIntent(intent: ShareIntentLike | null): '/share' | null {
  if (!intent) return null
  if (intent.webUrl) return SHARE_PATH
  if (intent.text && intent.text.trim()) return SHARE_PATH
  if (intent.files && intent.files.length > 0) return SHARE_PATH
  return null
}

/**
 * Mirrors `usePushRouting`'s cold-start/warm split (`push-routing.ts:83-113`): a share can arrive
 * before anything is mounted — the OS launched the app fresh off a share-sheet tap — in which case
 * there is nowhere to `router.push` to yet. That case is queued through `next-path.ts` instead, the
 * same mechanism `(app)/_layout.tsx` already drains for a push notification's cold-start deep link.
 * A share that arrives while the app is already running (warm — the owner backgrounds the app,
 * shares something else, and the OS brings this app back to the foreground) pushes immediately.
 *
 * Unlike `Notifications.useLastNotificationResponse()`, `useShareIntentSafe()` has no `undefined`
 * "native hasn't reported in yet" state to key cold-start off of — `hasShareIntent` is a plain
 * boolean, already settled by the time `Shell` mounts (the `ShareIntentProvider` at the ROOT layout
 * has had the whole auth-gate/workspace-load wait to resolve it, long before `Shell` itself is
 * reached). So cold-start vs warm is instead: was a share ALREADY present the very first time this
 * hook's effect ran? If so, it was there before anything routed — cold start, queued through
 * `next-path.ts`. Any share that shows up on a LATER effect run (the owner backgrounds the app,
 * shares something else, and the OS brings this app back to the foreground) is warm and pushes
 * directly. A true -> false edge (`ShareScreen`'s own `resetShareIntent()`) is never routed.
 */
export function useShareIntentRouting(): void {
  const router = useRouter()
  const { hasShareIntent, shareIntent } = useShareIntentSafe()
  const isFirstRun = useRef(true)
  const wasActive = useRef(false)
  const [, bump] = useReducer((n: number) => n + 1, 0)

  useEffect(() => {
    const isColdStart = isFirstRun.current && hasShareIntent
    isFirstRun.current = false

    if (hasShareIntent === wasActive.current) return // no edge — nothing new to route
    wasActive.current = hasShareIntent
    if (!hasShareIntent) return // the true -> false edge: the intent was just reset

    const path = pathForShareIntent(shareIntent)
    if (!path) return

    if (isColdStart) {
      setNextPath(path)
      bump()
    } else {
      router.push(path as Href)
    }
  }, [hasShareIntent, shareIntent, router])
}
