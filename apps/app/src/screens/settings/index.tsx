import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useRouter } from 'expo-router'
import { useState } from 'react'
import { Banner } from '@/components/banner'
import { Button } from '@/components/button'
import { ListRow } from '@/components/list-row'
import { Screen } from '@/components/screen'
import { Heading, Muted } from '@/components/typography'
import { authClient } from '@/lib/auth-client'
import { useTRPC } from '@/lib/trpc'

export function SettingsIndexScreen() {
  const trpc = useTRPC()
  const router = useRouter()
  const queryClient = useQueryClient()
  const { data: session, refetch } = authClient.useSession()
  const { data: organizations } = authClient.useListOrganizations()
  const ws = useQuery(trpc.workspace.get.queryOptions())
  const [switching, setSwitching] = useState<string | null>(null)
  const [switchError, setSwitchError] = useState<string | null>(null)

  async function switchTo(orgId: string) {
    if (switching) return
    setSwitching(orgId)
    setSwitchError(null)
    try {
      const { error } = await authClient.organization.setActive({ organizationId: orgId })
      if (error) throw new Error(error.message ?? 'switch failed')
      await refetch()
      await queryClient.invalidateQueries()
      router.replace('/')
    } catch {
      setSwitchError('Could not switch workspace. Try again.')
    } finally {
      setSwitching(null)
    }
  }
  async function signOut() {
    await authClient.signOut()
    queryClient.clear()
    router.replace('/sign-in')
  }

  return (
    <Screen testID="settings">
      <Heading>{ws.data?.businessName ?? 'Workspace'}</Heading>
      <ListRow title="Workspace profile" subtitle="Website, tone, links the agent may share" onPress={() => router.push('/settings/workspace')} testID="settings-workspace" />
      <ListRow title="Team" subtitle="Invite teammates, change roles" onPress={() => router.push('/settings/team')} testID="settings-team" />
      <ListRow title="Notifications" subtitle="Push on this device" onPress={() => router.push('/settings/notifications')} testID="settings-notifications" />
      <ListRow title="Mailboxes" subtitle="Connect Gmail or Microsoft 365" badge="Phase 2" />
      <ListRow title="Agents" subtitle="Personas, signatures, per-agent guidance" badge="Phase 2" />
      <ListRow title="Autopilot" subtitle="Off / Review / Auto per category" badge="Phase 5" />
      <ListRow title="AI" subtitle="Managed AI or your own provider" badge="Phase 6" />
      <ListRow title="Billing" subtitle="Plan, domains, usage" badge="Phase 7" />
      {organizations && organizations.length > 1 ? (
        <>
          <Heading>Switch workspace</Heading>
          {organizations.filter((o) => o.id !== session?.session.activeOrganizationId).map((o) => (
            <ListRow key={o.id} title={o.name} onPress={switching ? undefined : () => switchTo(o.id)} badge={switching === o.id ? '…' : undefined} />
          ))}
          {switchError ? <Banner tone="error" testID="switch-error">{switchError}</Banner> : null}
        </>
      ) : null}
      <Heading>Account</Heading>
      <Muted>Signed in as {session?.user.email}</Muted>
      <Button variant="secondary" label="Sign out" onPress={signOut} testID="sign-out" />
      <Muted><Link href="/privacy">Privacy</Link> · <Link href="/terms">Terms</Link></Muted>
    </Screen>
  )
}
