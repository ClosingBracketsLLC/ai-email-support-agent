import { describe, expect, it } from 'vitest'
import { RegisterDeviceInput, canManageWorkspace } from '../src/index.ts'

describe('device and team contracts', () => {
  it('accepts Expo push tokens only', () => {
    expect(RegisterDeviceInput.safeParse({ expoPushToken: 'ExponentPushToken[abc-DEF_123]', platform: 'ios' }).success).toBe(true)
    expect(RegisterDeviceInput.safeParse({ expoPushToken: 'ExpoPushToken[xyz]', platform: 'android', deviceName: 'Pixel' }).success).toBe(true)
    expect(RegisterDeviceInput.safeParse({ expoPushToken: 'fcm:abc', platform: 'android' }).success).toBe(false)
    expect(RegisterDeviceInput.safeParse({ expoPushToken: 'ExponentPushToken[abc]', platform: 'web' }).success).toBe(false)
  })
  it('owner and admin manage the workspace, member does not', () => {
    expect(canManageWorkspace('owner')).toBe(true)
    expect(canManageWorkspace('admin')).toBe(true)
    expect(canManageWorkspace('member')).toBe(false)
  })
})
