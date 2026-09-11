import { useEffect } from 'react'
import { Platform } from 'react-native'

/** The minimal surface the guard needs off `window` — a real `Window` matches it, and so does the
 * fake target `drop-guard.test.ts` uses. */
export interface DropGuardTarget {
  addEventListener: (type: string, listener: EventListener) => void
  removeEventListener: (type: string, listener: EventListener) => void
}

/**
 * Swallows the browser's own handling of a file dropped ANYWHERE in the document. Chrome, Safari
 * and Firefox all treat a drop on a page that did not handle it as "navigate to this file": the
 * whole app is replaced by a PDF viewer, unsaved state is gone, and — the reason this exists — any
 * upload still in flight is killed mid-`completeUpload`, leaving a `queued` source with no job.
 *
 * `dragover` has to be cancelled too, not just `drop`: a drop event only fires at all when the
 * preceding `dragover` was cancelled, and cancelling `dragover` at the window is what stops the
 * default action for the drop that follows it.
 *
 * Deliberately a NO-OP handler beyond `preventDefault` — the real drop zone
 * (`screens/knowledge/drop-zone.web.tsx`) binds its own listeners on its own node and calls
 * `preventDefault` there, so the event never reaches this one. This is only the backstop for
 * everywhere else on the page.
 */
export function bindWindowDropGuard(target: DropGuardTarget): () => void {
  const swallow = (event: Event) => { event.preventDefault() }
  target.addEventListener('dragover', swallow)
  target.addEventListener('drop', swallow)
  return () => {
    target.removeEventListener('dragover', swallow)
    target.removeEventListener('drop', swallow)
  }
}

/** Web only, and only where a real `window` exists (the Expo web export renders the first pass on
 * the server, where it does not). A no-op on iOS and Android, which have no DOM drag events. */
export function useWindowDropGuard(): void {
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return
    return bindWindowDropGuard(window)
  }, [])
}
