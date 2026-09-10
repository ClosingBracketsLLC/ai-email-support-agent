import { Stack } from 'expo-router/stack'
import * as SplashScreen from 'expo-splash-screen'
import { useEffect } from 'react'
import { Providers } from '@/components/providers'
import { useBrandFonts } from '@/lib/fonts'

// Hold the native splash until the brand faces are registered (or have failed to): the first frame the
// owner sees is already set in Fraunces and Plus Jakarta Sans instead of re-flowing from the system
// font a beat later. Web has no native splash; there this is one null render.
SplashScreen.preventAutoHideAsync().catch(() => {})

export default function RootLayout() {
  const { ready } = useBrandFonts()
  useEffect(() => { if (ready) SplashScreen.hideAsync().catch(() => {}) }, [ready])
  if (!ready) return null
  return (
    <Providers>
      <Stack screenOptions={{ headerShown: false }} />
    </Providers>
  )
}
