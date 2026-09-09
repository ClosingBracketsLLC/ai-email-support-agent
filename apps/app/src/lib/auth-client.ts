import { expoClient } from '@better-auth/expo/client'
import { emailOTPClient, organizationClient } from 'better-auth/client/plugins'
import { createAuthClient } from 'better-auth/react'
import * as SecureStore from 'expo-secure-store'
import { Platform } from 'react-native'
import { API_URL } from './api-url'

/**
 * Native: the session cookie lives in SecureStore and rides along as a `cookie` header (credentials: omit).
 * Web: the expo plugin steps aside and the browser keeps the cookie (credentials: include, CORS on the api).
 */
export const authClient = createAuthClient({
  baseURL: API_URL,
  plugins: [expoClient({ scheme: 'aesa', storagePrefix: 'aesa', storage: SecureStore }), emailOTPClient(), organizationClient()],
})

/** The cookie header non-auth requests (tRPC) must carry on native. Null on web, where the browser does it. */
export async function getAuthCookie(): Promise<string | null> {
  if (Platform.OS === 'web') return null
  const cookie = await authClient.getCookie()
  return cookie || null
}

export type SessionData = typeof authClient.$Infer.Session
