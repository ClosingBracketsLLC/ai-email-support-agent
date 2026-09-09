import { Redirect } from 'expo-router'
import { GateError } from '@/components/gate-error'
import { Loading } from '@/components/loading'
import { hrefFor } from '@/lib/session-gate'
import { useGate } from '@/lib/use-gate'
import { CreateWorkspaceScreen } from '@/screens/create-workspace'

export default function CreateWorkspaceRoute() {
  const gate = useGate()
  if (gate.kind === 'loading' || gate.kind === 'activate') return <Loading />
  if (gate.kind === 'error') return <GateError target={gate} />
  if (gate.kind !== 'create-workspace') return <Redirect href={hrefFor(gate)!} />
  return <CreateWorkspaceScreen />
}
