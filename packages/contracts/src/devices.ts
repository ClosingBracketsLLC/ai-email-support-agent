import { z } from 'zod'

export const EXPO_PUSH_TOKEN_RE = /^Expo(nent)?PushToken\[[A-Za-z0-9_-]+\]$/

export const RegisterDeviceInput = z.object({
  expoPushToken: z.string().regex(EXPO_PUSH_TOKEN_RE, 'not an Expo push token'),
  platform: z.enum(['ios', 'android']),
  deviceName: z.string().trim().max(80).optional(),
})
export type RegisterDeviceInput = z.infer<typeof RegisterDeviceInput>

export const UnregisterDeviceInput = z.object({ expoPushToken: z.string().regex(EXPO_PUSH_TOKEN_RE) })
