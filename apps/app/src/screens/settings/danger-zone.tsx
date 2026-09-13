import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { RETENTION_DAYS_MAX, RETENTION_DAYS_MIN, SetRetentionDaysInput, WORKSPACE_ERROR_MESSAGES } from '@aesa/contracts'
import { Banner } from '@/components/banner'
import { Button } from '@/components/button'
import { Card } from '@/components/card'
import { Loading } from '@/components/loading'
import { SwitchRow } from '@/components/switch-row'
import { TextField } from '@/components/text-field'
import { Heading, Muted } from '@/components/typography'
import { openExternal } from '@/lib/open-external'
import { useTRPC } from '@/lib/trpc'
import { spacing } from '@/theme'

/** How often the export status re-reads itself while the worker is still building the bundle. */
const EXPORT_POLL_MS = 3_000

const WORKSPACE_ERROR_VALUES = new Set<string>(Object.values(WORKSPACE_ERROR_MESSAGES))
/** The router's soft refusals already ARE the exact `WORKSPACE_ERROR_MESSAGES` sentence (unlike
 * `ai.tsx`'s `LLM_ERROR_MESSAGES`, which are re-worded) — this is a whitelist, not a translation, so
 * anything else (a network error, an unexpected 500) never reaches the owner as raw text. */
function workspaceErrorCopy(error: unknown): string {
  const message = (error as { message?: unknown } | null | undefined)?.message
  return typeof message === 'string' && WORKSPACE_ERROR_VALUES.has(message) ? message : 'Could not complete that. Try again.'
}

