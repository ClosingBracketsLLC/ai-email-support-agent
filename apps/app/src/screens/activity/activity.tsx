import { useQuery } from '@tanstack/react-query'
import { useRouter } from 'expo-router'
import { useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { Banner } from '@/components/banner'
import { ListRow } from '@/components/list-row'
import { Loading } from '@/components/loading'
import { Screen } from '@/components/screen'
import { Heading, Muted } from '@/components/typography'
import { useTRPC } from '@/lib/trpc'
import { font, radius, spacing, typeScale, useColors } from '@/theme'
import { StatTile } from './stat-tile'

type ActivityDays = 7 | 30
const DAY_OPTIONS: readonly ActivityDays[] = [7, 30]

/**
 * The task brief's exact table: `'$0.00'` for zero, `'<$0.01'` for a nonzero amount under a cent
 * (1..9999 micros — cheap sandbox/draft calls routinely land here), otherwise two decimals. A negative
 * is clamped to zero: the api sums non-negative cost micros, so it cannot happen today, and `$-0.00`
 * is not a thing to show an owner if it ever does.
 */
export function formatUsd(micros: number): string {
  const value = Math.max(0, micros)
  if (value === 0) return '$0.00'
  if (value < 10_000) return '<$0.01'
  return `$${(value / 1_000_000).toFixed(2)}`
}

/** Same shape/rounding as `ticket-row.tsx`'s and `mailboxes.tsx`'s own `relativeTime` — each of
 * those screens keeps its own copy rather than sharing one; this one does too. */
function relativeTime(date: Date | null): string {
  if (!date) return ''
  const minutes = Math.max(0, Math.round((Date.now() - date.getTime()) / 60_000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

/** Activity v1 (spec §Activity): counts, AI cost, and the last 20 actual sends, over a 7/30-day
 * window the owner toggles. The screen owns every read; `StatTile` and `ListRow` are presentational. */
export function ActivityScreen() {
  const c = useColors()
  const trpc = useTRPC()
  const router = useRouter()
  const [days, setDays] = useState<ActivityDays>(7)
  const summary = useQuery(trpc.activity.summary.queryOptions({ days }))

  return (
    <Screen testID="activity">
      <Heading>Activity</Heading>

      <View style={styles.segmented} accessibilityRole="tablist" testID="activity-days">
        {DAY_OPTIONS.map((d) => (
          <Pressable
            key={d} role="tab" accessibilityState={{ selected: d === days }} onPress={() => setDays(d)} testID={`activity-days-${d}`}
            style={[styles.tab, { borderColor: c.border, backgroundColor: d === days ? c.primary : c.surface }]}
          >
            <Text style={[typeScale.caption, styles.tabLabel, { color: d === days ? c.onPrimary : c.text }]}>{`${d} days`}</Text>
          </Pressable>
        ))}
      </View>

      {summary.isPending ? (
        <Loading />
      ) : summary.error ? (
        <Banner tone="error">Could not load activity. Pull down to try again.</Banner>
      ) : (
        <>
          <View style={styles.grid}>
            <StatTile testID="stat-drafted" label="Drafted" value={String(summary.data.drafted)} />
            <StatTile
              testID="stat-approved" label="Approved"
              value={String(summary.data.approvedUnchanged + summary.data.approvedEdited)}
              subtitle={`${summary.data.approvedUnchanged} unchanged · ${summary.data.approvedEdited} edited`}
            />
            <StatTile testID="stat-rejected" label="Rejected" value={String(summary.data.rejected)} />
            <StatTile testID="stat-sent" label="Sent" value={String(summary.data.sent)} />
            <StatTile testID="stat-escalated" label="Escalated" value={String(summary.data.escalated)} />
            <StatTile testID="stat-ai-cost" label="AI cost" value={formatUsd(summary.data.costMicros)} />
            <StatTile testID="stat-ai-handled" label="AI-handled conversations" value={String(summary.data.aiHandledConversations)} />
          </View>

          <Heading>Recent sends</Heading>
          {summary.data.recent.length === 0 ? (
            <Muted testID="activity-empty">Nothing sent yet — approve your first draft from the inbox.</Muted>
          ) : (
            <View>
              {summary.data.recent.map((item) => (
                <ListRow
                  key={item.draftId}
                  title={item.subject || '(no subject)'}
                  subtitle={`${item.customerEmail ?? 'Unknown sender'} · ${item.agentAddress ?? 'Unknown agent'} · ${relativeTime(item.sentAt)}`}
                  badge={(item.editDistanceRatio ?? 0) > 0 ? 'edited' : undefined}
                  onPress={() => router.push(`/ticket/${item.ticketId}`)}
                  testID={`activity-recent-${item.draftId}`}
                />
              ))}
            </View>
          )}
        </>
      )}
    </Screen>
  )
}

const styles = StyleSheet.create({
  segmented: { flexDirection: 'row', gap: spacing.xs },
  tab: { flex: 1, borderWidth: 1, borderRadius: radius.md, paddingVertical: spacing.sm, alignItems: 'center' },
  tabLabel: { fontFamily: font.uiStrong },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
})
