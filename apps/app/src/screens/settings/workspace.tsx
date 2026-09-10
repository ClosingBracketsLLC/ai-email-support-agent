import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { canManageWorkspace } from '@aesa/contracts'
import { Banner } from '@/components/banner'
import { Loading } from '@/components/loading'
import { Screen } from '@/components/screen'
import { SwitchRow } from '@/components/switch-row'
import { Muted } from '@/components/typography'
import { useTRPC } from '@/lib/trpc'
import { ProfileForm } from '@/screens/onboarding/profile-form'

export function WorkspaceSettingsScreen() {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const ws = useQuery(trpc.workspace.get.queryOptions())
  const [saved, setSaved] = useState(false)
  const setAgentEnabled = useMutation(trpc.workspace.setAgentEnabled.mutationOptions({
    onSuccess: () => queryClient.invalidateQueries({ queryKey: trpc.workspace.get.queryKey() }),
  }))
  if (!ws.data) return <Loading />
  if (!canManageWorkspace(ws.data.role)) return <Screen><Banner>Only owners and admins can edit the workspace profile.</Banner></Screen>
  return (
    <Screen testID="settings-workspace-screen">
      <Muted>{ws.data.businessName} · {ws.data.timezone}</Muted>
      {saved ? <Banner tone="success">Saved.</Banner> : null}
      {/* The master switch, in both directions — the same control the go-live step flips on. */}
      <SwitchRow
        label="Agent is ON"
        hint="Every category starts in Review — the agent drafts, you approve."
        value={ws.data.agentEnabled}
        disabled={setAgentEnabled.isPending}
        onValueChange={(enabled) => { if (!setAgentEnabled.isPending) setAgentEnabled.mutate({ enabled }) }}
        testID="agent-switch"
      />
      {setAgentEnabled.isError ? <Banner tone="error" testID="agent-switch-error">Could not change the agent. Try again.</Banner> : null}
      {/* Stay on this screen: router.back() used to pop it before "Saved." could ever be seen (Phase 1 review, minor 9). */}
      <ProfileForm initial={ws.data} submitLabel="Save" onSaved={() => setSaved(true)} />
    </Screen>
  )
}
