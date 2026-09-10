import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useEffect, useRef, useState } from 'react'
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import type { RejectAction } from '@aesa/contracts'
import { Banner } from '@/components/banner'
import { Button } from '@/components/button'
import { Chip, type ChipTone } from '@/components/chip'
import { Loading } from '@/components/loading'
import { Heading, Muted } from '@/components/typography'
import { useTRPC } from '@/lib/trpc'
import { radius, spacing, typeScale, useColors } from '@/theme'
import { DraftPanel, type DraftPanelHandle } from './draft-panel'
import { reasonSentence } from './reason-labels'

/** How often the ticket re-reads itself while a reply is on its way out (spec §Send). */
const TICKET_POLL_MS = 10_000

const TICKET_STATUS_TONE: Record<string, ChipTone> = { awaiting_review: 'primary', auto_sending: 'primary', needs_owner: 'warning', waiting_on_customer: 'success', resolved: 'success' }

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

/** The keyboard event this cares about — structural so a test can pass a plain object. */
interface ShortcutEvent { key: string; target?: unknown; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean }

/**
 * The web-only review shortcuts (deviation 13: the draft must be on screen). Pure, so the guard —
 * never steal a key the owner is typing into a field — is testable without a DOM.
 */
export function shortcutFor(event: ShortcutEvent): 'approve' | 'edit' | 'reject' | null {
  if (event.ctrlKey || event.metaKey || event.altKey) return null
  const target = event.target as { tagName?: unknown; isContentEditable?: unknown } | null | undefined
  if (target?.isContentEditable === true) return null
  const tag = typeof target?.tagName === 'string' ? target.tagName.toUpperCase() : ''
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return null
  switch (event.key.toLowerCase()) {
    case 'a': return 'approve'
    case 'e': return 'edit'
    case 'r': return 'reject'
    default: return null
  }
}

/** The api's error shape for a refused approve: `message` is the service's own code and, for the
 * guardrail refusal, `data.findings` carries `{ code, severity, detail }` objects (init.ts's
 * errorFormatter copies them there for any non-500). */
function approveErrorFrom(error: unknown): { code: string; findings?: string[] } {
  const e = error as { message?: unknown; data?: { findings?: unknown } } | null | undefined
  const code = typeof e?.message === 'string' && e.message.length > 0 ? e.message : 'unknown'
  const raw = e?.data?.findings
  if (!Array.isArray(raw)) return { code }
  return { code, findings: raw.map(findingText) }
}
function findingText(raw: unknown): string {
  const f = raw as { code?: unknown; detail?: unknown } | null | undefined
  const code = typeof f?.code === 'string' ? f.code : 'guardrail'
  const detail = typeof f?.detail === 'string' ? f.detail.trim() : ''
  return detail ? `${code}: ${detail}` : code
}

