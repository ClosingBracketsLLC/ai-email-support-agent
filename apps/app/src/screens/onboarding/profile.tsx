import { useQuery } from '@tanstack/react-query'
import { useRouter } from 'expo-router'
import { Loading } from '@/components/loading'
import { Screen } from '@/components/screen'
import { Muted, Title } from '@/components/typography'
import { useTRPC } from '@/lib/trpc'
import { ProfileForm } from './profile-form'
import { Stepper } from './stepper'

export function ProfileStep() {
  const trpc = useTRPC()
  const router = useRouter()
  const ws = useQuery(trpc.workspace.get.queryOptions())
  if (!ws.data) return <Loading />
  return (
    <Screen testID="onboarding-profile">
      <Stepper current="profile" />
      <Title>Tell the agent about {ws.data.businessName}</Title>
      <Muted>About a minute. Everything here can be changed later in Settings.</Muted>
      <ProfileForm initial={ws.data} submitLabel="Continue" onSaved={() => router.replace('/onboarding/mailbox')} />
    </Screen>
  )
}
