import { useEffect, useImperativeHandle, useState, type Ref } from 'react'
import { Platform, StyleSheet, Text, View } from 'react-native'
import { DRAFT_BODY_MAX, type DraftStatus, type RejectAction } from '@aesa/contracts'
import { Banner } from '@/components/banner'
import { Button } from '@/components/button'
import { Card } from '@/components/card'
import { TextField } from '@/components/text-field'
import { Heading, Muted } from '@/components/typography'
import { radius, spacing, typeScale, useColors } from '@/theme'
import { REASON_SENTENCE, decisionReasonLabel, holdReasonLabel } from './reason-labels'
import { RejectSheet } from './reject-sheet'
import { UndoBar } from './undo-bar'

/**
 * The slice of the api's `DraftView` (apps/api/src/drafts/service.ts) this panel renders. Declared
 * here rather than imported off `AppRouter` for the same reason `ticket-row.tsx` declares
 * `TicketSummary`: the app describes what it draws, and `@aesa/api` stays a type-only edge.
 * `guardrailResult` is a jsonb column typed `Record<string, unknown>` on the api side, so it is
 * narrowed defensively below rather than trusted.
 */
export interface DraftView {
  id: string
  version: number
  status: DraftStatus
  body: string
  finalBody: string | null
  decisionReason: string
  confidence: number | null
  guardrailResult: unknown
  send: { lastError: string | null } | null
}

export interface DraftPanelProps {
  draft: DraftView
  ticket: { id: string; redraftCount: number; status: string }
  /** A human has read the body — the approve gate refuses without it (`not_viewed`). */
  viewed: boolean
  onApprove: (body?: string) => void
  onHold: () => void
  onReject: (action: RejectAction, reason: string) => void
  /** "Back to review" for a draft the send job parked on hold. */
  onResume: () => void
  busy: boolean
  approveError: { code: string; findings?: string[] } | null
  undoUntil: Date | null
  undoTickMs?: number
  /** Lets the screen's web keyboard shortcuts drive the panel's own state (see `shortcutFor`). */
  panelRef?: Ref<DraftPanelHandle | null>
}

/** What `a` / `e` / `r` do on web. Every guard lives here, where the panel's state is. */
export interface DraftPanelHandle {
  approve: () => void
  edit: () => void
  reject: () => void
}

const APPROVE_ERROR_COPY: Record<string, string> = {
  agent_disabled: 'Turn the agent on to send replies (Settings › Workspace).',
  kill_switch: 'Sending is paused for your workspace (Settings › Workspace).',
  guardrail: REASON_SENTENCE.guardrail_failed,
  not_pending: 'This draft was already decided.',
  not_viewed: 'Open the reply before approving it.',
}
const APPROVE_ERROR_FALLBACK = 'Could not approve this reply. Try again.'

/** Statuses the panel can be looking at once the decision is behind it (`held` has its own branch). */
const DECIDED_COPY: Partial<Record<DraftStatus, string>> = {
  approved: 'Approved — going out shortly.',
  sending: 'Sending…',
  sent: 'Sent.',
  rejected: 'Rejected.',
  superseded: 'Replaced by a newer draft.',
  expired: 'This draft expired unreviewed.',
  failed: 'This reply could not be sent.',
}

interface Finding { code: string; severity: string; detail: string }

/** `guardrail_result` is jsonb (`{ ok, findings: [{ code, severity, detail }] }`) — never trusted raw. */
function guardrailFindings(raw: unknown): Finding[] {
  const list = (raw as { findings?: unknown } | null | undefined)?.findings
  if (!Array.isArray(list)) return []
  return list
    .filter((f): f is Record<string, unknown> => typeof f === 'object' && f !== null)
    .map((f) => ({ code: String(f.code ?? ''), severity: String(f.severity ?? ''), detail: String(f.detail ?? '') }))
}
const findingLine = (prefix: string, f: Finding) => `${prefix}: ${f.detail || f.code}`

