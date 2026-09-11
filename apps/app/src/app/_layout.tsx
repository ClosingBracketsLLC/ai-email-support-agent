import { Stack } from 'expo-router/stack'
import * as SplashScreen from 'expo-splash-screen'
import { useEffect } from 'react'
import { Providers } from '@/components/providers'
import { useWindowDropGuard } from '@/lib/drop-guard'
import { useBrandFonts } from '@/lib/fonts'

// Hold the native splash until the brand faces are registered (or have failed to): the first frame the
// owner sees is already set in Fraunces and Plus Jakarta Sans instead of re-flowing from the system
// font a beat later. Web has no native splash; on the static web export `expo-font` resolves through
// `useStaticFonts` on the server (the faces are already registered and `@font-face` is in the served
// HTML), so hydration renders ready immediately — only the Metro dev server actually shows this null
// first frame.
SplashScreen.preventAutoHideAsync().catch(() => {})

export default function RootLayout() {
  const { ready } = useBrandFonts()
  // Web only, and above the `!ready` early return so the guard is bound for the whole life of the
  // app: a file dropped anywhere OUTSIDE a drop zone must never navigate the tab away from it.
  useWindowDropGuard()
  useEffect(() => { if (ready) SplashScreen.hideAsync().catch(() => {}) }, [ready])
  if (!ready) return null
  return (
    <Providers>
      <Stack screenOptions={{ headerShown: false }} />
    </Providers>
  )
}
