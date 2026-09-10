import Constants from 'expo-constants'
import * as Device from 'expo-device'
import * as Notifications from 'expo-notifications'
import { Platform } from 'react-native'

/** The notification category whose action buttons the OS draws on a `draft_review` push. The worker
 * stamps the same id as `categoryId` (apps/worker/src/push.ts). */
export const DRAFT_REVIEW_CATEGORY = 'draft_review'

/** Registered once per process — see `registerNotificationCategories`. */
let categoryRegistration: Promise<void> | null = null

/**
 * Native only (web has no notification categories) and idempotent: the native call is memoized for
 * the life of the process, and a failure clears the memo so a later call can try again. A category
 * that fails to register only costs the push its buttons, so the error is swallowed rather than
 * failing the caller's push registration.
 */
export function registerNotificationCategories(): Promise<void> {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return Promise.resolve()
  categoryRegistration ??= (async () => {
    try {
      await Notifications.setNotificationCategoryAsync(DRAFT_REVIEW_CATEGORY, [
        { identifier: 'review', buttonTitle: 'Review', options: { opensAppToForeground: true } },
        { identifier: 'hold', buttonTitle: 'Hold', options: { opensAppToForeground: true } },
      ])
    } catch {
      categoryRegistration = null
    }
  })()
  return categoryRegistration
}

export type PushResult =
  | { kind: 'unsupported' }   // web, simulators, Expo Go
  | { kind: 'denied' }
  | { kind: 'no-project' }    // app.json has no extra.eas.projectId yet (run `eas init`)
  | { kind: 'ok'; expoPushToken: string; platform: 'ios' | 'android'; deviceName?: string }

/** Native only. `ask: false` never shows the system prompt — the Notifications settings screen does that on tap. */
export async function registerForPush({ ask }: { ask: boolean }): Promise<PushResult> {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return { kind: 'unsupported' }
  if (!Device.isDevice) return { kind: 'unsupported' }
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', { name: 'Review needed', importance: Notifications.AndroidImportance.HIGH })
  }
  await registerNotificationCategories()
  let { status } = await Notifications.getPermissionsAsync()
  if (status !== 'granted' && ask) status = (await Notifications.requestPermissionsAsync()).status
  if (status !== 'granted') return { kind: 'denied' }
  const projectId = Constants.expoConfig?.extra?.eas?.projectId as string | undefined
  if (!projectId) return { kind: 'no-project' }
  const token = await Notifications.getExpoPushTokenAsync({ projectId })
  return { kind: 'ok', expoPushToken: token.data, platform: Platform.OS, ...(Device.deviceName ? { deviceName: Device.deviceName } : {}) }
}
