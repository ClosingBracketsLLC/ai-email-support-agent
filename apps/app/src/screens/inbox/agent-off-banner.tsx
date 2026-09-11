import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { canManageWorkspace } from '@aesa/contracts'
import { Banner } from '@/components/banner'
import { Button } from '@/components/button'
import { useTRPC } from '@/lib/trpc'

/**
 * Sits at the top of the inbox while the master switch is off: nothing the agent drafts can leave
 * the building, so say so where the owner is already looking. Owners and admins can flip it here.
 */
export function AgentOffBanner() {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const ws = useQuery(trpc.workspace.get.queryOptions())
  const setAgentEnabled = useMutation(trpc.workspace.setAgentEnabled.mutationOptions({
    onSuccess: () => queryClient.invalidateQueries({ queryKey: trpc.workspace.get.queryKey() }),
  }))

  if (!ws.data || ws.data.agentEnabled) return null
  return (
    <>
      <Banner tone="info" testID="agent-off">The agent is off — replies wait until you turn it on.</Banner>
      {canManageWorkspace(ws.data.role) ? (
        <Button
          label="Turn the agent on"
          onPress={() => { if (!setAgentEnabled.isPending) setAgentEnabled.mutate({ enabled: true }) }}
          loading={setAgentEnabled.isPending}
          testID="agent-on"
        />
      ) : null}
    </>
  )
}
