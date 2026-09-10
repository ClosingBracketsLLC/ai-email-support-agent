import { useQuery } from '@tanstack/react-query'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import type { NeedsOwnerReason } from '@aesa/contracts'
import { Banner } from '@/components/banner'
import { Loading } from '@/components/loading'
import { Heading, Muted } from '@/components/typography'
import { useTRPC } from '@/lib/trpc'
import { radius, spacing, typeScale, useColors } from '@/theme'

/** One sentence per `NeedsOwnerReason` (task brief: "needs_owner banner with the reason sentence"),
 * plus Phase 3's twelve drafting/review reasons (Task 2 controller ruling). */
const REASON_SENTENCE: Record<NeedsOwnerReason, string> = {
  tripwire: 'A tripwire term was found in this thread — it needs your review before anything is sent.',
  triage_flags: 'Triage flagged this message — it needs your review.',
  sentiment_angry: 'This customer sounds angry — it needs your review.',
  triage_failed: 'Triage could not read this message, so it needs your review.',
  triage_cap: "This category has hit today's review cap, so it needs your review.",
  agent_escalated: 'The agent asked for a human on this one — it needs your reply.',
  agent_failed: 'Drafting failed twice, so this ticket needs your reply.',
  agent_run_cap: "This ticket hit today's drafting limit — it needs your reply.",
  guardrail_failed: 'The guardrails blocked this draft. Edit it — the edited version has to pass before it can send.',
  redraft_limit_reached: 'Re-drafted twice already — please reply yourself.',
  redraft_unfulfilled: 'The agent could not act on your feedback — it needs your reply.',
  owner_handling: 'You chose to handle this one yourself.',
  orphaned: 'This ticket lost its draft — it needs your review.',
  draft_expired: 'A draft expired unreviewed — it needs your review.',
  send_failed: 'An approved reply could not be sent — check the mailbox and try again.',
  category_off: 'This category is switched off, so replies wait for you.',
  no_agent: 'No agent is set up for this address yet.',
}

/** `needsOwnerReason` is a plain `text` column, so the tRPC-inferred type is a bare `string | null`
 * — same defensive lookup as `ticket-row.tsx`'s `reasonChip`. */
function reasonSentence(reason: string | null): string | null {
  if (!reason) return null
  return (REASON_SENTENCE as Record<string, string>)[reason] ?? null
}

interface AttachmentMeta { filename?: string; mime?: string; size?: number }
/** `messages.attachments` is a jsonb column typed `unknown` at the schema level (comment: "[{filename,
 * mime, size}] metadata only") — narrowed defensively rather than trusted. */
function attachmentList(raw: unknown): AttachmentMeta[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((a): a is AttachmentMeta => typeof a === 'object' && a !== null)
}
function formatBytes(size: number | undefined): string {
  if (!size || size <= 0) return ''
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

export function TicketScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const router = useRouter()
  const c = useColors()
  const trpc = useTRPC()
  const query = useQuery(trpc.inbox.ticket.queryOptions({ ticketId: id }))

  if (query.isPending) return <Loading testID="ticket-loading" />

  if (query.error || !query.data) {
    return (
      <SafeAreaView style={[styles.safe, { backgroundColor: c.bg }]} testID="ticket">
        <BackRow onBack={() => router.back()} />
        <View style={styles.padded}><Banner tone="error">Ticket not found.</Banner></View>
      </SafeAreaView>
    )
  }

  const { ticket, messages } = query.data
  const sentence = reasonSentence(ticket.needsOwnerReason)

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: c.bg }]} testID="ticket">
      <View style={[styles.header, { borderBottomColor: c.border }]}>
        <BackRow onBack={() => router.back()} />
        <Heading numberOfLines={1}>{ticket.subject || '(no subject)'}</Heading>
        <View style={styles.headerMeta}>
          <View style={[styles.statusChip, { borderColor: c.border }]} testID="ticket-status">
            <Text style={[typeScale.caption, { color: c.text }]}>{ticket.status}</Text>
          </View>
          {ticket.agentAddress ? <Muted>{ticket.agentAddress}</Muted> : null}
          {ticket.categoryLabel ? <Muted>{ticket.categoryLabel}</Muted> : null}
        </View>
      </View>

      {sentence ? <View style={styles.padded}><Banner tone="error" testID="ticket-needs-owner">{sentence}</Banner></View> : null}

      <ScrollView contentContainerStyle={styles.messages} testID="ticket-messages">
        {messages.map((m) => {
          const outbound = m.direction === 'outbound'
          const attachments = attachmentList(m.attachments)
          return (
            <View key={m.id} style={[styles.bubbleRow, outbound && styles.bubbleRowOut]}>
              <View style={[styles.bubble, { backgroundColor: outbound ? c.primary : c.surface, borderColor: c.border }]} testID={`message-${m.id}`}>
                {!outbound && m.dmarcPass === false ? <Muted testID={`message-unverified-${m.id}`}>unverified sender</Muted> : null}
                <Text style={{ color: outbound ? c.onPrimary : c.text }}>{m.bodyText ?? ''}</Text>
                {attachments.map((a, i) => (
                  <Text key={i} style={[typeScale.caption, { color: outbound ? c.onPrimary : c.muted }]} testID={`message-attachment-${m.id}-${i}`}>
                    {(a.filename ?? 'attachment') + (formatBytes(a.size) ? ` · ${formatBytes(a.size)}` : '')}
                  </Text>
                ))}
              </View>
            </View>
          )
        })}
      </ScrollView>
    </SafeAreaView>
  )
}

function BackRow({ onBack }: { onBack: () => void }) {
  const c = useColors()
  return (
    <Pressable role="button" accessibilityLabel="Back" onPress={onBack} testID="ticket-back" style={styles.backRow}>
      <Text style={[typeScale.body, { color: c.primary }]}>‹ Back</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  padded: { paddingHorizontal: spacing.md },
  header: { padding: spacing.md, gap: spacing.xs, borderBottomWidth: StyleSheet.hairlineWidth },
  backRow: { paddingVertical: spacing.xs },
  headerMeta: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap', alignItems: 'center' },
  statusChip: { borderWidth: 1, borderRadius: radius.lg, paddingHorizontal: spacing.sm, paddingVertical: 2 },
  messages: { padding: spacing.md, gap: spacing.sm },
  bubbleRow: { flexDirection: 'row' },
  bubbleRowOut: { justifyContent: 'flex-end' },
  bubble: { maxWidth: '85%', borderWidth: 1, borderRadius: radius.lg, padding: spacing.sm, gap: 2 },
})
