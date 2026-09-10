import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'expo-router'
import { useEffect, useState } from 'react'
import { Banner } from '@/components/banner'
import { Button } from '@/components/button'
import { Loading } from '@/components/loading'
import { Screen } from '@/components/screen'
import { SwitchRow } from '@/components/switch-row'
import { Title } from '@/components/typography'
import { useTRPC } from '@/lib/trpc'
import { useAdvance } from './mailbox'
import { Stepper } from './stepper'
import { TestEmailBox } from './test-email-box'

const GO_LIVE_POLL_MS = 5_000

/**
 * The last onboarding step: prove the agent works on your own test email, then flip the master
 * switch. Enabling IS the completion of this step — the server moves `onboarding_step` to `done` in
 * the same write (`workspace.setAgentEnabled`), so invalidating `workspace.get` is what lets the
 * session gate follow us to the inbox.
 */
export function GoLiveStep({ pollMs = GO_LIVE_POLL_MS }: { pollMs?: number } = {}) {
  const trpc = useTRPC()
  const router = useRouter()
  const queryClient = useQueryClient()
  const advance = useAdvance()

  // The poll stops for good once a draft has arrived. `refetchInterval` is read while the options are
  // built, i.e. before this render's own data is in hand, so the flag is raised from an effect (one
  // extra render) rather than during render.
  const [draftArrived, setDraftArrived] = useState(false)
  const status = useQuery(trpc.workspace.goLiveStatus.queryOptions(undefined, { refetchInterval: draftArrived ? false : pollMs }))
  const firstDraft = status.data?.firstDraft ?? null
  useEffect(() => { if (firstDraft) setDraftArrived(true) }, [firstDraft])

  const setAgentEnabled = useMutation(trpc.workspace.setAgentEnabled.mutationOptions({
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: trpc.workspace.get.queryKey() })
      router.replace('/inbox')
    },
  }))

  return (
    <Screen testID="onboarding-go-live">
      <Stepper current="go_live" />
      <Title>Go live</Title>
      {/* "(no agent yet)" is a real answer, not a placeholder for one — so it is only ever said once
          the query has actually come back and reported no address. */}
      {status.isPending ? <Loading testID="go-live-loading" /> : null}
      {status.error ? <Banner tone="error" testID="go-live-error">Could not check your agent. Trying again…</Banner> : null}
      {status.data ? (
        <TestEmailBox
          address={status.data.agentAddresses[0] ?? '(no agent yet)'}
          firstDraft={firstDraft}
          onReview={(ticketId) => router.push(`/ticket/${ticketId}`)}
        />
      ) : null}
      <SwitchRow
        label="Agent is ON"
        hint="Every category starts in Review — the agent drafts, you approve."
        value={status.data?.agentEnabled ?? false}
        disabled={setAgentEnabled.isPending}
        onValueChange={() => { if (!setAgentEnabled.isPending) setAgentEnabled.mutate({ enabled: true }) }}
        testID="agent-switch"
      />
      {setAgentEnabled.isError ? <Banner tone="error" testID="agent-enable-error">Could not turn the agent on. Try again.</Banner> : null}
      {advance.isError ? <Banner tone="error">Could not save your progress. Try again.</Banner> : null}
      {/* Leaves onboarding with the agent OFF — the inbox says so until the switch is flipped. */}
      <Button label="Finish later" variant="secondary" onPress={() => advance.mutate()} loading={advance.isPending} testID="finish-later" />
    </Screen>
  )
}
