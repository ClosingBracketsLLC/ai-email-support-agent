import * as Notifications from 'expo-notifications'
import { useRouter, type Href } from 'expo-router'
import { useEffect, useReducer, useRef } from 'react'
import type { NotificationKind } from '@aesa/contracts'
import { setNextPath } from './next-path'
import { useTRPCClient } from './trpc'

/** The Hold button `registerNotificationCategories` (push.ts) puts on an `auto_send` push — the only
 * one of its two actions that does anything beyond opening the ticket. */
const HOLD_ACTION = 'hold'

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

  if (kind === 'escalation' || kind === 'draft_review' || kind === 'auto_send') return ticketId ? `/ticket/${ticketId}` : '/inbox'
  if (kind === 'mailbox_reauth') return '/settings/mailboxes'
  // Phase 6: a BYOK provider key was rejected — the fix is on the AI settings screen, not a ticket.
  if (kind === 'provider_health') return '/settings/ai'
  if (kind === 'digest') return '/inbox'
  // Phase 5's three learning-loop pushes are about a SETTING, not a ticket: a category that earned
  // (or lost) Autopilot, and the weekly nudge to check what the agent has been remembering.
  if (kind === 'graduation' || kind === 'demotion') return '/settings/autopilot'
  if (kind === 'memory_sample') return '/settings/memory'

  // No `kind` on this payload (pre-fix push) — infer it from whichever field is present, ticketId first.
  if (ticketId) return `/ticket/${ticketId}`
  if (connectionId) return '/settings/mailboxes'
  return '/inbox'
}

/**
 * What one tap on a notification means: where it goes, and whether it also holds a draft.
 *
 * `Hold` is the second button on an `auto_send` push — the reply is queued and still inside its hold
 * window, so the tap cancels the send and returns the ticket to review. It only ever succeeds on an
 * approved, not-yet-sent draft; anything else (a pending draft has nothing to hold) is answered
 * `not_holdable` by the server and the tap simply opens the ticket (plan deviation 12). `Review` and
 * a plain tap on the notification body carry no hold at all.
 */
export function actionForResponse(r: {
  actionIdentifier?: string
  notification: { request: { content: { data?: Record<string, unknown> | null } } }
}): { path: string; holdDraftId: string | null } {
  const data = r.notification.request.content.data
  const draftId = typeof data?.draftId === 'string' && data.draftId ? data.draftId : null
  return { path: pathForNotification(data), holdDraftId: r.actionIdentifier === HOLD_ACTION ? draftId : null }
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
  const trpcClient = useTRPCClient()
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

    const { path, holdDraftId } = actionForResponse(lastResponse)
    // Fire-and-forget, and before the routing: the tap's job is to hold, and the screen it opens
    // refetches the draft anyway. A refusal (`not_holdable`) or a network failure must not stop the
    // ticket from opening.
    if (holdDraftId) void trpcClient.drafts.hold.mutate({ draftId: holdDraftId }).catch(() => { /* the ticket screen shows the real state */ })
    Notifications.clearLastNotificationResponse()
    if (isColdStart) {
      setNextPath(path)
      bump()
    } else {
      router.push(path as Href)
    }
  }, [lastResponse, router, trpcClient])
}
