import { createTRPCClient, httpBatchLink } from '@trpc/client'
import { createTRPCContext } from '@trpc/tanstack-react-query'
import { Platform } from 'react-native'
import superjson from 'superjson'
import type { AppRouter } from '@aesa/api'
import { API_URL } from './api-url'
import { getAuthCookie } from './auth-client'

export const { TRPCProvider, useTRPC, useTRPCClient } = createTRPCContext<AppRouter>()

export function createTrpcClient() {
  return createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url: `${API_URL}/trpc`,
        transformer: superjson,
        async headers() { const cookie = await getAuthCookie(); return cookie ? { cookie } : {} },
        fetch: (url, options) => fetch(url, { ...options, credentials: Platform.OS === 'web' ? 'include' : 'omit' }),
      }),
    ],
  })
}

export async function fetchMeta(): Promise<{ providers: { google: boolean; microsoft: boolean } }> {
  const res = await fetch(`${API_URL}/meta`)
  if (!res.ok) throw new Error(`meta ${res.status}`)
  return res.json() as Promise<{ providers: { google: boolean; microsoft: boolean } }>
}
