import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'expo-router'
import type { OnboardingStep } from '@aesa/contracts'
import { Banner } from '@/components/banner'
import { Button } from '@/components/button'
import { Card } from '@/components/card'
import { Screen } from '@/components/screen'
import { Body, Muted, Title } from '@/components/typography'
import { hrefFor } from '@/lib/session-gate'
import { useTRPC } from '@/lib/trpc'
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

export function MailboxStep() {
  const advance = useAdvance()
  return (
    <Screen testID="onboarding-mailbox">
      <Stepper current="mailbox" />
      <Title>Connect a mailbox</Title>
      <Card>
        <Body>Gmail and Microsoft 365 connections arrive with the next release. When they do, you will pick which addresses the agent answers — nothing is read until you say so.</Body>
        <Muted>Until then, continue and connect later from Settings → Mailboxes.</Muted>
      </Card>
      {advance.isError ? <Banner tone="error">Could not save your progress. Try again.</Banner> : null}
      <Button label="Continue" onPress={() => advance.mutate()} loading={advance.isPending} testID="continue" />
    </Screen>
  )
}
