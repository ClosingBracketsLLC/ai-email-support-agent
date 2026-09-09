jest.mock('expo-device', () => ({ isDevice: true, deviceName: 'Test Phone' }))
jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: { extra: { eas: { projectId: 'proj_123' } } } } }))
// babel-jest hoists jest.mock above imports and only lets the factory close over variables named mock*.
const mockNotifications = {
  getPermissionsAsync: jest.fn(), requestPermissionsAsync: jest.fn(), getExpoPushTokenAsync: jest.fn(), setNotificationChannelAsync: jest.fn(),
  AndroidImportance: { HIGH: 4 },
}
jest.mock('expo-notifications', () => mockNotifications)
// jest-expo's default preset runs as iOS, so Platform.OS is already 'ios'; no Platform mock is needed.

import { registerForPush } from './push'

beforeEach(() => jest.clearAllMocks())

test('does not prompt when not asked and permission is missing', async () => {
  mockNotifications.getPermissionsAsync.mockResolvedValue({ status: 'undetermined' })
  expect(await registerForPush({ ask: false })).toEqual({ kind: 'denied' })
  expect(mockNotifications.requestPermissionsAsync).not.toHaveBeenCalled()
})

test('prompts when asked, then returns the Expo token with the EAS project id', async () => {
  mockNotifications.getPermissionsAsync.mockResolvedValue({ status: 'undetermined' })
  mockNotifications.requestPermissionsAsync.mockResolvedValue({ status: 'granted' })
  mockNotifications.getExpoPushTokenAsync.mockResolvedValue({ type: 'expo', data: 'ExponentPushToken[abc]' })
  expect(await registerForPush({ ask: true })).toEqual({ kind: 'ok', expoPushToken: 'ExponentPushToken[abc]', platform: 'ios', deviceName: 'Test Phone' })
  expect(mockNotifications.getExpoPushTokenAsync).toHaveBeenCalledWith({ projectId: 'proj_123' })
})
