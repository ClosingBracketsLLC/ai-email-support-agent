import { useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import type { OrgRole } from '@aesa/contracts'
import { Button } from '@/components/button'
import { spacing, typeScale, useColors } from '@/theme'

export interface MemberLike { id: string; userId: string; role: OrgRole; name: string; email: string }
const ROLE_LABEL: Record<OrgRole, string> = { owner: 'Owner', admin: 'Admin', member: 'Member' }

export function MemberRow({ member, meUserId, canManage, onChangeRole, onRemove }: {
  member: MemberLike; meUserId: string; canManage: boolean
  onChangeRole: (memberId: string, role: 'admin' | 'member') => void; onRemove: (memberId: string) => void
}) {
  const c = useColors()
  const [confirming, setConfirming] = useState(false)
  const me = member.userId === meUserId
  const actionable = canManage && !me && member.role !== 'owner'
  return (
    <View style={[styles.row, { borderBottomColor: c.border }]} testID={`member-${member.id}`}>
      <View style={styles.text}>
        <Text style={[typeScale.body, { color: c.text }]}>{member.name || member.email}</Text>
        <Text style={[typeScale.caption, { color: c.muted }]}>{member.email}</Text>
        {/* Its own Text node (not merged with the email line) so "Owner · you" is an exact, isolated match. */}
        <Text style={[typeScale.caption, { color: c.muted }]}>{ROLE_LABEL[member.role]}{me ? ' · you' : ''}</Text>
      </View>
      {actionable ? (
        <View style={styles.actions}>
          <Button variant="secondary" label={member.role === 'admin' ? 'Make member' : 'Make admin'} onPress={() => onChangeRole(member.id, member.role === 'admin' ? 'member' : 'admin')} />
          <Button variant={confirming ? 'danger' : 'secondary'} label={confirming ? 'Confirm remove' : 'Remove'} onPress={() => (confirming ? onRemove(member.id) : setConfirming(true))} />
        </View>
      ) : null}
    </View>
  )
}
const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth },
  text: { flex: 1, gap: 2 },
  actions: { flexDirection: 'row', gap: spacing.xs },
})
