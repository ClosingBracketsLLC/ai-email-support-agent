import { useState } from 'react'
import { REJECT_REASON_MAX, type RejectAction } from '@aesa/contracts'
import { Button } from '@/components/button'
import { Card } from '@/components/card'
import { SwitchRow } from '@/components/switch-row'
import { TextField } from '@/components/text-field'
import { Heading, Muted } from '@/components/typography'

/** Two re-drafts is the cap (`redraft_limit_reached`); the third rejection can only hand the ticket over. */
const REDRAFT_CAP = 2
export const REDRAFT_CAP_COPY = 'Re-drafted twice already — rejecting again hands the ticket to you.'

/**
 * "Reject" in the owner's two flavours: tell the agent what to change (a re-draft comes back here),
 * or take the ticket yourself. The inline-Card sheet idiom (see `settings/address-sheet.tsx`) —
 * presentational: it owns the typed reason (and whether that sentence should become a standing rule)
 * and nothing else.
 */
export function RejectSheet({ redraftCount, onSubmit, onCancel, busy }: {
  redraftCount: number
  onSubmit: (action: RejectAction, reason: string, addToGuidance: boolean) => void
  onCancel: () => void
  busy: boolean
}) {
  const [reason, setReason] = useState('')
  const [addToGuidance, setAddToGuidance] = useState(false)
  const trimmed = reason.trim()
  const atCap = redraftCount >= REDRAFT_CAP

  function submit(action: RejectAction) {
    if (busy) return
    // There is nothing to add when there is no sentence — the switch is disabled there, and a flag
    // left over from a reason that has since been cleared must not travel either.
    onSubmit(action, trimmed, addToGuidance && trimmed.length > 0)
  }

  return (
    <Card testID="reject-sheet">
      <Heading>What should change?</Heading>
      <TextField
        label="Tell the agent what to change (optional)"
        value={reason}
        onChangeText={setReason}
        multiline
        maxLength={REJECT_REASON_MAX}
        testID="reject-reason"
      />
      <SwitchRow
        label="Also add this to your operating guidance"
        hint="Every future reply follows it, not just this one"
        value={addToGuidance && trimmed.length > 0}
        disabled={trimmed.length === 0 || busy}
        onValueChange={setAddToGuidance}
        testID="reject-add-guidance"
      />
      {atCap ? (
        <Muted testID="reject-cap">{REDRAFT_CAP_COPY}</Muted>
      ) : (
        <Button
          label="Re-draft with this reason"
          onPress={() => submit('redraft')}
          disabled={trimmed.length === 0 || busy}
          testID="reject-redraft"
        />
      )}
      <Button label="I'll handle it" variant="secondary" onPress={() => submit('handle')} disabled={busy} testID="reject-handle" />
      <Button label="Cancel" variant="secondary" onPress={onCancel} disabled={busy} testID="reject-cancel" />
    </Card>
  )
}
