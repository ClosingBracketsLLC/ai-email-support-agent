import { useInfiniteQuery } from '@tanstack/react-query'
import { useRouter } from 'expo-router'
import { useState } from 'react'
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View, useWindowDimensions } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import type { InboxSection } from '@aesa/contracts'
import { INBOX_SECTIONS } from '@aesa/contracts'
import { Banner } from '@/components/banner'
import { Loading } from '@/components/loading'
import { Muted } from '@/components/typography'
import { useTRPC } from '@/lib/trpc'
import { WIDE_BREAKPOINT, radius, spacing, typeScale, useColors } from '@/theme'
import { TicketRow, type TicketSummary } from './ticket-row'

const SECTION_LABEL: Record<InboxSection, string> = { to_review: 'To review', auto_sending: 'Auto-sending', recent: 'Recent' }
/** Task brief's exact per-section copy. */
const SECTION_EMPTY: Record<InboxSection, string> = {
  to_review: 'Nothing needs you right now',
  auto_sending: 'Nothing is auto-sending — autopilot arrives later',
  recent: 'Connected mail shows up here',
}
const REFETCH_INTERVAL_MS = 30_000

export function InboxScreen() {
  const c = useColors()
  const trpc = useTRPC()
  const router = useRouter()
  const { width } = useWindowDimensions()
  const wide = width >= WIDE_BREAKPOINT
  const [section, setSection] = useState<InboxSection>('to_review')

  const list = useInfiniteQuery(
    trpc.inbox.list.infiniteQueryOptions(
      { section },
      { getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined, refetchInterval: REFETCH_INTERVAL_MS },
    ),
  )

  const tickets: TicketSummary[] = list.data?.pages.flatMap((p) => p.tickets) ?? []
  // A page served without its cursor (an unparsable one — `parseCursor`): say so rather than let the
  // owner believe a short list is the whole list.
  const degraded = list.data?.pages.some((p) => p.degraded) ?? false

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: c.bg }]} testID="inbox">
      <View style={[styles.body, wide && styles.wideBody]}>
        <View style={styles.column}>
          <View style={styles.segmented} accessibilityRole="tablist" testID="inbox-tabs">
            {INBOX_SECTIONS.map((s) => (
              <Pressable
                key={s} role="tab" accessibilityState={{ selected: s === section }} onPress={() => setSection(s)} testID={`inbox-tab-${s}`}
                style={[styles.tab, { borderColor: c.border, backgroundColor: s === section ? c.primary : c.surface }]}
              >
                <Text style={[typeScale.caption, styles.tabLabel, { color: s === section ? c.onPrimary : c.text }]}>{SECTION_LABEL[s]}</Text>
              </Pressable>
            ))}
          </View>

          {list.isPending ? (
            <Loading />
          ) : list.error ? (
            <Banner tone="error">Could not load the inbox. Pull down to try again.</Banner>
          ) : (
            <FlatList
              data={tickets}
              keyExtractor={(t) => t.id}
              renderItem={({ item }) => <TicketRow ticket={item} onPress={() => router.push(`/ticket/${item.id}`)} />}
              refreshControl={<RefreshControl refreshing={list.isRefetching && !list.isFetchingNextPage} onRefresh={() => list.refetch()} />}
              ListHeaderComponent={degraded ? <Banner testID="inbox-degraded">Some tickets may be missing — pull down to refresh.</Banner> : null}
              ListEmptyComponent={<Muted testID="inbox-empty">{SECTION_EMPTY[section]}</Muted>}
              ListFooterComponent={
                list.hasNextPage ? (
                  <Pressable
                    role="button" accessibilityLabel="Load more" onPress={() => list.fetchNextPage()} disabled={list.isFetchingNextPage} testID="inbox-load-more"
                    style={[styles.loadMore, { borderColor: c.border, opacity: list.isFetchingNextPage ? 0.6 : 1 }]}
                  >
                    <Text style={[typeScale.body, { color: c.text }]}>{list.isFetchingNextPage ? 'Loading…' : 'Load more'}</Text>
                  </Pressable>
                ) : null
              }
              contentContainerStyle={styles.listContent}
            />
          )}
        </View>
      </View>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  body: { flex: 1, padding: spacing.md },
  wideBody: { alignItems: 'center', paddingTop: spacing.xl },
  column: { flex: 1, width: '100%', maxWidth: 560, gap: spacing.md },
  segmented: { flexDirection: 'row', gap: spacing.xs },
  tab: { flex: 1, borderWidth: 1, borderRadius: radius.md, paddingVertical: spacing.sm, alignItems: 'center' },
  tabLabel: { fontWeight: '600' },
  listContent: { gap: 0, paddingBottom: spacing.lg },
  loadMore: { borderWidth: 1, borderRadius: radius.md, paddingVertical: spacing.sm, alignItems: 'center', marginTop: spacing.sm },
})
