import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { authClient } from './auth-client'
import { resolveGate, type GateTarget } from './session-gate'
import { useTRPC } from './trpc'

const MISSING_CODES = new Set(['NOT_FOUND', 'PRECONDITION_FAILED', 'FORBIDDEN'])

/**
 * NOT_FOUND / PRECONDITION_FAILED / FORBIDDEN on workspace.get mean "no workspace yet" — resolveGate sends the
 * user to create one. Anything else is a real failure (network, 500, ...) that has to surface, not spin forever.
 */
export function classifyWorkspaceError(error: { data?: { code?: string } | null } | null | undefined): 'missing' | 'error' {
  return MISSING_CODES.has(error?.data?.code ?? '') ? 'missing' : 'error'
}

/** The one hook every layout calls. Also performs the single side effect the gate needs: activating a membership. */
export function useGate(): GateTarget {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const { data: session, isPending: sessionPending, error: sessionError, refetch } = authClient.useSession()
  const { data: organizations, isPending: orgsPending } = authClient.useListOrganizations()
  const active = session?.session.activeOrganizationId ?? null
  const workspace = useQuery({ ...trpc.workspace.get.queryOptions(), enabled: Boolean(session && active), retry: false })

  const target = resolveGate({
    session: sessionPending ? undefined : session ? { activeOrganizationId: active } : null,
    organizations: session && !active ? (orgsPending ? undefined : organizations ?? []) : [],
    workspace: !(session && active) ? undefined
      : workspace.isPending ? undefined
      : workspace.error ? (classifyWorkspaceError(workspace.error) === 'missing' ? 'missing' : undefined)
      : { onboardingStep: workspace.data.onboardingStep },
  })

  // Guards against a retry storm: activating.current is left set to the org id for the whole chain — including
  // the intermediate re-render authClient.useSession()'s refetch() produces while it is still in flight, still
  // carrying the OLD activeOrganizationId — so the effect below only re-fires for the same target once
  // retryActivate() explicitly clears it. Resetting it as soon as setActive() resolves (rather than after the
  // full chain settles) would let that intermediate render's still-'activate' target pass the guard again.
  const activating = useRef<string | null>(null)
  const [activateError, setActivateError] = useState<{ orgId: string; message: string } | null>(null)
  const [activateAttempt, setActivateAttempt] = useState(0)

  useEffect(() => {
    if (target.kind !== 'activate' || activating.current === target.orgId) return
    const orgId = target.orgId
    activating.current = orgId
    authClient.organization.setActive({ organizationId: orgId })
      .then(() => refetch())
      .then(() => queryClient.invalidateQueries())
      .then(() => { activating.current = null; setActivateError(null) })
      .catch(() => setActivateError({ orgId, message: 'Could not open your workspace.' }))
    // activateAttempt is bumped by retryActivate() purely to re-run this effect for one more attempt.
  }, [target, refetch, queryClient, activateAttempt])

  function retryActivate() {
    setActivateError(null)
    activating.current = null
    setActivateAttempt((n) => n + 1)
  }

  if (sessionError) return { kind: 'error', message: 'Could not load your session.', retry: () => void refetch() }
  if (activateError && target.kind === 'activate' && target.orgId === activateError.orgId) {
    return { kind: 'error', message: activateError.message, retry: retryActivate }
  }
  if (workspace.error && classifyWorkspaceError(workspace.error) === 'error') {
    return { kind: 'error', message: 'Could not load your workspace.', retry: () => void workspace.refetch() }
  }
  return target
}
