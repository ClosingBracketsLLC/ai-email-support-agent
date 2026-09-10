import { Pressable, StyleSheet, Text, View } from 'react-native'
import type { NeedsOwnerReason } from '@aesa/contracts'
import { radius, spacing, typeScale, useColors } from '@/theme'

/** The client-side view of `inbox.list`'s `TicketSummary` (apps/api/src/trpc/routers/inbox.ts).
 * Declared explicitly rather than inferred off `AppRouter` so `TicketRow` (and its test) don't need
 * a type-only import of `@aesa/api` just to describe one row — same reasoning as `invite.tsx`'s
 * `InvitationView`. */
export interface TicketSummary {
  id: string
  subject: string | null
  customerEmail: string | null
  customerName: string | null
  status: string
  needsOwnerReason: string | null
  categoryKey: string | null
  categoryLabel: string | null
  sentiment: string | null
  lastInboundAt: Date | null
  inboundCount: number
  agentAddress: string | null
  spamFlagged: boolean
  hasAttachments: boolean
}

/** Spec's four reason words plus 'Capped' for the cap reason (task brief), plus Phase 3's twelve
 * drafting/review reasons (Task 2 controller ruling). */
const REASON_CHIP: Record<NeedsOwnerReason, string> = {
  tripwire: 'Tripwire',
  triage_flags: 'Flagged',
  sentiment_angry: 'Angry',
  triage_failed: 'Failed',
  triage_cap: 'Capped',
  agent_escalated: 'Escalated',
  agent_failed: 'Failed',
  agent_run_cap: 'Capped',
  guardrail_failed: 'Blocked',
  redraft_limit_reached: 'Re-drafted 2×',
  redraft_unfulfilled: 'Needs you',
  owner_handling: 'Yours',
  orphaned: 'Lost draft',
  draft_expired: 'Expired',
  send_failed: 'Not sent',
  category_off: 'Off',
  no_agent: 'No agent',
}

/** `needsOwnerReason` is a plain `text` column (checked by the API, not a drizzle `pgEnum`), so the
 * tRPC-inferred type is a bare `string | null` — same defensive lookup as `agents.tsx`'s `label()`. */
function reasonChip(reason: string | null): string | null {
  if (!reason) return null
  return (REASON_CHIP as Record<string, string>)[reason] ?? null
}

function relativeTime(date: Date | null): string {
  if (!date) return 'no messages yet'
  const minutes = Math.max(0, Math.round((Date.now() - date.getTime()) / 60_000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

export function TicketRow({ ticket, onPress }: { ticket: TicketSummary; onPress: () => void }) {
  const c = useColors()
  const chip = reasonChip(ticket.needsOwnerReason)
  const subject = ticket.subject || '(no subject)'
  const customer = ticket.customerName || ticket.customerEmail || 'Unknown sender'

  return (
    <Pressable
      role="button" accessibilityLabel={subject} onPress={onPress} testID={`ticket-row-${ticket.id}`}
      style={({ pressed }) => [styles.row, { borderColor: c.border, opacity: pressed ? 0.7 : 1 }]}
    >
      <View style={styles.main}>
        <View style={styles.titleLine}>
          <Text style={[typeScale.body, styles.subject, { color: c.text }]} numberOfLines={1}>{subject}</Text>
          {ticket.spamFlagged ? <Text testID={`ticket-spam-${ticket.id}`} accessibilityLabel="Marked as spam">🚫</Text> : null}
          {ticket.hasAttachments ? <Text testID={`ticket-attachment-${ticket.id}`} accessibilityLabel="Has attachments">📎</Text> : null}
        </View>
        <Text style={[typeScale.caption, { color: c.muted }]} numberOfLines={1}>{customer}</Text>
        <View style={styles.metaLine}>
          <Text style={[typeScale.caption, { color: c.muted }]}>{relativeTime(ticket.lastInboundAt)}</Text>
          {ticket.categoryLabel ? <Text style={[typeScale.caption, { color: c.muted }]}> · {ticket.categoryLabel}</Text> : null}
        </View>
      </View>
      {chip ? (
        <View style={[styles.chip, { borderColor: c.border, backgroundColor: c.info }]} testID={`ticket-reason-${ticket.id}`}>
          <Text style={[typeScale.caption, { color: c.text }]}>{chip}</Text>
        </View>
      ) : null}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.sm, paddingHorizontal: spacing.md, borderBottomWidth: StyleSheet.hairlineWidth },
  main: { flex: 1, gap: 2 },
  titleLine: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  subject: { flex: 1, fontWeight: '600' },
  metaLine: { flexDirection: 'row' },
  chip: { borderWidth: 1, borderRadius: radius.lg, paddingHorizontal: spacing.sm, paddingVertical: 2 },
})