export function DraftPanel({
  draft, ticket, viewed, onApprove, onHold, onReject, onResume, busy, approveError, undoUntil, undoTickMs, panelRef,
}: DraftPanelProps) {
  const c = useColors()
  const seed = draft.finalBody ?? draft.body
  const [editing, setEditing] = useState(false)
  const [edited, setEdited] = useState(seed)
  const [rejecting, setRejecting] = useState(false)
  // The undo bar renders nothing once its window closes; without this the panel would show no actions
  // at all until the next poll landed. Keyed BY the window rather than reset by an effect: a child's
  // effect runs before its parent's, so a reset effect would undo an already-closed window's own
  // `onExpired` on the very first commit (a draft loaded mid-flight with a window already past).
  const [expiredWindow, setExpiredWindow] = useState<number | null>(null)
  const undoAt = undoUntil === null ? null : undoUntil.getTime()
  const undoExpired = undoAt !== null && expiredWindow === undoAt

  // A guardrail refusal is only answerable with an edit, so the editor opens itself on one.
  const guardrailRefused = approveError?.code === 'guardrail'
  useEffect(() => { if (guardrailRefused) setEditing(true) }, [guardrailRefused])

  const findings = guardrailFindings(draft.guardrailResult)
  const warnings = findings.filter((f) => f.severity === 'warn')
  const fails = findings.filter((f) => f.severity === 'fail')
  // The draft gate stored it anyway so the owner can see and fix it — but it cannot go out as it is.
  const blocked = draft.decisionReason === 'guardrail_failed'

  // The decision is still the owner's while the draft is pending AND no undo window is counting down
  // (the moment Approve lands, the send is the server's until Undo pulls it back).
  const undoOpen = undoUntil !== null && !undoExpired
  const decisionOpen = draft.status === 'pending' && !undoOpen
  const showEditor = editing && decisionOpen
  const canApprove = viewed && !busy && decisionOpen && !blocked
  const canApproveEdited = viewed && !busy && decisionOpen && edited.trim().length > 0

  function startEdit() {
    setEdited(seed)
    setEditing(true)
  }
  function cancelEdit() {
    setEditing(false)
    setEdited(seed)
  }
  function submitReject(action: RejectAction, reason: string) {
    setRejecting(false)
    onReject(action, reason)
  }

  useImperativeHandle(panelRef, () => ({
    approve: () => { if (canApprove && !showEditor) onApprove(undefined) },
    edit: () => { if (decisionOpen && !showEditor) startEdit() },
    reject: () => { if (decisionOpen && !showEditor) setRejecting(true) },
  }))

  const pct = draft.confidence === null ? null : Math.round(draft.confidence * 100)
  const why = decisionReasonLabel(draft.decisionReason)

  return (
    <Card testID="draft-panel">
      <View style={styles.headerRow}>
        <Heading style={styles.headerTitle}>{`Draft reply · v${draft.version}`}</Heading>
        {pct === null ? null : (
          <View style={[styles.chip, { borderColor: c.border }]} testID="draft-confidence">
            <Text style={[typeScale.caption, { color: c.text }]}>{`${pct}% confidence`}</Text>
          </View>
        )}
      </View>
      {why ? <Muted testID="draft-why">{`Why: ${why}`}</Muted> : null}

      {warnings.map((f, i) => (
        <Muted key={`warn-${i}`} testID={`draft-warning-${i}`}>{findingLine('Heads up', f)}</Muted>
      ))}
      {fails.map((f, i) => (
        <Text key={`fail-${i}`} style={[typeScale.caption, { color: c.danger }]} testID={`draft-blocked-${i}`}>{findingLine('Blocked', f)}</Text>
      ))}
      {blocked ? <Banner tone="error" testID="draft-blocked-note">{REASON_SENTENCE.guardrail_failed}</Banner> : null}

      {approveError ? (
        <Banner tone="error" testID="approve-error">{APPROVE_ERROR_COPY[approveError.code] ?? APPROVE_ERROR_FALLBACK}</Banner>
      ) : null}

      {showEditor ? (
        <>
          <TextField
            label="Edit the reply"
            value={edited}
            onChangeText={setEdited}
            multiline
            maxLength={DRAFT_BODY_MAX}
            style={styles.editor}
            testID="draft-editor"
          />
          {(approveError?.findings ?? []).map((finding, i) => (
            <Text key={`approve-finding-${i}`} style={[typeScale.caption, { color: c.danger }]} testID={`approve-finding-${i}`}>{finding}</Text>
          ))}
          <View style={styles.actions}>
            <Button label="Approve edited" onPress={() => onApprove(edited.trim())} disabled={!canApproveEdited} loading={busy} testID="approve-edited" />
            <Button label="Cancel" variant="secondary" onPress={cancelEdit} disabled={busy} testID="edit-cancel" />
          </View>
        </>
      ) : (
        <Text style={[typeScale.body, styles.body, { color: c.text }]} testID="draft-body">{seed}</Text>
      )}

      {undoUntil !== null && !undoExpired ? (
        <UndoBar untilAt={undoUntil} onUndo={onHold} busy={busy} tickMs={undoTickMs} onExpired={() => setExpiredWindow(undoAt)} />
      ) : draft.status === 'held' ? (
        <>
          <Banner tone="info" testID="draft-held">{`On hold — ${holdReasonLabel(draft.send?.lastError ?? null)}.`}</Banner>
          <Button label="Back to review" onPress={onResume} loading={busy} testID="resume" />
        </>
      ) : rejecting ? (
        <RejectSheet redraftCount={ticket.redraftCount} onSubmit={submitReject} onCancel={() => setRejecting(false)} busy={busy} />
      ) : showEditor ? null : draft.status === 'pending' ? (
        <View style={styles.actions}>
          <Button label="Approve" onPress={() => onApprove(undefined)} disabled={!canApprove} loading={busy} testID="approve" />
          <Button label="Edit" variant="secondary" onPress={startEdit} disabled={busy} testID="edit" />
          <Button label="Reject" variant="secondary" onPress={() => setRejecting(true)} disabled={busy} testID="reject" />
        </View>
      ) : (
        <Muted testID="draft-decided">{DECIDED_COPY[draft.status] ?? 'This draft was already decided.'}</Muted>
      )}
    </Card>
  )
}

const styles = StyleSheet.create({
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  headerTitle: { flex: 1 },
  chip: { borderWidth: 1, borderRadius: radius.lg, paddingHorizontal: spacing.sm, paddingVertical: 2 },
  body: { fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }) },
  editor: { minHeight: 160, textAlignVertical: 'top' },
  actions: { gap: spacing.sm },
})
