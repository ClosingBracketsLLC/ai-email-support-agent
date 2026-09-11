import { Pressable, StyleSheet, Text, View } from 'react-native'
import type { DraftStatus, NeedsOwnerReason } from '@aesa/contracts'
import { Chip, type ChipTone } from '@/components/chip'
import { spacing, typeScale, useColors } from '@/theme'

/** The ticket's ONE live draft, as `inbox.list` joins it (apps/api/src/trpc/routers/inbox.ts) —
 * just enough for a row's chip; the review panel loads the full `DraftView`. */
export interface TicketDraftSummary {
  id: string
  status: DraftStatus
  confidence: number | null
  decisionReason: string
  expiresAt: Date
  version: number
}

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
  draft: TicketDraftSummary | null
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

/** Spec §3's three state colours where they apply, primary for the agent's own progress, neutral otherwise. */
const REASON_TONE: Record<NeedsOwnerReason, ChipTone> = {
  tripwire: 'warning', triage_flags: 'warning', sentiment_angry: 'warning', triage_failed: 'danger', triage_cap: 'warning',
  agent_escalated: 'warning', agent_failed: 'danger', agent_run_cap: 'warning', guardrail_failed: 'danger',
  redraft_limit_reached: 'warning', redraft_unfulfilled: 'warning', owner_handling: 'neutral', orphaned: 'warning',
  draft_expired: 'warning', send_failed: 'danger', category_off: 'neutral', no_agent: 'neutral',
}
function reasonTone(reason: string | null): ChipTone { return (reason && (REASON_TONE as Record<string, ChipTone>)[reason]) || 'neutral' }
function draftTone(draft: TicketDraftSummary | null): ChipTone { return draft?.status === 'held' ? 'warning' : 'primary' }

/** The draft's own word on the row: what the agent has ready, or where its reply has got to. */
function draftChip(draft: TicketDraftSummary | null, categoryLabel: string | null): string | null {
  if (!draft) return null
  if (draft.status === 'approved' || draft.status === 'sending') return 'Sending…'
  if (draft.status === 'held') return 'On hold'
  if (draft.status !== 'pending') return null
  const pct = draft.confidence === null ? null : `${Math.round(draft.confidence * 100)}%`
  return ['Reply ready', categoryLabel ?? 'Uncategorized', ...(pct ? [pct] : [])].join(' · ')
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
  const draft = draftChip(ticket.draft, ticket.categoryLabel)
  const subject = ticket.subject || '(no subject)'
  const customer = ticket.customerName || ticket.customerEmail || 'Unknown sender'

  return (
    <Pressable
      role="button" accessibilityLabel={subject} onPress={onPress} testID={`ticket-row-${ticket.id}`}
      style={({ pressed }) => [styles.row, { borderColor: c.border, opacity: pressed ? 0.7 : 1 }]}
    >
      <View style={styles.main}>
        <View style={styles.titleLine}>
          <Text style={[typeScale.bodyStrong, styles.subject, { color: c.text }]} numberOfLines={1}>{subject}</Text>
          {ticket.spamFlagged ? <Text testID={`ticket-spam-${ticket.id}`} accessibilityLabel="Marked as spam">🚫</Text> : null}
          {ticket.hasAttachments ? <Text testID={`ticket-attachment-${ticket.id}`} accessibilityLabel="Has attachments">📎</Text> : null}
        </View>
        <Text style={[typeScale.caption, { color: c.muted }]} numberOfLines={1}>{customer}</Text>
        <View style={styles.metaLine}>
          <Text style={[typeScale.caption, { color: c.muted }]}>{relativeTime(ticket.lastInboundAt)}</Text>
          {ticket.categoryLabel ? <Text style={[typeScale.caption, { color: c.muted }]}> · {ticket.categoryLabel}</Text> : null}
        </View>
      </View>
      {draft || chip ? (
        <View style={styles.chips}>
          {draft ? <Chip tone={draftTone(ticket.draft)} testID={`ticket-draft-${ticket.id}`}>{draft}</Chip> : null}
          {chip ? <Chip tone={reasonTone(ticket.needsOwnerReason)} testID={`ticket-reason-${ticket.id}`}>{chip}</Chip> : null}
        </View>
      ) : null}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.sm, paddingHorizontal: spacing.md, borderBottomWidth: StyleSheet.hairlineWidth },
  main: { flex: 1, gap: 2 },
  titleLine: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  subject: { flex: 1 },
  metaLine: { flexDirection: 'row' },
  chips: { alignItems: 'flex-end', gap: spacing.xs },
})
