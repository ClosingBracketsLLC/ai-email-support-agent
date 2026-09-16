import * as WebBrowser from 'expo-web-browser'
import { Platform } from 'react-native'

/** The one sentence every popup-blocked refusal in the app shows — shared so `connect-card.tsx`'s
 * own web branch (which needs to keep its own window handle to close later, so it cannot go through
 * `openExternal` below) still says exactly the same thing. */
export const POPUP_BLOCKED_MESSAGE = 'Your browser blocked the popup. Allow popups for this site and try again.'

/**
 * Opens a blank popup window SYNCHRONOUSLY — before any `await` — so the browser's popup blocker
 * (which ties permission to the synchronous input-handler call stack) does not silently swallow it.
 * `null` means the browser blocked it. Web only; `undefined` on native and in a non-DOM environment.
 */
export function openPopup(): Window | null {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return null
  return window.open('', '_blank')
}

/**
 * Opens an external management page (Stripe Checkout, the Billing Portal, an export download) for a
 * URL this screen does not have yet — `start()` is the network call that mints it.
 *
 * On web the popup has to open BEFORE `start()` is awaited (`connect-card.tsx:105-117,145` is the
 * precedent this mirrors: `ConnectMailboxCard.connect` opens its own blank window the same way,
 * before its `startConnect` round trip, because it separately needs the window handle to close once
 * the OAuth claim poll lands — a need `openExternal`'s simpler one-shot callers here never have).
 * Once `start()` resolves the popup is pointed at the real url; a `start()` that throws closes the
 * popup and rethrows so the caller's own mutation `onError` still fires.
 *
 * On native there is no popup-blocker concern, so the order is the natural one: await `start()`,
 * then open the system browser on the url it returned.
 */
export async function openExternal(
  start: () => Promise<{ url: string }>,
  opts: { onBlocked: (msg: string) => void },
): Promise<void> {
  if (Platform.OS === 'web') {
    const webWindow = openPopup()
    if (!webWindow) {
      opts.onBlocked(POPUP_BLOCKED_MESSAGE)
      return
    }
    try {
      const { url } = await start()
      webWindow.location.href = url
    } catch (err) {
      webWindow.close()
      throw err
    }
    return
  }
  const { url } = await start()
  await WebBrowser.openBrowserAsync(url)
}
