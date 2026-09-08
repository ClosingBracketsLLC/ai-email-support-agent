import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Redirect, useLocalSearchParams, useRouter } from 'expo-router'
import { useState } from 'react'
import { Banner } from '@/components/banner'
import { Button } from '@/components/button'
import { Loading } from '@/components/loading'
import { Screen } from '@/components/screen'
import { TextField } from '@/components/text-field'
import { Muted, Title } from '@/components/typography'
import { authClient } from '@/lib/auth-client'

/**
 * Better Auth's getInvitation endpoint enriches its response with organizationName, organizationSlug and
 * inviterEmail at runtime (see crud-invites.mjs), but the shipped .d.mts return type for the client action
 * omits them — a declaration gap, not a behavior gap. Cast to this view once, at the query boundary.
 */
interface InvitationView { id: string; email: string; role: string | null; expiresAt: Date; organizationId: string; organizationName: string; organizationSlug: string; inviterEmail: string }

export function InviteScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const router = useRouter()
  const queryClient = useQueryClient()
  const { data: session, isPending, refetch } = authClient.useSession()
  const invitation = useQuery({
    queryKey: ['invitation', id], enabled: Boolean(session && id), retry: false,
    queryFn: async () => { const { data, error } = await authClient.organization.getInvitation({ query: { id } }); if (error || !data) throw new Error(error?.message ?? 'not found'); return data as unknown as InvitationView },
  })
  const [yourName, setYourName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (isPending) return <Loading />
  if (!session) return <Redirect href={{ pathname: '/sign-in', params: { next: `/invite/${id}` } }} />
  if (invitation.isPending) return <Loading />
  if (invitation.error || !invitation.data) return <Screen testID="invite"><Title>Invitation not found</Title><Muted>It may have expired or been cancelled. Ask for a new one.</Muted></Screen>
  const inv = invitation.data

  async function accept() {
    setBusy(true); setError(null)
    if (!session?.user.name && yourName.trim()) await authClient.updateUser({ name: yourName.trim() })
    const { error } = await authClient.organization.acceptInvitation({ invitationId: id })
    if (error) { setBusy(false); return setError(error.message?.includes('email') ? `This invitation was sent to ${inv.email}. Sign in with that address.` : 'Could not accept the invitation.') }
    await authClient.organization.setActive({ organizationId: inv.organizationId })
    await refetch(); await queryClient.invalidateQueries()
    router.replace('/')
  }

  return (
    <Screen testID="invite">
      <Title>Join {inv.organizationName}</Title>
      <Muted>{inv.inviterEmail} invited you as {inv.role ?? 'member'}. Signed in as {session.user.email}.</Muted>
      {!session.user.name ? <TextField label="Your name" value={yourName} onChangeText={setYourName} autoComplete="name" /> : null}
      {error ? <Banner tone="error">{error}</Banner> : null}
      <Button label="Accept invitation" onPress={accept} loading={busy} testID="accept-invite" />
    </Screen>
  )
}