/** A plain, timezone-stable date for owner-facing prose — the `billing-banner.tsx` convention. */
function formatDate(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`
}

/**
 * Settings → Workspace's danger zone (Phase 7): the kill switch, retention, a data export, and
 * deletion with a 30-day grace. Owner-only — every mutation here is `ownerProcedure` — a manager (or
 * anyone else) gets the same readonly note `ai.tsx` shows a plain member.
 *
 * Follows `ai.tsx`'s own shape: one `workspace.get` read, a small pile of self-contained mutations
 * that each invalidate it on success, and a two-press confirm (open the form, then Confirm) for the
 * one irreversible action — `requestDeletion`'s mutation itself keeps `gcTime: 0` (the typed
 * confirmation name is never worth retaining once the call has settled).
 */
export function DangerZone() {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const ws = useQuery(trpc.workspace.get.queryOptions())
  const exportStatus = useQuery({
    ...trpc.workspace.exportStatus.queryOptions(),
    refetchInterval: (query) => (query.state.data?.state === 'queued' ? EXPORT_POLL_MS : false),
  })

  const [retentionText, setRetentionText] = useState<string | null>(null)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [confirmText, setConfirmText] = useState('')
  const [deleteResult, setDeleteResult] = useState<{ subscriptionCancelled: boolean } | null>(null)
  const [cancelResult, setCancelResult] = useState<{ needsResubscribe: boolean } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [blocked, setBlocked] = useState<string | null>(null)

  const invalidateWorkspace = () => queryClient.invalidateQueries({ queryKey: trpc.workspace.get.queryKey() })

  const setKillSwitch = useMutation(trpc.workspace.setKillSwitch.mutationOptions({
    onSuccess: () => { setError(null); void invalidateWorkspace() },
    onError: () => setError('Could not change the kill switch. Try again.'),
  }))
  const setRetentionDays = useMutation(trpc.workspace.setRetentionDays.mutationOptions({
    gcTime: 0,
    onSuccess: () => { setError(null); void invalidateWorkspace() },
    onError: () => setError('Could not save that. Try again.'),
  }))
  const requestExport = useMutation(trpc.workspace.requestExport.mutationOptions({
    onSuccess: () => { setError(null); void queryClient.invalidateQueries({ queryKey: trpc.workspace.exportStatus.queryKey() }) },
    onError: (err: unknown) => setError(workspaceErrorCopy(err)),
  }))
  const requestDeletion = useMutation(trpc.workspace.requestDeletion.mutationOptions({
    gcTime: 0,
    onSuccess: (data: { subscriptionCancelled: boolean }) => {
      setError(null); setDeleteOpen(false); setConfirmText('')
      // A fresh deletion request supersedes whatever the LAST cancelDeletion said.
      setCancelResult(null)
      setDeleteResult({ subscriptionCancelled: data.subscriptionCancelled })
      void invalidateWorkspace()
    },
    onError: (err: unknown) => setError(workspaceErrorCopy(err)),
  }))
  const cancelDeletion = useMutation(trpc.workspace.cancelDeletion.mutationOptions({
    onSuccess: (data: { needsResubscribe: boolean }) => {
      setError(null); setDeleteResult(null)
      setCancelResult({ needsResubscribe: data.needsResubscribe })
      void invalidateWorkspace()
    },
    onError: (err: unknown) => setError(workspaceErrorCopy(err)),
  }))

  if (!ws.data) return <Loading />
  if (ws.data.role !== 'owner') {
    return (
      <Card testID="danger-zone">
        <Heading>Danger zone</Heading>
        <Muted testID="danger-zone-readonly">Only the workspace owner can change these.</Muted>
      </Card>
    )
  }

  const retentionValue = retentionText ?? String(ws.data.retentionDays)
  const retentionParsed = SetRetentionDaysInput.safeParse({ retentionDays: Number(retentionValue) })

  async function downloadExport() {
    if (!exportStatus.data?.url) return
    const url = exportStatus.data.url
    setBlocked(null)
    await openExternal(() => Promise.resolve({ url }), { onBlocked: setBlocked })
  }

  const exportState = exportStatus.data?.state ?? 'none'

  return (
    <Card testID="danger-zone">
      <Heading>Danger zone</Heading>
      {error ? <Banner tone="error" testID="danger-zone-error">{error}</Banner> : null}
      {blocked ? <Banner tone="error" testID="danger-zone-blocked">{blocked}</Banner> : null}

      <SwitchRow
        label="Kill switch"
        hint="Stops every send instantly, including replies you already approved. Drafts keep coming."
        value={ws.data.killSwitch}
        disabled={setKillSwitch.isPending}
        onValueChange={(on) => { if (!setKillSwitch.isPending) setKillSwitch.mutate({ on }) }}
        testID="kill-switch"
      />

      <View style={styles.block}>
        <TextField
          label="Keep customer mail for (days)" value={retentionValue} onChangeText={setRetentionText}
          keyboardType="number-pad" hint={`${RETENTION_DAYS_MIN}–${RETENTION_DAYS_MAX} days.`}
          error={!retentionParsed.success ? `Enter a number between ${RETENTION_DAYS_MIN} and ${RETENTION_DAYS_MAX}.` : null}
          testID="retention-days"
        />
        <Button
          variant="secondary" label="Save" disabled={!retentionParsed.success || setRetentionDays.isPending}
          loading={setRetentionDays.isPending}
          onPress={() => { if (retentionParsed.success) setRetentionDays.mutate(retentionParsed.data) }}
          testID="retention-save"
        />
      </View>

      <View style={styles.block}>
        <Muted>Download every message, draft and audit record this workspace has.</Muted>
        {exportState === 'queued' ? <Muted testID="export-status">Preparing…</Muted> : null}
        {exportState === 'ready' ? (
          <Button label="Ready — Download" onPress={downloadExport} testID="export-download" />
        ) : exportState !== 'queued' ? (
          <Button
            variant="secondary"
            label={exportState === 'failed' ? 'Failed — try again' : 'Export data'}
            onPress={() => { if (!requestExport.isPending) requestExport.mutate() }}
            loading={requestExport.isPending}
            testID="export-request"
          />
        ) : null}
      </View>

      {/* R23: `cancelDeletion`'s own signal (needsResubscribe) is a state that outlives the branch
          below — the moment it lands, `ws.data.deletionRequestedAt` is already null again, so this
          has to sit OUTSIDE that branch or it would vanish the instant it becomes true. */}
      {cancelResult?.needsResubscribe ? (
        <Banner tone="warning" testID="cancel-needs-resubscribe">Re-subscribe in Billing to turn Autopilot back on.</Banner>
      ) : null}

      {ws.data.deletionRequestedAt ? (
        <View style={styles.block}>
          <Banner tone="warning" testID="delete-scheduled">
            {`Deletion scheduled for ${formatDate(ws.data.purgeAfter ?? ws.data.deletionRequestedAt)}.`}
          </Banner>
          {deleteResult?.subscriptionCancelled ? (
            <Muted testID="delete-subscription-cancelled">
              Your subscription was cancelled when this deletion was requested — you will need to re-subscribe in Billing if you cancel it.
            </Muted>
          ) : null}
          <Button
            variant="secondary" label="Cancel deletion" loading={cancelDeletion.isPending}
            onPress={() => { if (!cancelDeletion.isPending) cancelDeletion.mutate() }}
            testID="cancel-deletion"
          />
        </View>
      ) : deleteOpen ? (
        <View style={styles.block}>
          <TextField
            label="Type the workspace name" value={confirmText} onChangeText={setConfirmText}
            autoCapitalize="none" autoCorrect={false} testID="delete-confirm-name"
          />
          <Button
            variant="danger" label="Confirm delete"
            disabled={confirmText.trim() !== ws.data.businessName || requestDeletion.isPending}
            loading={requestDeletion.isPending}
            onPress={() => requestDeletion.mutate({ confirm: confirmText.trim() })}
            testID="delete-confirm"
          />
          <Button variant="secondary" label="Cancel" onPress={() => { setDeleteOpen(false); setConfirmText('') }} testID="delete-cancel" />
        </View>
      ) : (
        <Button variant="danger" label="Delete workspace" onPress={() => setDeleteOpen(true)} testID="delete-open" />
      )}
    </Card>
  )
}

const styles = StyleSheet.create({ block: { gap: spacing.sm } })
