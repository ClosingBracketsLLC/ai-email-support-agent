import { Redirect } from 'expo-router'
import { Stack } from 'expo-router/stack'
import { Loading } from '@/components/loading'
import { takeNextPath } from '@/lib/next-path'
import { hrefFor } from '@/lib/session-gate'
import { useGate } from '@/lib/use-gate'

/** Signed-out screens. As soon as a session exists the gate (or a pending deep link) takes over. */
export default function AuthLayout() {
  const gate = useGate()
  if (gate.kind === 'loading' || gate.kind === 'activate') return <Loading />
  if (gate.kind !== 'sign-in') {
    const next = takeNextPath()
    return <Redirect href={(next as never) ?? hrefFor(gate)!} />
  }
  return <Stack screenOptions={{ headerShown: false }} />
}
