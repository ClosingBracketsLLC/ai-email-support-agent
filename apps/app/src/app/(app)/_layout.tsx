import { Redirect } from 'expo-router'
import { GateError } from '@/components/gate-error'
import { Loading } from '@/components/loading'
import { ResponsiveShell } from '@/components/responsive-shell'
import { usePushRegistration } from '@/lib/use-push-registration'
import { hrefFor } from '@/lib/session-gate'
import { useGate } from '@/lib/use-gate'

export default function AppLayout() {
  const gate = useGate()
  if (gate.kind === 'loading' || gate.kind === 'activate') return <Loading />
  if (gate.kind === 'error') return <GateError target={gate} />
  if (gate.kind !== 'app') return <Redirect href={hrefFor(gate)!} />
  return <Shell />
}

function Shell() {
  usePushRegistration()
  return <ResponsiveShell />
}
