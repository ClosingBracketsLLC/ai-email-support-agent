import Constants from 'expo-constants'
import { Platform } from 'react-native'

jest.mock('expo-device', () => ({ isDevice: true, deviceName: 'Test Phone' }))
jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: { extra: { eas: { projectId: 'proj_123' } } } } }))
// Self-contained factory (no reference to an outer variable): expo-notifications is required by push.ts via
// a static top-level import, and static imports resolve before any of this file's own top-level statements
// run (including a `const` a factory might close over) — so the factory itself must carry everything it needs.
jest.mock('expo-notifications', () => ({
  getPermissionsAsync: jest.fn(), requestPermissionsAsync: jest.fn(), getExpoPushTokenAsync: jest.fn(), setNotificationChannelAsync: jest.fn(),
  setNotificationCategoryAsync: jest.fn(),
  AndroidImportance: { HIGH: 4 },
}))
// jest-expo's default preset runs as iOS, so Platform.OS is already 'ios'; no Platform mock is needed
// except in the one test below that deliberately switches it to 'web'.

import * as Notifications from 'expo-notifications'
import { DRAFT_REVIEW_CATEGORY, __resetPushCategoriesForTests, registerForPush } from './push'

const getPermissionsAsync = jest.mocked(Notifications.getPermissionsAsync)
const requestPermissionsAsync = jest.mocked(Notifications.requestPermissionsAsync)
const getExpoPushTokenAsync = jest.mocked(Notifications.getExpoPushTokenAsync)
const setNotificationCategoryAsync = jest.mocked(Notifications.setNotificationCategoryAsync)

function permissions(status: 'granted' | 'undetermined' | 'denied') {
  return { status, granted: status === 'granted', expires: 'never', canAskAgain: true } as Awaited<ReturnType<typeof Notifications.getPermissionsAsync>>
}

beforeEach(() => {
  jest.clearAllMocks()
  // The category registration is memoized per process (one native call per app launch, not one per
  // `registerForPush`); dropping the memo here keeps every test below independent of the order.
  __resetPushCategoriesForTests()
})

test('registers the draft_review actions before asking for a token, and only once per process', async () => {
  getPermissionsAsync.mockResolvedValue(permissions('granted'))
  getExpoPushTokenAsync.mockResolvedValue({ type: 'expo', data: 'ExponentPushToken[abc]' })

  await registerForPush({ ask: false })
  expect(setNotificationCategoryAsync).toHaveBeenCalledWith(DRAFT_REVIEW_CATEGORY, [
    { identifier: 'review', buttonTitle: 'Review', options: { opensAppToForeground: true } },
    { identifier: 'hold', buttonTitle: 'Hold', options: { opensAppToForeground: true } },
  ])
  expect(DRAFT_REVIEW_CATEGORY).toBe('draft_review')
  // The push's action buttons must exist before a push can arrive, i.e. before the token this call
  // hands the server.
  expect(setNotificationCategoryAsync.mock.invocationCallOrder[0]!).toBeLessThan(getExpoPushTokenAsync.mock.invocationCallOrder[0]!)

  await registerForPush({ ask: false })
  expect(setNotificationCategoryAsync).toHaveBeenCalledTimes(1)
})

test('does not prompt when not asked and permission is missing', async () => {
  getPermissionsAsync.mockResolvedValue(permissions('undetermined'))
  expect(await registerForPush({ ask: false })).toEqual({ kind: 'denied' })
  expect(requestPermissionsAsync).not.toHaveBeenCalled()
})

test('prompts when asked, then returns the Expo token with the EAS project id', async () => {
  getPermissionsAsync.mockResolvedValue(permissions('undetermined'))
  requestPermissionsAsync.mockResolvedValue(permissions('granted'))
  getExpoPushTokenAsync.mockResolvedValue({ type: 'expo', data: 'ExponentPushToken[abc]' })
  expect(await registerForPush({ ask: true })).toEqual({ kind: 'ok', expoPushToken: 'ExponentPushToken[abc]', platform: 'ios', deviceName: 'Test Phone' })
  expect(getExpoPushTokenAsync).toHaveBeenCalledWith({ projectId: 'proj_123' })
})

test('on web, push is unsupported and never touches expo-notifications', async () => {
  const os = jest.replaceProperty(Platform, 'OS', 'web')
  try {
    expect(await registerForPush({ ask: false })).toEqual({ kind: 'unsupported' })
    expect(getPermissionsAsync).not.toHaveBeenCalled()
    expect(setNotificationCategoryAsync).not.toHaveBeenCalled()
  } finally {
    os.restore()
  }
})

test('permission granted but no EAS project id yet (eas init not run) returns no-project', async () => {
  getPermissionsAsync.mockResolvedValue(permissions('granted'))
  const config = jest.replaceProperty(Constants, 'expoConfig', { name: 'aesa', slug: 'aesa', extra: {} })
  try {
    expect(await registerForPush({ ask: false })).toEqual({ kind: 'no-project' })
  } finally {
    config.restore()
  }
})
