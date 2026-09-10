/**
 * The push-transport seam: `notify.dispatch` (per-notification) and `notify.digest` (the collapsed
 * overflow) both call this instead of the Expo SDK directly, so tests use a stub and the real
 * implementation's error handling lives in exactly one place.
 *
 * Ported contract (doge-buddy's `NotifyOwner`, apps/ops/src/notify/notify.ts): implementations
 * NEVER reject. A push failure must never fail the caller's transaction-free send step — it
 * resolves `{ ok: false, invalidTokens: [] }` instead, and the caller (notify-dispatch.ts,
 * notify-digest.ts) decides what a failed send means for the notification row(s).
 */
import { Expo, type ExpoPushMessage, type ExpoPushTicket } from 'expo-server-sdk'
import type pino from 'pino'

export interface PushMessage {
  to: string[]
  title: string
  body: string
  data?: Record<string, unknown>
  /**
   * Expo's `categoryId`: the notification category whose ACTIONS the OS renders on the push itself
   * — `Review` / `Hold`, for `draft_review` (`apps/app/src/lib/push.ts` registers the category with
   * those two buttons; this only names it).
   */
  categoryId?: string
}

export type SendPush = (msg: PushMessage) => Promise<{ ok: boolean; invalidTokens: string[] }>

/** The two `Expo` methods this seam actually calls — narrowed out so tests can pass a fake here
 * instead of hitting Expo's real HTTP API (the `Expo` class itself does no I/O until a send call). */
export interface ExpoLikeClient {
  chunkPushNotifications(messages: ExpoPushMessage[]): ExpoPushMessage[][]
  sendPushNotificationsAsync(messages: ExpoPushMessage[]): Promise<ExpoPushTicket[]>
}

/**
 * Real Expo push transport. Chunks recipients through `chunkPushNotifications` (Expo's 100-recipient
 * limit per request) and reads `DeviceNotRegistered` off each ticket to mark that token invalid —
 * per Expo's push API, a message whose `to` is an array of tokens returns exactly one ticket per
 * token, in the same order, so ticket `i` always corresponds to `tokens[i]` within a chunk.
 *
 * Any thrown error (network failure, a non-200 response, a malformed response body — see
 * ExpoClient.ts's `requestAsync`) is caught here: the seam never rejects.
 *
 * `client` defaults to a real `Expo` instance; tests pass a fake `ExpoLikeClient` so this is
 * exercised with no real network call.
 */
export function createExpoPush(logger: pino.Logger, client: ExpoLikeClient = new Expo()): SendPush {
  return async (msg) => {
    if (msg.to.length === 0) return { ok: true, invalidTokens: [] }
    try {
      const message: ExpoPushMessage = {
        to: msg.to, title: msg.title, body: msg.body, data: msg.data,
        ...(msg.categoryId ? { categoryId: msg.categoryId } : {}),
      }
      const chunks = client.chunkPushNotifications([message])
      const invalidTokens: string[] = []
      for (const chunk of chunks) {
        const tokens = chunk.flatMap((m) => (Array.isArray(m.to) ? m.to : [m.to]))
        const tickets = await client.sendPushNotificationsAsync(chunk)
        tickets.forEach((ticket, i) => {
          if (ticket.status === 'error' && ticket.details?.error === 'DeviceNotRegistered') {
            const token = tokens[i]
            if (token) invalidTokens.push(token)
          }
        })
      }
      return { ok: true, invalidTokens }
    } catch (err) {
      logger.warn({ recipients: msg.to.length, error: err instanceof Error ? err.message : String(err) }, 'expo_push_failed')
      return { ok: false, invalidTokens: [] }
    }
  }
}

/** Config-absent/disabled fallback: logs and resolves `ok: false` (never throws), so a deployment
 * with push disabled degrades exactly like a real transport failure — the caller's own failure
 * path (notification -> 'failed', or the digest leaving its rows 'collapsed' for the next tick). */
export function createNoopPush(logger: pino.Logger): SendPush {
  return async (msg) => {
    logger.warn({ recipients: msg.to.length, title: msg.title }, 'push_unconfigured')
    return { ok: false, invalidTokens: [] }
  }
}
