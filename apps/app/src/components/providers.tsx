import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query'
import { useEffect, useState, type ReactNode } from 'react'
import { AppState, Platform, type AppStateStatus } from 'react-native'
import { TRPCProvider, createTrpcClient } from '@/lib/trpc'

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 5_000 } } }))
  const [trpcClient] = useState(() => createTrpcClient())

  // Phase 1 carry-over, named for the inbox's 30s poll: TanStack Query's default focus tracking is
  // web-only (a `window` focus/blur listener), so on native `refetchOnWindowFocus` would otherwise
  // never fire. `AppState` is native's equivalent signal — web keeps the library's default behavior.
  useEffect(() => {
    if (Platform.OS === 'web') return
    function onChange(status: AppStateStatus) { focusManager.setFocused(status === 'active') }
    const subscription = AppState.addEventListener('change', onChange)
    return () => subscription.remove()
  }, [])

  return (
    <QueryClientProvider client={queryClient}>
      <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>{children}</TRPCProvider>
    </QueryClientProvider>
  )
}
