import { Redirect, type Href } from 'expo-router'
import { useEffect } from 'react'
import { GateError } from '@/components/gate-error'
import { Loading } from '@/components/loading'
import { ResponsiveShell } from '@/components/responsive-shell'
import { clearNextPath, peekNextPath } from '@/lib/next-path'
import { usePushRouting } from '@/lib/push-routing'
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

/**
 * A pending push-notification deep link (push-routing.ts's cold-start case) takes over the very
 * first render it appears in — same "consume once, after the redirect it named has actually been
 * rendered — never during render itself" discipline as (auth)/_layout.tsx's own next-path drain.
 */
function Shell() {
  usePushRegistration()
  usePushRouting()
  const next = peekNextPath()
  useEffect(() => { if (next) clearNextPath() }, [next])
  if (next) return <Redirect href={next as Href} />
  return <ResponsiveShell />
}