export function TicketScreen({ pollMs = TICKET_POLL_MS, undoTickMs }: { pollMs?: number; undoTickMs?: number } = {}) {
  const { id } = useLocalSearchParams<{ id: string }>()
  const router = useRouter()
  const c = useColors()
  const trpc = useTRPC()
  const queryClient = useQueryClient()

  const query = useQuery(trpc.inbox.ticket.queryOptions({ ticketId: id }, {
    // While a reply is on its way out, and while one is being written; an idle ticket costs nothing
    // (spec §Send).
    refetchInterval: (q) => {
      const data = q.state.data
      const status = data?.draft?.status
      if (status === 'approved' || status === 'sending') return pollMs
      // A reject→redraft leaves this screen with no draft at all while the ticket sits back on
      // `triaged` — exactly the window the reject banner promises a new draft in. Without this the
      // promise is one the screen cannot keep. A `failed` draft counts as none of it: `inbox.ticket`
      // falls back to the newest failed draft when nothing is live, and the ticket is back on
      // `triaged` precisely when `send.execute` found the reply stale and asked for a re-draft.
      if ((!data?.draft || status === 'failed') && data?.ticket?.status === 'triaged') return pollMs
      return false
    },
  }))
  const draft = query.data?.draft ?? null

  // Keyed to the draft, never a bare boolean: a reject→redraft puts a DIFFERENT draft on this same
  // mounted screen, and it has to be opened on its own before Approve comes back.
  const [markedViewedId, setMarkedViewedId] = useState<string | null>(null)
  // Bumped to re-run the viewed-gate effect after a failure: once automatically, then on every tap of
  // the note's Retry.
  const [viewRetryKey, setViewRetryKey] = useState(0)
  const [undoUntil, setUndoUntil] = useState<Date | null>(null)
  const [approveError, setApproveError] = useState<{ code: string; findings?: string[] } | null>(null)
  const [note, setNote] = useState<{ tone: 'info' | 'error'; text: string; retryView?: boolean } | null>(null)
  const [confirmingResolve, setConfirmingResolve] = useState(false)
  const panel = useRef<DraftPanelHandle | null>(null)

  const ticketKey = trpc.inbox.ticket.queryKey({ ticketId: id })
  const listKey = trpc.inbox.list.queryKey()
  const invalidateTicket = () => queryClient.invalidateQueries({ queryKey: ticketKey })
  const invalidateAll = () => Promise.all([
    queryClient.invalidateQueries({ queryKey: ticketKey }),
    queryClient.invalidateQueries({ queryKey: listKey }),
  ])

  const markViewed = useMutation(trpc.drafts.markViewed.mutationOptions({
    onSuccess: (_data, variables) => {
      setMarkedViewedId(variables.draftId)
      setNote((current) => (current?.retryView === true ? null : current))
      void invalidateTicket()
    },
    // Without this the owner is left with a greyed-out Approve and no explanation: the mutation does
    // not retry (TanStack's `retry: 1` in providers.tsx is scoped to queries), `marked` already holds
    // this draft's id, and none of the effect's other deps can change on the failure path.
    onError: (_error, variables) => {
      marked.current = null
      // Exactly one automatic retry per draft — a transient 502 or a dropped connection is the common
      // case and should never reach the owner; anything worse gets a button rather than a retry loop.
      if (autoRetried.current !== variables.draftId) {
        autoRetried.current = variables.draftId
        setViewRetryKey((key) => key + 1)
      }
      setNote({ tone: 'error', text: 'Could not open the draft — tap to retry', retryView: true })
    },
  }))
  const approve = useMutation(trpc.drafts.approve.mutationOptions({
    onSuccess: (data) => {
      setApproveError(null)
      setNote(null)
      setUndoUntil(new Date(data.undoUntil))
      void invalidateAll()
    },
    onError: (error) => setApproveError(approveErrorFrom(error)),
  }))
  const hold = useMutation(trpc.drafts.hold.mutationOptions({
    onSuccess: (data) => {
      // The undo bar was racing a 15-second clock; losing that race is an ordinary result.
      setUndoUntil(null)
      setNote(data.held ? null : {
        tone: 'error',
        text: data.code === 'too_late' ? 'Too late — it already sent.' : 'This reply could not be pulled back.',
      })
      void invalidateAll()
    },
    onError: () => setNote({ tone: 'error', text: 'Could not undo. Try again.' }),
  }))
  const reject = useMutation(trpc.drafts.reject.mutationOptions({
    onSuccess: (data) => {
      setApproveError(null)
      setNote({
        tone: 'info',
        text: data.resolution === 'redraft'
          ? 'The agent is re-drafting — a new draft will appear here.'
          : 'Marked for you to handle.',
      })
      void invalidateAll()
    },
    onError: () => setNote({ tone: 'error', text: 'Could not reject this draft. Try again.' }),
  }))
  const resume = useMutation(trpc.drafts.resume.mutationOptions({
    // `resumed: false` is a race, not an error (the api soft-fails a draft that is no longer `held`).
    onSuccess: (data) => {
      if (!data.resumed) { setNote({ tone: 'info', text: 'This draft is no longer on hold.' }); void invalidateAll(); return }
      setApproveError(null)
      setNote(null)
      void invalidateAll()
    },
    onError: () => setNote({ tone: 'error', text: 'Could not bring this draft back. Try again.' }),
  }))
  const resolve = useMutation(trpc.inbox.resolve.mutationOptions({
    // Likewise `resolved: false`: a foreign or already-resolved ticket resolves nothing and throws nothing.
    onSuccess: (data) => {
      if (!data.resolved) { setNote({ tone: 'info', text: 'This ticket was already resolved.' }); void invalidateAll(); return }
      setConfirmingResolve(false)
      void invalidateAll()
    },
    onError: () => setNote({ tone: 'error', text: 'Could not mark this resolved. Try again.' }),
  }))

  // Exactly once per draft: the approve gate refuses a draft no human has opened (`not_viewed`), and
  // the ref survives the refetch this very mutation's invalidation triggers.
  const marked = useRef<string | null>(null)
  const autoRetried = useRef<string | null>(null)
  useEffect(() => {
    if (!draft || draft.status !== 'pending' || draft.viewedAt !== null) return
    if (marked.current === draft.id) return
    marked.current = draft.id
    markViewed.mutate({ draftId: draft.id })
  }, [draft?.id, draft?.status, draft?.viewedAt, viewRetryKey])

  // A banner about the draft that WAS on screen must not sit under its replacement. Only a real draft
  // clears it: after a reject the live draft is gone (`draft` is null) and "The agent is re-drafting"
  // is exactly the sentence that has to stay until the re-draft lands.
  const draftId = draft?.id ?? null
  useEffect(() => { if (draftId !== null) setNote(null) }, [draftId])

  // The undo window outlives this screen: `DraftView.undoUntil` is set for as long as an approved
  // draft's send is still `queued`, so a reload (or a second device) inside those 15 seconds still
  // gets the Undo button. Keyed on the server value's CHANGES, so `hold`'s optimistic clear below is
  // not undone by the refetch it triggers; the approve mutation's own `undoUntil` overrides it.
  const serverUndoUntil = draft?.undoUntil ?? null
  const serverUndoMs = serverUndoUntil === null ? null : serverUndoUntil.getTime()
  useEffect(() => {
    setUndoUntil(serverUndoMs === null ? null : new Date(serverUndoMs))
  }, [serverUndoMs])

  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return
    const onKeyDown = (event: KeyboardEvent) => {
      const action = shortcutFor(event)
      // No panel on screen means no shortcut — and no swallowed keystroke either (deviation 13).
      if (!action || !panel.current) return
      // Every other guard (viewed, still pending, not already editing) lives in the panel's own handle.
      event.preventDefault()
      panel.current[action]()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

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
  const busy = approve.isPending || hold.isPending || reject.isPending || resume.isPending

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: c.bg }]} testID="ticket">
      <View style={[styles.header, { borderBottomColor: c.border }]}>
        <BackRow onBack={() => router.back()} />
        <Heading numberOfLines={1}>{ticket.subject || '(no subject)'}</Heading>
        <View style={styles.headerMeta}>
          <Chip tone={TICKET_STATUS_TONE[ticket.status] ?? 'neutral'} testID="ticket-status">{ticket.status}</Chip>
          {ticket.agentAddress ? <Muted>{ticket.agentAddress}</Muted> : null}
          {ticket.categoryLabel ? <Muted>{ticket.categoryLabel}</Muted> : null}
        </View>
      </View>

      {sentence ? <View style={styles.padded}><Banner tone="error" testID="ticket-needs-owner">{sentence}</Banner></View> : null}

      {draft ? (
        <View style={styles.padded}>
          <DraftPanel
            draft={draft}
            ticket={{ id: ticket.id, redraftCount: ticket.redraftCount, status: ticket.status }}
            viewed={draft.viewedAt !== null || markedViewedId === draft.id}
            onApprove={(body) => approve.mutate(body === undefined ? { draftId: draft.id } : { draftId: draft.id, body })}
            onHold={() => hold.mutate({ draftId: draft.id })}
            onReject={(action: RejectAction, reason: string) => reject.mutate({ draftId: draft.id, action, reason })}
            onResume={() => resume.mutate({ draftId: draft.id })}
            busy={busy}
            approveError={approveError}
            undoUntil={undoUntil}
            undoTickMs={undoTickMs}
            panelRef={panel}
          />
        </View>
      ) : null}

      {note ? (
        <View style={[styles.padded, styles.noteBox]}>
          <Banner tone={note.tone} testID="ticket-note">{note.text}</Banner>
          {note.retryView ? (
            <Button
              label="Retry"
              variant="secondary"
              onPress={() => { if (!markViewed.isPending) setViewRetryKey((key) => key + 1) }}
              loading={markViewed.isPending}
              testID="retry-view"
            />
          ) : null}
        </View>
      ) : null}

      {ticket.status === 'needs_owner' ? (
        <View style={styles.padded}>
          <Button
            label={confirmingResolve ? 'Confirm resolve' : 'Mark resolved'}
            variant={confirmingResolve ? 'danger' : 'secondary'}
            onPress={() => {
              if (resolve.isPending) return
              if (!confirmingResolve) { setConfirmingResolve(true); return }
              resolve.mutate({ ticketId: ticket.id })
            }}
            loading={resolve.isPending}
            testID="resolve"
          />
        </View>
      ) : null}

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
  padded: { paddingHorizontal: spacing.md, paddingBottom: spacing.sm },
  noteBox: { gap: spacing.sm },
  header: { padding: spacing.md, gap: spacing.xs, borderBottomWidth: StyleSheet.hairlineWidth },
  backRow: { paddingVertical: spacing.xs },
  headerMeta: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap', alignItems: 'center' },
  messages: { padding: spacing.md, gap: spacing.sm },
  bubbleRow: { flexDirection: 'row' },
  bubbleRowOut: { justifyContent: 'flex-end' },
  bubble: { maxWidth: '85%', borderWidth: 1, borderRadius: radius.lg, padding: spacing.sm, gap: 2 },
})
