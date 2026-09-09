import { Redirect, useLocalSearchParams } from 'expo-router'
import { GateError } from '@/components/gate-error'
import { Loading } from '@/components/loading'
import { hrefFor } from '@/lib/session-gate'
import { useGate } from '@/lib/use-gate'
import { GoLiveStep } from '@/screens/onboarding/go-live'
import { KnowledgeStep } from '@/screens/onboarding/knowledge'
import { MailboxStep } from '@/screens/onboarding/mailbox'
import { ProfileStep } from '@/screens/onboarding/profile'

export default function OnboardingStepRoute() {
  const { step } = useLocalSearchParams<{ step: string }>()
  const gate = useGate()
  if (gate.kind === 'loading' || gate.kind === 'activate') return <Loading />
  if (gate.kind === 'error') return <GateError target={gate} />
  if (gate.kind !== 'onboarding') return <Redirect href={hrefFor(gate)!} />
  if (gate.step !== step) return <Redirect href={hrefFor(gate)!} />
  switch (gate.step) {
    case 'profile': return <ProfileStep />
    case 'mailbox': return <MailboxStep />
    case 'knowledge': return <KnowledgeStep />
    case 'go_live': return <GoLiveStep />
  }
}
