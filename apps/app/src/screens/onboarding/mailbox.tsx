import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'expo-router'
import { useState } from 'react'
import type { OnboardingStep } from '@aesa/contracts'
import { Banner } from '@/components/banner'
import { Button } from '@/components/button'
import { Card } from '@/components/card'
import { Loading } from '@/components/loading'
import { Screen } from '@/components/screen'
import { Body, Title } from '@/components/typography'
import { hrefFor } from '@/lib/session-gate'
import { useTRPC } from '@/lib/trpc'
import { AddressSheet } from '@/screens/settings/address-sheet'
import { ConnectMailboxCard } from '@/screens/settings/connect-card'
import { Stepper } from './stepper'

/** "Continue" and "Skip for now" both advance the server-side step, then follow it. */
export function useAdvance() {
  const trpc = useTRPC()
  const router = useRouter()
  const queryClient = useQueryClient()
  return useMutation(trpc.workspace.advanceOnboarding.mutationOptions({
    onSuccess: async ({ to }) => {
      await queryClient.invalidateQueries({ queryKey: trpc.workspace.get.queryKey() })
      router.replace(hrefFor(to === 'done' ? { kind: 'app' } : { kind: 'onboarding', step: to as Exclude<OnboardingStep, 'done'> })!)
    },
  }))
}

/** Step 3 of the spec's onboarding funnel: connect → claim → "which addresses should the agent
 * answer?". This step completes (server-side, via `useAdvance`) only once at least one connection is
 * 'connected' and it has at least one agent — a mailbox with nobody answering it is not a working step. */
export function MailboxStep() {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const advance = useAdvance()
  const list = useQuery(trpc.mailboxes.list.queryOptions())
  const [justConnected, setJustConnected] = useState<{ id: string; address: string } | null>(null)

  const refreshMailboxes = () => queryClient.invalidateQueries({ queryKey: trpc.mailboxes.list.queryKey() })

  if (!list.data) {
    return (
      <Screen testID="onboarding-mailbox">
        <Stepper current="mailbox" />
        <Title>Connect a mailbox</Title>
        <Loading />
      </Screen>
    )
  }

  const connected = list.data.connections.find((c) => c.status === 'connected')
  const hasAgent = Boolean(connected?.agents.length)
  const canContinue = Boolean(connected && hasAgent)
  // Right after claimConnection, or a connected mailbox that never got any address chosen yet (e.g.
  // resumed on another device): both land on the address-selection step.
  const sheetTarget = justConnected ?? (connected && !hasAgent ? { id: connected.id, address: connected.emailAddress } : null)

  return (
    <Screen testID="onboarding-mailbox">
      <Stepper current="mailbox" />
      <Title>Connect a mailbox</Title>
      {sheetTarget ? (
        <AddressSheet
          connectionId={sheetTarget.id} connectionAddress={sheetTarget.address}
          onDone={() => { setJustConnected(null); refreshMailboxes() }}
        />
      ) : connected ? (
        <Card testID="mailbox-connected"><Body>Connected: {connected.emailAddress}</Body></Card>
      ) : (
        <ConnectMailboxCard onConnected={(id, address) => setJustConnected({ id, address })} />
      )}
      {advance.isError ? <Banner tone="error">Could not save your progress. Try again.</Banner> : null}
      <Button label="Continue" onPress={() => advance.mutate()} loading={advance.isPending} disabled={!canContinue} testID="continue" />
    </Screen>
  )
}
