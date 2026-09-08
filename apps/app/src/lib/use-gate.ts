import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { authClient } from './auth-client'
import { resolveGate, type GateTarget } from './session-gate'
import { useTRPC } from './trpc'

const MISSING_CODES = new Set(['NOT_FOUND', 'PRECONDITION_FAILED', 'FORBIDDEN'])

/** The one hook every layout calls. Also performs the single side effect the gate needs: activating a membership. */
export function useGate(): GateTarget {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const { data: session, isPending: sessionPending, refetch } = authClient.useSession()
  const { data: organizations, isPending: orgsPending } = authClient.useListOrganizations()
  const active = session?.session.activeOrganizationId ?? null
  const workspace = useQuery({ ...trpc.workspace.get.queryOptions(), enabled: Boolean(session && active), retry: false })

  const target = resolveGate({
    session: sessionPending ? undefined : session ? { activeOrganizationId: active } : null,
    organizations: session && !active ? (orgsPending ? undefined : organizations ?? []) : [],
    workspace: !(session && active) ? undefined
      : workspace.isPending ? undefined
      : workspace.error ? (MISSING_CODES.has(workspace.error.data?.code ?? '') ? 'missing' : undefined)
      : { onboardingStep: workspace.data.onboardingStep },
  })

  const activating = useRef<string | null>(null)
  useEffect(() => {
    if (target.kind !== 'activate' || activating.current === target.orgId) return
    activating.current = target.orgId
    authClient.organization.setActive({ organizationId: target.orgId })
      .then(() => refetch())
      .then(() => queryClient.invalidateQueries())
      .finally(() => { activating.current = null })
  }, [target, refetch, queryClient])

  return target
}
