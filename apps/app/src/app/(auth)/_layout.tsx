import { Redirect, type Href } from 'expo-router'
import { Stack } from 'expo-router/stack'
import { useEffect } from 'react'
import { GateError } from '@/components/gate-error'
import { Loading } from '@/components/loading'
import { clearNextPath, peekNextPath } from '@/lib/next-path'
import { hrefFor } from '@/lib/session-gate'
import { useGate } from '@/lib/use-gate'

/** Signed-out screens. As soon as a session exists the gate (or a pending deep link) takes over. */
export default function AuthLayout() {
  const gate = useGate()
  const next = peekNextPath()
  const redirecting = gate.kind !== 'loading' && gate.kind !== 'activate' && gate.kind !== 'error' && gate.kind !== 'sign-in'

  // The deep link is consumed here, once, after the redirect it named has actually been rendered — never
  // during render itself, where a discarded pass (Strict Mode's double render, e.g.) could drop it.
  useEffect(() => {
    if (redirecting && next) clearNextPath()
  }, [redirecting, next])

  if (gate.kind === 'error') return <GateError target={gate} />
  if (gate.kind === 'loading' || gate.kind === 'activate') return <Loading />
  if (redirecting) return <Redirect href={(next ?? hrefFor(gate)!) as Href} />
  return <Stack screenOptions={{ headerShown: false }} />
}
