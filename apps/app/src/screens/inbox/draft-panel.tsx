import { useEffect, useImperativeHandle, useState, type Ref } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { DRAFT_BODY_MAX, type DraftStatus, type RejectAction } from '@aesa/contracts'
import { Banner } from '@/components/banner'
import { Button } from '@/components/button'
import { Card } from '@/components/card'
import { Chip } from '@/components/chip'
import { TextField } from '@/components/text-field'
import { Heading, Muted } from '@/components/typography'
import { font, spacing, typeScale, useColors } from '@/theme'
import { REASON_SENTENCE, decisionReasonLabel, holdReasonLabel, sendFailureLabel } from './reason-labels'
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
  /** `{ evidence, threshold, memory, grounding, … }` jsonb — narrowed by `evidenceLine`, never trusted. */
  confidenceBreakdown: unknown
  /** `auto` = the agent decided this one; `app`/`email` = a human did; null = nobody has yet. */
  decisionSource: string | null
  /** Stamped by `drafts.flagAutoSent` — "this should not have gone out". */
  flaggedAt: Date | null
  send: { lastError: string | null } | null
}

export interface DraftPanelProps {
  draft: DraftView
  ticket: { id: string; redraftCount: number; status: string }
  /** A human has read the body — the approve gate refuses without it (`not_viewed`). */
  viewed: boolean
  onApprove: (body?: string) => void
  onHold: () => void
  onReject: (action: RejectAction, reason: string, addToGuidance: boolean) => void
  /** "Back to review" for a draft the send job parked on hold. */
  onResume: () => void
  /** "Should not have sent" on an auto-sent reply (`drafts.flagAutoSent`). */
  onFlag: () => void
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

/** Statuses the panel can be looking at once the decision is behind it. `held` and `failed` are absent
 * on purpose: both have their own branch below, because both can still be brought Back to review. */
const DECIDED_COPY: Partial<Record<DraftStatus, string>> = {
  approved: 'Approved — going out shortly.',
  sending: 'Sending…',
  sent: 'Sent.',
  rejected: 'Rejected.',
  superseded: 'Replaced by a newer draft.',
  expired: 'This draft expired unreviewed.',
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

/**
 * "How sure was it, and how sure did it have to be" — `confidence_breakdown.evidence` against the
 * category's own `threshold`, both stored as fractions by `ticket.draft`. jsonb, so both are
 * narrowed defensively; no evidence at all means no line rather than `Evidence NaN%`, and no
 * threshold means the category is not on Autopilot, so there is no bar to name.
 */
function evidenceLine(raw: unknown): string | null {
  const b = raw as { evidence?: unknown; threshold?: unknown } | null | undefined
  const evidence = typeof b?.evidence === 'number' && Number.isFinite(b.evidence) ? b.evidence : null
  if (evidence === null) return null
  const threshold = typeof b?.threshold === 'number' && Number.isFinite(b.threshold) ? b.threshold : null
  const pct = `Evidence ${Math.round(evidence * 100)}%`
  return threshold === null ? pct : `${pct} · auto-sends at ${Math.round(threshold * 100)}%`
}

export function DraftPanel({
  draft, ticket, viewed, onApprove, onHold, onReject, onResume, onFlag, busy, approveError, undoUntil, undoTickMs, panelRef,
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

  // A reject→redraft (or any other handover) puts a DIFFERENT draft on this same mounted panel: an
  // editor left open would otherwise still hold — and "Approve edited" would submit — the previous
  // draft's text against the new draft's id. Declared before the guardrail effect below so that a
  // refusal that arrives with the new draft still wins.
  useEffect(() => {
    setEditing(false)
    setEdited(draft.finalBody ?? draft.body)
  }, [draft.id])

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
  function submitReject(action: RejectAction, reason: string, addToGuidance: boolean) {
    setRejecting(false)
    onReject(action, reason, addToGuidance)
  }

  useImperativeHandle(panelRef, () => ({
    approve: () => { if (canApprove && !showEditor) onApprove(undefined) },
    edit: () => { if (decisionOpen && !showEditor) startEdit() },
    reject: () => { if (decisionOpen && !showEditor) setRejecting(true) },
  }))

  const pct = draft.confidence === null ? null : Math.round(draft.confidence * 100)
  const why = decisionReasonLabel(draft.decisionReason)
  const evidence = evidenceLine(draft.confidenceBreakdown)
  // An auto-sent reply nobody approved: the hold window is a Hold, and once it is out the owner's
  // one remaining word about it is "that should not have gone out".
  const auto = draft.decisionSource === 'auto'

  return (
    <Card testID="draft-panel">
      <View style={styles.headerRow}>
        <Heading style={styles.headerTitle}>{`Draft reply · v${draft.version}`}</Heading>
        {pct === null ? null : <Chip tone="neutral" testID="draft-confidence">{`${pct}% confidence`}</Chip>}
      </View>
      {why ? <Muted testID="draft-why">{`Why: ${why}`}</Muted> : null}
      {evidence !== null ? <Muted testID="draft-evidence">{evidence}</Muted> : null}

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
        <UndoBar
          untilAt={undoUntil} onUndo={onHold} busy={busy} tickMs={undoTickMs} onExpired={() => setExpiredWindow(undoAt)}
          label={auto ? 'Hold' : 'Undo'} verb={auto ? 'Auto-sending' : 'Sending'}
        />
      ) : draft.status === 'held' ? (
        <>
          <Banner tone="info" testID="draft-held">{`On hold — ${holdReasonLabel(draft.send?.lastError ?? null)}.`}</Banner>
          <Button label="Back to review" onPress={onResume} loading={busy} testID="resume" />
        </>
      ) : draft.status === 'failed' ? (
        // The same way back as a hold: `drafts.resume` returns a failed draft to `pending` (and a
        // `send_failed` ticket to `awaiting_review`), and the re-approve revives the same send row.
        // `lastError` here is free text, so it is always spoken through `sendFailureLabel`.
        <>
          <Banner tone="error" testID="draft-failed">{`Not sent — ${sendFailureLabel(draft.send?.lastError ?? null)}.`}</Banner>
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
        <>
          <Muted testID="draft-decided">{DECIDED_COPY[draft.status] ?? 'This draft was already decided.'}</Muted>
          {draft.status === 'sent' && auto ? (
            draft.flaggedAt === null
              ? <Button label="Should not have sent" variant="secondary" onPress={onFlag} loading={busy} testID="flag-auto-sent" />
              : <Muted testID="draft-flagged">Flagged — should not have sent</Muted>
          ) : null}
        </>
      )}
    </Card>
  )
}

const styles = StyleSheet.create({
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  headerTitle: { flex: 1 },
  body: { fontFamily: font.mono },
  editor: { minHeight: 160, textAlignVertical: 'top' },
  actions: { gap: spacing.sm },
})
