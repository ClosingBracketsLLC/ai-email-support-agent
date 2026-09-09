import Constants from 'expo-constants'
import * as Device from 'expo-device'
import * as Notifications from 'expo-notifications'
import { Platform } from 'react-native'

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
  let { status } = await Notifications.getPermissionsAsync()
  if (status !== 'granted' && ask) status = (await Notifications.requestPermissionsAsync()).status
  if (status !== 'granted') return { kind: 'denied' }
  const projectId = Constants.expoConfig?.extra?.eas?.projectId as string | undefined
  if (!projectId) return { kind: 'no-project' }
  const token = await Notifications.getExpoPushTokenAsync({ projectId })
  return { kind: 'ok', expoPushToken: token.data, platform: Platform.OS, ...(Device.deviceName ? { deviceName: Device.deviceName } : {}) }
}
