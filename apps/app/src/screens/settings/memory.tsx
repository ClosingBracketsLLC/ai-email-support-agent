import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'expo-router'
import { useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import type { MemoryTab, RetiredReason, ReviewReason } from '@aesa/contracts'
import { MEMORY_TABS, canManageWorkspace } from '@aesa/contracts'
import { Banner } from '@/components/banner'
import { Button } from '@/components/button'
import { Card } from '@/components/card'
import { Chip, type ChipTone } from '@/components/chip'
import { Loading } from '@/components/loading'
import { Screen } from '@/components/screen'
import { TextField } from '@/components/text-field'
import { Body, Heading, Muted } from '@/components/typography'
import { useTRPC } from '@/lib/trpc'
import { font, radius, spacing, typeScale, useColors } from '@/theme'

const TAB_LABEL: Record<MemoryTab, string> = { to_check: 'To check', active: 'Active', retired: 'Retired' }
const TAB_EMPTY: Record<MemoryTab, string> = {
  to_check: 'Nothing to check — the agent samples its own auto-sends',
  active: 'Nothing learned yet — answers arrive as you approve replies',
  retired: 'Nothing retired yet',
}

/** Why an active answer was parked for the owner (`REVIEW_REASONS`), in the owner's words. */
const REVIEW_SENTENCE: Record<ReviewReason, string> = {
  model_conflict: 'The agent has answered this differently since',
  edited_reuse: 'You edited a reply that reused this',
  source_changed: 'The knowledge behind it changed',
}
/** Why an answer is no longer used (`RETIRED_REASONS`). */
const RETIRED_SENTENCE: Record<RetiredReason, string> = {
  owner: 'You retired this',
  strikes: 'Wrong too often',
  expired: 'Expired after a year unused',
  unsampled: 'Never checked in time',
  sampled_bad: 'You said it should not have been sent',
  source_changed: 'The knowledge behind it changed',
}

/** `status`, `review_reason` and `retired_reason` are plain `text` columns, so the tRPC-inferred type
 * is a bare `string` — same defensive lookup as `agents.tsx`'s `label()`. */
function lookup<T extends string>(map: Record<T, string>, value: string | null): string | null {
  return value === null ? null : ((map as Record<string, string>)[value] ?? null)
}

function statusChip(row: { status: string; approvals: number; reviewReason: string | null; retiredReason: string | null }): { text: string; tone: ChipTone } {
  if (row.status === 'candidate') return { text: 'Auto-sent · unchecked', tone: 'warning' }
  if (row.status === 'needs_review') return { text: lookup(REVIEW_SENTENCE, row.reviewReason) ?? 'Needs a look', tone: 'warning' }
  if (row.status === 'active') return { text: `${row.approvals} approvals`, tone: 'success' }
  return { text: lookup(RETIRED_SENTENCE, row.retiredReason) ?? 'Retired', tone: 'neutral' }
}

/**
 * Learned answers (spec §Learning loop): what the agent remembers, the owner's verdict on the
 * auto-sends it sampled, and the privacy escape hatch — forget everything learned from one customer.
 *
 * Reading is every teammate's business (`memory.list`/`summary` are `orgProcedure`); every decision
 * is a `managerProcedure`, so a plain member gets the same rows with no buttons rather than a call
 * that would just 403.
 */
export function MemoryScreen() {
  const c = useColors()
  const trpc = useTRPC()
  const router = useRouter()
  const queryClient = useQueryClient()
  const [tab, setTab] = useState<MemoryTab>('to_check')
  const [email, setEmail] = useState('')
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [deleted, setDeleted] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  const ws = useQuery(trpc.workspace.get.queryOptions())
  const summary = useQuery(trpc.memory.summary.queryOptions())
  const list = useQuery(trpc.memory.list.queryOptions({ tab }))

  async function refresh() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: trpc.memory.list.queryKey() }),
      queryClient.invalidateQueries({ queryKey: trpc.memory.summary.queryKey() }),
    ])
  }
  // One shape for all four decisions: they differ only in which procedure they call.
  const decided = { onSuccess: () => { setError(null); void refresh() }, onError: () => setError('Could not save that. Try again.') }
  const keep = useMutation(trpc.memory.keep.mutationOptions(decided))
  const retire = useMutation(trpc.memory.retire.mutationOptions(decided))
  const confirmCandidate = useMutation(trpc.memory.confirmCandidate.mutationOptions(decided))
  const rejectCandidate = useMutation(trpc.memory.rejectCandidate.mutationOptions(decided))
  const deleteByCustomer = useMutation(trpc.memory.deleteByCustomer.mutationOptions({
    onSuccess: (data: { deleted: number }) => {
      setError(null)
      setConfirmingDelete(false)
      setEmail('')
      setDeleted(data.deleted)
      void refresh()
    },
    onError: () => setError('Could not delete those answers. Try again.'),
  }))

  if (!ws.data) return <Loading />
  const canManage = canManageWorkspace(ws.data.role)
  const busy = keep.isPending || retire.isPending || confirmCandidate.isPending || rejectCandidate.isPending

  function submitDelete() {
    if (deleteByCustomer.isPending || email.trim().length === 0) return
    if (!confirmingDelete) { setConfirmingDelete(true); return }
    setError(null)
    setDeleted(null)
    deleteByCustomer.mutate({ email: email.trim() })
  }

  return (
    <Screen testID="memory">
      <Heading>Learned answers</Heading>
      <Muted>Answers the agent reuses when the same question comes back.</Muted>
      {summary.data ? (
        <Muted testID="memory-summary">{`${summary.data.toCheck} to check · ${summary.data.active} active · ${summary.data.retired} retired`}</Muted>
      ) : null}
      {!canManage ? <Muted testID="memory-readonly">Only owners and admins can change what the agent remembers.</Muted> : null}

      <View style={styles.segmented} accessibilityRole="tablist" testID="memory-tabs">
        {MEMORY_TABS.map((t) => (
          <Pressable
            key={t} role="tab" accessibilityState={{ selected: t === tab }} accessibilityLabel={TAB_LABEL[t]}
            onPress={() => setTab(t)} testID={`memory-tab-${t}`}
            style={[styles.tab, { borderColor: c.border, backgroundColor: t === tab ? c.primary : c.surface }]}
          >
            <Text style={[typeScale.caption, styles.tabLabel, { color: t === tab ? c.onPrimary : c.text }]}>{TAB_LABEL[t]}</Text>
          </Pressable>
        ))}
      </View>

      {error ? <Banner tone="error" testID="memory-error">{error}</Banner> : null}

      {!list.data ? <Loading /> : list.data.answers.length === 0 ? (
        <Muted testID="memory-empty">{TAB_EMPTY[tab]}</Muted>
      ) : (
        list.data.answers.map((row) => {
          const chip = statusChip(row)
          return (
            <Card key={row.id} testID={`answer-${row.id}`}>
              <Chip tone={chip.tone} testID={`answer-status-${row.id}`}>{chip.text}</Chip>
              <Muted>{`Q: ${row.question}`}</Muted>
              <Body style={styles.answerBody}>{`A: ${row.answer}`}</Body>
              <Muted>{`${row.categoryLabel ?? 'Uncategorized'} · ${row.agentAddress ?? ''}`}</Muted>
              {canManage && row.status === 'candidate' ? (
                <>
                  <Button label="Looks good" onPress={() => confirmCandidate.mutate({ answerId: row.id })} disabled={busy} testID={`confirm-${row.id}`} />
                  <Button label="Should not have sent" variant="danger" onPress={() => rejectCandidate.mutate({ answerId: row.id })} disabled={busy} testID={`reject-${row.id}`} />
                </>
              ) : null}
              {canManage && row.status === 'needs_review' ? (
                <Button label="Keep" onPress={() => keep.mutate({ answerId: row.id })} disabled={busy} testID={`keep-${row.id}`} />
              ) : null}
              {canManage && (row.status === 'needs_review' || row.status === 'active') ? (
                <Button label="Retire" variant="secondary" onPress={() => retire.mutate({ answerId: row.id })} disabled={busy} testID={`retire-${row.id}`} />
              ) : null}
              {row.sourceTicketId ? (
                <Button label="Open ticket" variant="secondary" onPress={() => router.push(`/ticket/${row.sourceTicketId}`)} testID={`open-ticket-${row.id}`} />
              ) : null}
            </Card>
          )
        })
      )}

      {canManage ? (
        <Card testID="delete-by-customer">
          <Heading>Forget one customer</Heading>
          <Muted>Deletes every answer learned from this person&apos;s emails. This cannot be undone.</Muted>
          <TextField
            label="Customer email" value={email} onChangeText={(v) => { setEmail(v); setConfirmingDelete(false); setDeleted(null) }}
            autoCapitalize="none" keyboardType="email-address" testID="delete-customer-email"
          />
          <Button
            label={confirmingDelete ? 'Confirm delete' : 'Delete everything learned from this customer'}
            variant={confirmingDelete ? 'danger' : 'secondary'}
            onPress={submitDelete} loading={deleteByCustomer.isPending} disabled={email.trim().length === 0}
            testID="delete-customer-submit"
          />
          {deleted !== null ? <Banner tone="success" testID="delete-customer-done">{`Deleted ${deleted} answers`}</Banner> : null}
        </Card>
      ) : null}
    </Screen>
  )
}

const styles = StyleSheet.create({
  segmented: { flexDirection: 'row', gap: spacing.xs },
  tab: { flex: 1, borderWidth: 1, borderRadius: radius.md, paddingVertical: spacing.sm, alignItems: 'center' },
  tabLabel: { fontFamily: font.uiStrong },
  answerBody: { fontFamily: font.mono },
})
