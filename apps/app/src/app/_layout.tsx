import { Stack } from 'expo-router/stack'
import { Providers } from '@/components/providers'

export default function RootLayout() {
  return (
    <Providers>
      <Stack screenOptions={{ headerShown: false }} />
    </Providers>
  )
}
