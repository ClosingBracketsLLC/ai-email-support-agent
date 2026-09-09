import { Redirect } from 'expo-router'
import { GateError } from '@/components/gate-error'
import { Loading } from '@/components/loading'
import { hrefFor } from '@/lib/session-gate'
import { useGate } from '@/lib/use-gate'

export default function Index() {
  const gate = useGate()
  if (gate.kind === 'error') return <GateError target={gate} />
  const href = hrefFor(gate)
  return href ? <Redirect href={href} /> : <Loading />
}
