import { Redirect, Slot } from 'expo-router'
import { GateError } from '@/components/gate-error'
import { Loading } from '@/components/loading'
import { hrefFor } from '@/lib/session-gate'
import { useGate } from '@/lib/use-gate'

export default function OnboardingLayout() {
  const gate = useGate()
  if (gate.kind === 'loading' || gate.kind === 'activate') return <Loading />
  if (gate.kind === 'error') return <GateError target={gate} />
  if (gate.kind !== 'onboarding') return <Redirect href={hrefFor(gate)!} />
  return <Slot />
}
