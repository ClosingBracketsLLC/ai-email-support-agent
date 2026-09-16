import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useEffect, useRef, useState } from 'react'
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { canManageWorkspace, type RejectAction } from '@aesa/contracts'
import { Banner } from '@/components/banner'
import { Button } from '@/components/button'
import { Chip, type ChipTone } from '@/components/chip'
import { Loading } from '@/components/loading'
import { Heading, Muted } from '@/components/typography'
import { useTRPC } from '@/lib/trpc'
import { spacing, typeScale, useColors } from '@/theme'
import { DraftPanel, type DraftPanelHandle } from './draft-panel'
import { MessageBubble } from './message-bubble'
import { reasonSentence } from './reason-labels'

/** How often the ticket re-reads itself while a reply is on its way out (spec §Send). */
const TICKET_POLL_MS = 10_000

const TICKET_STATUS_TONE: Record<string, ChipTone> = { awaiting_review: 'primary', auto_sending: 'primary', needs_owner: 'warning', waiting_on_customer: 'success', resolved: 'success' }

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

/** `memory.rememberReply`'s own refusals are already owner-facing sentences straight from the router
 * (there is no `MEMORY_ERROR_MESSAGES` catalog the way billing and workspace have one) — rendered as
 * given rather than re-worded, with a generic fallback for anything that is not a string at all. */
function rememberErrorText(error: unknown): string {
  const message = (error as { message?: unknown } | null | undefined)?.message
  return typeof message === 'string' && message.length > 0 ? message : 'Could not save that. Try again.'
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
  // "Remember this reply" is `managerProcedure` on the api (owner/admin): a member who could tap it
  // would only be shown FORBIDDEN, so the button is offered on the role alone. `workspace.get` is
  // already cached by the gate, so this costs no request.
  const ws = useQuery(trpc.workspace.get.queryOptions())
  const canRemember = ws.data ? canManageWorkspace(ws.data.role) : false

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
  // Which message id "Remember this reply" was last pressed for — scopes the pending spinner to the
  // one bubble it belongs to rather than every outbound bubble on screen.
  const [rememberingId, setRememberingId] = useState<string | null>(null)
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
      const resolution = data.resolution === 'redraft'
        ? 'The agent is re-drafting — a new draft will appear here.'
        : 'Marked for you to handle.'
      // `guidanceAdded` is false when the owner did not ask — and also when they did but the
      // guidance was already at its cap, so this claims it only when the api actually appended it.
      setNote({ tone: 'info', text: data.guidanceAdded ? `${resolution} Added to your guidance.` : resolution })
      void invalidateAll()
    },
    onError: () => setNote({ tone: 'error', text: 'Could not reject this draft. Try again.' }),
  }))
  // The owner's last word on a reply that already went out: it strikes what the agent learned from
  // it, retires the candidate it produced, and counts towards demoting the category.
  const flag = useMutation(trpc.drafts.flagAutoSent.mutationOptions({
    onSuccess: () => {
      setNote({ tone: 'info', text: 'Flagged — the agent will not reuse what it learned here.' })
      void invalidateAll()
    },
    onError: () => setNote({ tone: 'error', text: 'Could not flag this reply. Try again.' }),
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
  // Phase 7's "Remember this reply" (plan deviation 16): backfills memory from an already-sent
  // outbound message with no draft behind it. Shares this screen's own `note` banner rather than a
  // per-bubble one — the same seam every other action here already reports through.
  const rememberReply = useMutation(trpc.memory.rememberReply.mutationOptions({
    onSuccess: () => { setNote({ tone: 'info', text: 'Saved — the agent can reuse this answer.' }); setRememberingId(null) },
    onError: (error) => { setNote({ tone: 'error', text: rememberErrorText(error) }); setRememberingId(null) },
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
  const busy = approve.isPending || hold.isPending || reject.isPending || resume.isPending || flag.isPending

  function pressRemember(messageId: string) {
    if (rememberReply.isPending) return
    setRememberingId(messageId)
    rememberReply.mutate({ messageId })
  }

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
            onReject={(action: RejectAction, reason: string, addToGuidance: boolean) => reject.mutate({ draftId: draft.id, action, reason, addToGuidance })}
            onResume={() => resume.mutate({ draftId: draft.id })}
            onFlag={() => flag.mutate({ draftId: draft.id })}
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
          return (
            <MessageBubble
              key={m.id}
              message={m}
              outbound={outbound}
              onRemember={outbound && canRemember ? () => pressRemember(m.id) : undefined}
              remembering={rememberingId === m.id && rememberReply.isPending}
            />
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
})
