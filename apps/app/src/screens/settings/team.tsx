import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { canManageWorkspace } from '@aesa/contracts'
import { Banner } from '@/components/banner'
import { Button } from '@/components/button'
import { Card } from '@/components/card'
import { ListRow } from '@/components/list-row'
import { Loading } from '@/components/loading'
import { Screen } from '@/components/screen'
import { TextField } from '@/components/text-field'
import { Heading, Muted } from '@/components/typography'
import { authClient } from '@/lib/auth-client'
import { useTRPC } from '@/lib/trpc'
import { radius, spacing, typeScale, useColors } from '@/theme'
import { MemberRow } from './member-row'

export function TeamScreen() {
  const c = useColors()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const { data: session } = authClient.useSession()
  const ws = useQuery(trpc.workspace.get.queryOptions())
  const team = useQuery(trpc.team.list.queryOptions())
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<'admin' | 'member'>('member')
  const [error, setError] = useState<string | null>(null)
  const refresh = () => queryClient.invalidateQueries({ queryKey: trpc.team.list.queryKey() })
  const invite = useMutation(trpc.team.invite.mutationOptions({ onSuccess: () => { setEmail(''); refresh() }, onError: () => setError('Could not send the invitation.') }))
  const cancel = useMutation(trpc.team.cancelInvitation.mutationOptions({ onSuccess: refresh }))
  const changeRole = useMutation(trpc.team.changeRole.mutationOptions({ onSuccess: refresh, onError: () => setError('Could not change the role.') }))
  const remove = useMutation(trpc.team.remove.mutationOptions({ onSuccess: refresh, onError: () => setError('Could not remove the member.') }))

  if (!ws.data || !team.data || !session) return <Loading />
  const canManage = canManageWorkspace(ws.data.role)
  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())

  function sendInvite() {
    if (invite.isPending) return
    setError(null)
    invite.mutate({ email: email.trim(), role })
  }

  return (
    <Screen testID="team">
      <Heading>Members</Heading>
      {team.data.members.map((m) => (
        <MemberRow key={m.id} member={m} meUserId={session.user.id} canManage={canManage}
          onChangeRole={(memberId, r) => changeRole.mutate({ memberId, role: r })} onRemove={(memberId) => remove.mutate({ memberId })} />
      ))}
      {team.data.invitations.length ? <Heading>Pending invitations</Heading> : null}
      {team.data.invitations.map((i) => (
        <ListRow key={i.id} title={i.email} subtitle={`${i.role} · expires ${i.expiresAt.toLocaleDateString()}`} badge={canManage ? 'Cancel' : undefined} onPress={canManage ? () => cancel.mutate({ invitationId: i.id }) : undefined} testID={`invitation-${i.id}`} />
      ))}
      {canManage ? (
        <Card testID="invite-form">
          <Heading>Invite a teammate</Heading>
          <TextField label="Email" value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" testID="invite-email" />
          <View style={styles.roles}>
            {(['member', 'admin'] as const).map((r) => (
              <Pressable key={r} role="radio" accessibilityState={{ checked: role === r }} onPress={() => setRole(r)} testID={`invite-role-${r}`}
                style={[styles.role, { borderColor: role === r ? c.primary : c.border, backgroundColor: role === r ? c.info : c.bg }]}>
                <Text style={[typeScale.body, { color: c.text }]}>{r === 'admin' ? 'Admin — can edit settings and manage the team' : 'Member — can review, cannot change settings'}</Text>
              </Pressable>
            ))}
          </View>
          <Button label="Send invitation" onPress={sendInvite} loading={invite.isPending} disabled={!emailOk} testID="send-invite" />
        </Card>
      ) : <Muted>Only owners and admins can invite teammates.</Muted>}
      {error ? <Banner tone="error">{error}</Banner> : null}
    </Screen>
  )
}
const styles = StyleSheet.create({
  roles: { gap: spacing.sm },
  role: { borderWidth: 1, borderRadius: radius.md, padding: spacing.md },
})
