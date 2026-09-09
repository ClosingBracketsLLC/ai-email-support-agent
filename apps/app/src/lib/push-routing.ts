import * as Notifications from 'expo-notifications'
import { useRouter, type Href } from 'expo-router'
import { useEffect, useReducer, useRef } from 'react'
import type { NotificationKind } from '@aesa/contracts'
import { setNextPath } from './next-path'

/**
 * Maps a push notification's `data` payload to the screen it's about.
 *
 * The worker stamps `kind` onto every push's `data` (apps/worker/src/jobs/notify-dispatch.ts,
 * notify-digest.ts — `reauth-notify.ts`'s row flows through dispatch, so it inherits dispatch's
 * stamp) — `kind` is read first and is the normal path for anything pushed after that change. The
 * fallback below (infer the kind from whichever payload field is present — `ticketId` means
 * escalation, `connectionId` means mailbox_reauth, neither means digest) only matters for a push
 * that was already sitting in a device's notification tray, undelivered, from before the fix
 * shipped; kept so tapping one of those doesn't route nowhere. If a payload somehow carries both
 * (should not happen in practice — the two kinds are mutually exclusive on the wire), `ticketId`
 * wins: an escalation is the more urgent event.
 */
export function pathForNotification(data: Record<string, unknown> | undefined | null): string {
  const kind = typeof data?.kind === 'string' ? (data.kind as NotificationKind) : undefined
  const ticketId = typeof data?.ticketId === 'string' && data.ticketId ? data.ticketId : undefined
  const connectionId = typeof data?.connectionId === 'string' && data.connectionId ? data.connectionId : undefined

  if (kind === 'escalation') return ticketId ? `/ticket/${ticketId}` : '/inbox'
  if (kind === 'mailbox_reauth') return '/settings/mailboxes'
  if (kind === 'digest') return '/inbox'

  // No `kind` on this payload (pre-fix push) — infer it from whichever field is present, ticketId first.
  if (ticketId) return `/ticket/${ticketId}`
  if (connectionId) return '/settings/mailboxes'
  return '/inbox'
}

/**
 * Warm taps (the app is already running) route immediately with `router.push`. A cold-start tap —
 * where the notification launch is what started the process — can't push anywhere yet, since
 * nothing is mounted to navigate with; that case is queued through `next-path.ts`'s deep-link
 * mechanism instead — the same one `(auth)/_layout.tsx` drains for an invitation link.
 * `(app)/_layout.tsx` drains it here, once the gate has resolved to `app` and this hook's caller
 * (`Shell`) is actually mounted.
 *
 * `Notifications.useLastNotificationResponse()` reports `undefined` until the native side has
 * reported in, then `null` (no tap happened) or the tap's `NotificationResponse` — and keeps
 * updating on every later tap while this stays mounted. The FIRST time it resolves away from
 * `undefined` is therefore the cold-start state (a real response there is a cold-start tap); any
 * value after that first resolution is, by definition, a later, warm tap.
 *
 * `next-path.ts` is a bare module variable with no subscribers, so setting it from this hook's
 * effect would not by itself cause the caller to notice on its next render — `bump()` forces that
 * one extra render, after which the caller's own `peekNextPath()` read (at render time) picks up
 * the value this effect just set.
 */
export function usePushRouting(): void {
  const router = useRouter()
  const lastResponse = Notifications.useLastNotificationResponse()
  const resolvedOnce = useRef(false)
  // Guards against reprocessing the same response twice if the effect below re-fires for an
  // unrelated reason (its `router` dependency changing identity, say) without `lastResponse` itself
  // having moved on to a new value.
  const processedResponse = useRef<typeof lastResponse>(undefined)
  const [, bump] = useReducer((n: number) => n + 1, 0)

  useEffect(() => {
    if (lastResponse === undefined || lastResponse === processedResponse.current) return
    processedResponse.current = lastResponse
    const isColdStart = !resolvedOnce.current
    resolvedOnce.current = true
    if (!lastResponse) return

    const path = pathForNotification(lastResponse.notification.request.content.data)
    Notifications.clearLastNotificationResponse()
    if (isColdStart) {
      setNextPath(path)
      bump()
    } else {
      router.push(path as Href)
    }
  }, [lastResponse, router])
}
