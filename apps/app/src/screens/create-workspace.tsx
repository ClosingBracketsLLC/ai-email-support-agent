import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'expo-router'
import { useState } from 'react'
import { CreateWorkspaceInput } from '@aesa/contracts'
import { Banner } from '@/components/banner'
import { Button } from '@/components/button'
import { Screen } from '@/components/screen'
import { TextField } from '@/components/text-field'
import { Muted, Title } from '@/components/typography'
import { authClient } from '@/lib/auth-client'
import { useTRPC } from '@/lib/trpc'

export function CreateWorkspaceScreen() {
  const trpc = useTRPC()
  const router = useRouter()
  const queryClient = useQueryClient()
  const { data: session, refetch } = authClient.useSession()
  const [yourName, setYourName] = useState(session?.user.name ?? '')
  const [businessName, setBusinessName] = useState('')
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  const input = CreateWorkspaceInput.safeParse({ businessName, timezone })

  const create = useMutation(trpc.workspace.create.mutationOptions({
    onSuccess: async () => {
      if (yourName.trim() && yourName.trim() !== session?.user.name) await authClient.updateUser({ name: yourName.trim() })
      await refetch()
      await queryClient.invalidateQueries()
      router.replace('/onboarding/profile')
    },
  }))

  return (
    <Screen testID="create-workspace">
      <Title>Create your workspace</Title>
      <Muted>One workspace per business. You can invite teammates afterwards.</Muted>
      {!session?.user.name ? <TextField label="Your name" value={yourName} onChangeText={setYourName} autoComplete="name" testID="your-name" /> : null}
      <TextField label="Business name" value={businessName} onChangeText={setBusinessName} placeholder="Acme Socks" testID="business-name" onSubmitEditing={() => input.success && create.mutate(input.data)} />
      <Muted>Time zone: {timezone}</Muted>
      {create.isError ? <Banner tone="error">Could not create the workspace. Try again.</Banner> : null}
      <Button label="Create workspace" onPress={() => input.success && create.mutate(input.data)} loading={create.isPending} disabled={!input.success} testID="create" />
    </Screen>
  )
}
