import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import type { CredentialHealth, LlmEffort, LlmProviderId, ModelConfigMode } from '@aesa/contracts'
import { LLM_EFFORTS, MANAGED_MODELS, PROVIDER_PRESETS, presetModel } from '@aesa/contracts'
import { Banner } from '@/components/banner'
import { Button } from '@/components/button'
import { Card } from '@/components/card'
import { Chip, type ChipTone } from '@/components/chip'
import { SwitchRow } from '@/components/switch-row'
import { TextField } from '@/components/text-field'
import { Heading, Muted } from '@/components/typography'
import { useTRPC } from '@/lib/trpc'
import { font, radius, spacing, typeScale, useColors } from '@/theme'

const HEALTH_LABEL: Record<CredentialHealth, string> = {
  unknown: 'Checking…', healthy: 'Healthy', degraded: 'Degraded', dead: 'Key rejected',
}
const HEALTH_TONE: Record<CredentialHealth, ChipTone> = {
  unknown: 'neutral', healthy: 'success', degraded: 'warning', dead: 'danger',
}
const EFFORT_LABEL: Record<LlmEffort, string> = { low: 'Low', medium: 'Medium', high: 'High' }
/** `null` is the provider's own default — the fourth chip, and what every managed agent runs on. */
const EFFORT_CHOICES: (LlmEffort | null)[] = [null, ...LLM_EFFORTS]
const effortId = (e: LlmEffort | null): string => e ?? 'default'
const effortLabel = (e: LlmEffort | null): string => (e === null ? 'Default' : EFFORT_LABEL[e])

const CHANGE_NOTE = 'Autopilot categories go back to Review when the model changes.'
/** A `custom` connection has no catalog suggestion to prefill from (`presetModel` returns null), so
 * both fields land empty and Save is disabled until the owner names the models — say so rather than
 * leaving a dead button. */
const CUSTOM_MODEL_HINT = 'Enter the model id this endpoint serves (for example qwen3:32b).'

/** The api's own sentence for the one soft refusal this card can hit (`trpc/routers/llm.ts`). */
function saveErrorCopy(error: unknown): string {
  const message = (error as { message?: unknown } | null | undefined)?.message
  return message === 'that connection was rejected by the provider; test it before using it'
    ? 'That connection was rejected by the provider — test it on the AI screen first.'
    : 'Could not save the model. Try again.'
}

/**
 * The agent edit screen's Model card (spec §Provider choice): Managed AI, or one of the workspace's
 * provider connections with its own drafting and triage model.
 *
 * Its own query, its own mutation and its own dirty state — the agent screen's Save sends persona and
 * signature through `agents.update` and never touches the model. Two reasons they stay apart: the
 * model choice is a `managerProcedure` while the rest of that screen is not, and saving it bumps the
 * agent's model generation and drops every Autopilot category back to Review. That consequence is
 * spelled out BEFORE the save, not reported after it.
 *
 * Seeding follows the agent screen's pristine-reset discipline: local state re-seeds from a refetch
 * only while nothing has been edited since mount, so a background refetch never clobbers an edit.
 */
export function ModelCard({ agentId, canManage }: { agentId: string; canManage: boolean }) {
  const c = useColors()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const current = useQuery(trpc.llm.agentModel.queryOptions({ agentId }))
  const list = useQuery(trpc.llm.list.queryOptions())

  const [mode, setMode] = useState<ModelConfigMode>('managed')
  const [credentialId, setCredentialId] = useState<string | null>(null)
  const [draftModel, setDraftModel] = useState('')
  const [triageModel, setTriageModel] = useState('')
  const [effort, setEffort] = useState<LlmEffort | null>(null)
  const [fallbackToManaged, setFallbackToManaged] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)
  // The version pair `agent-edit.tsx` keeps, plus a ref mirror of `dirty`.
  //
  // `dirty` gates the seeding effect below, and a save has to clear it WITHOUT the effect re-running
  // against whatever `current.data` happens to hold at that instant — which, until the invalidation's
  // refetch lands (or if it never does), is the PRE-save config. That is what snapped every field back
  // under the green banner. So the effect keys on the data alone and reads the flag off a ref: it fires
  // only when the config itself changes, and the save clears the ref up front (nothing to protect — the
  // server now agrees with the form) while `dirty` itself is cleared after the refetch and only if
  // nothing was edited since this save started.
  const editVersion = useRef(0)
  const pendingVersion = useRef<number | null>(null)
  const dirtyRef = useRef(false)

  const draft = current.data?.draft
  const triage = current.data?.triage

  useEffect(() => {
    if (!draft || !triage || dirtyRef.current) return
    setMode(draft.mode)
    setCredentialId(draft.credentialId)
    setDraftModel(draft.mode === 'byok' ? draft.model : '')
    setTriageModel(triage.mode === 'byok' ? triage.model : '')
    setEffort(draft.effort)
    setFallbackToManaged(draft.fallbackToManaged)
  }, [draft?.mode, draft?.credentialId, draft?.model, draft?.effort, draft?.fallbackToManaged, triage?.mode, triage?.model])

  const save = useMutation(trpc.llm.setAgentModel.mutationOptions({
    onSuccess: async (result: { demoted: number }) => {
      setError(null)
      // The form now IS the server's state, so the refetch below is free to seed from it.
      if (editVersion.current === pendingVersion.current) dirtyRef.current = false
      setSaved(result.demoted > 0
        ? `Saved — ${result.demoted} Autopilot ${result.demoted === 1 ? 'category went' : 'categories went'} back to Review.`
        : 'Saved.')
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: trpc.llm.agentModel.queryKey({ agentId }) }),
        queryClient.invalidateQueries({ queryKey: trpc.llm.list.queryKey() }),
        queryClient.invalidateQueries({ queryKey: trpc.agents.list.queryKey() }),
      ])
      if (editVersion.current === pendingVersion.current) setDirty(false)
    },
    onError: (err: unknown) => { setSaved(null); setError(saveErrorCopy(err)) },
  }))

  // A card that silently vanished on a failed read left the agent screen with no model section and no
  // reason for it — the sibling screens all surface a read failure instead. Only when there is nothing
  // to show, though: a BACKGROUND refetch that fails (the one a save kicks off, say) leaves the last
  // good config in `data`, and replacing a working form with an error banner would be the worse lie.
  if ((current.isError && !current.data) || (list.isError && !list.data)) {
    return (
      <Card testID="model-card">
        <Heading>Model</Heading>
        <Banner tone="error" testID="model-load-error">Couldn&apos;t load this agent&apos;s model settings. Pull to refresh or try again.</Banner>
      </Card>
    )
  }
  if (!draft || !triage || !list.data) return null
  const credentials = list.data.credentials
  const byok = mode === 'byok' && credentialId !== null
  const customEndpoint = byok && credentials.find((cred) => cred.id === credentialId)?.provider === 'custom'

  function change(apply: () => void) {
    if (!canManage) return
    setSaved(null)
    setError(null)
    editVersion.current += 1
    dirtyRef.current = true
    setDirty(true)
    apply()
  }
  /** Switching to a connection prefills both models from the provider's own catalog suggestions, so
   * the common case needs no typing at all (a `custom` endpoint has none — the owner names it). */
  function pickCredential(id: string, provider: LlmProviderId, health: CredentialHealth) {
    if (health === 'dead' || (mode === 'byok' && credentialId === id)) return
    change(() => {
      setMode('byok')
      setCredentialId(id)
      setDraftModel(presetModel(provider, 'draft') ?? '')
      setTriageModel(presetModel(provider, 'triage') ?? '')
    })
  }
  function pickManaged() {
    if (mode === 'managed') return
    change(() => { setMode('managed'); setCredentialId(null); setDraftModel(''); setTriageModel(''); setEffort(null); setFallbackToManaged(false) })
  }

  // What Save would send, and what the api compares against to decide the generation bump: mode, the
  // credential, and the DRAFT model (an effort or triage-only change is not a new writer of replies).
  const nextDraftModel = byok ? draftModel.trim() : MANAGED_MODELS.draft
  const modelChanges = mode !== draft.mode || credentialId !== draft.credentialId || nextDraftModel !== draft.model
  const complete = !byok || (draftModel.trim().length > 0 && triageModel.trim().length > 0)

  function submit() {
    if (!canManage || !dirty || !complete || save.isPending) return
    setError(null)
    pendingVersion.current = editVersion.current
    save.mutate(byok
      ? { agentId, mode: 'byok' as const, credentialId, draftModel: draftModel.trim(), triageModel: triageModel.trim(), effort, fallbackToManaged }
      : { agentId, mode: 'managed' as const, credentialId: null, draftModel: null, triageModel: null, effort: null, fallbackToManaged: false })
  }

  return (
    <Card testID="model-card">
      <Heading>Model</Heading>
      <Muted>Which model writes this agent's replies.</Muted>
      {!canManage ? <Muted testID="model-readonly">Only owners and admins can change the model.</Muted> : null}

      <View style={styles.radios} accessibilityRole="radiogroup">
        <Pressable
          role="radio" accessibilityState={{ checked: mode === 'managed', disabled: !canManage }} accessibilityLabel="Managed AI"
          disabled={!canManage} onPress={pickManaged} testID="model-managed"
          style={[styles.radio, { borderColor: mode === 'managed' ? c.primary : c.border, backgroundColor: mode === 'managed' ? c.primaryTint : c.bg, opacity: canManage ? 1 : 0.6 }]}
        >
          <Text style={[typeScale.body, styles.radioLabel, { color: c.text }]}>Managed AI</Text>
          <Text style={[typeScale.caption, { color: c.muted }]}>{`${MANAGED_MODELS.draft} · ${MANAGED_MODELS.triage}`}</Text>
        </Pressable>

        {credentials.map((cred) => {
          const checked = mode === 'byok' && credentialId === cred.id
          const dead = cred.healthStatus === 'dead'
          const disabled = !canManage || dead
          return (
            <Pressable
              key={cred.id} role="radio" accessibilityState={{ checked, disabled }} accessibilityLabel={cred.label}
              disabled={disabled} onPress={() => pickCredential(cred.id, cred.provider, cred.healthStatus)}
              testID={`model-credential-${cred.id}`}
              style={[styles.radio, { borderColor: checked ? c.primary : c.border, backgroundColor: checked ? c.primaryTint : c.bg, opacity: disabled ? 0.6 : 1 }]}
            >
              <View style={styles.radioHead}>
                <Text style={[typeScale.body, styles.radioLabel, styles.grow, { color: c.text }]}>{cred.label}</Text>
                <Chip tone={HEALTH_TONE[cred.healthStatus]} testID={`model-health-${cred.id}`}>{HEALTH_LABEL[cred.healthStatus]}</Chip>
              </View>
              <Text style={[typeScale.caption, { color: c.muted }]}>{PROVIDER_PRESETS[cred.provider].label}</Text>
            </Pressable>
          )
        })}
      </View>

      {credentials.length === 0 ? (
        <Muted testID="model-no-credentials">Connect a provider under Settings › AI to use your own key here.</Muted>
      ) : null}

      {byok ? (
        <>
          <TextField
            label="Drafting model" value={draftModel} onChangeText={(v) => change(() => setDraftModel(v))}
            editable={canManage} autoCapitalize="none" autoCorrect={false} maxLength={120}
            hint={customEndpoint && draftModel.trim().length === 0 ? CUSTOM_MODEL_HINT : undefined} testID="draft-model"
          />
          <TextField
            label="Triage model" value={triageModel} onChangeText={(v) => change(() => setTriageModel(v))}
            editable={canManage} autoCapitalize="none" autoCorrect={false} maxLength={120}
            hint={customEndpoint && triageModel.trim().length === 0 ? CUSTOM_MODEL_HINT : 'The cheap model that sorts incoming mail.'}
            testID="triage-model"
          />

          <View style={styles.field}>
            <Muted>Reasoning effort</Muted>
            <View style={styles.effortRow} accessibilityRole="radiogroup">
              {EFFORT_CHOICES.map((choice) => {
                const checked = effort === choice
                return (
                  <Pressable
                    key={effortId(choice)} role="radio" accessibilityState={{ checked, disabled: !canManage }}
                    accessibilityLabel={effortLabel(choice)} disabled={!canManage}
                    onPress={() => change(() => setEffort(choice))} testID={`effort-${effortId(choice)}`}
                    style={[styles.effortCell, { borderColor: checked ? c.primary : c.border, backgroundColor: checked ? c.primaryTint : c.bg, opacity: canManage ? 1 : 0.6 }]}
                  >
                    <Text style={[typeScale.caption, { color: c.text }]}>{effortLabel(choice)}</Text>
                  </Pressable>
                )
              })}
            </View>
            <Muted>Ignored by providers that have no effort control.</Muted>
          </View>

          <SwitchRow
            label="Fall back to Managed AI"
            hint="If your provider is down or rejects the key, draft with Managed AI instead of parking the ticket."
            value={fallbackToManaged}
            disabled={!canManage}
            onValueChange={(v) => change(() => setFallbackToManaged(v))}
            testID="model-fallback"
          />
        </>
      ) : null}

      {modelChanges && dirty ? <Banner tone="warning" testID="model-change-note">{CHANGE_NOTE}</Banner> : null}
      {error ? <Banner tone="error" testID="model-error">{error}</Banner> : null}
      {saved ? <Banner tone="success" testID="model-saved">{saved}</Banner> : null}

      {canManage ? (
        <Button
          label="Save model" onPress={submit} loading={save.isPending}
          disabled={!dirty || !complete || save.isPending} testID="model-save"
        />
      ) : null}
    </Card>
  )
}

const styles = StyleSheet.create({
  field: { gap: spacing.xs },
  grow: { flex: 1 },
  radios: { gap: spacing.xs },
  radio: { borderWidth: 1, borderRadius: radius.md, padding: spacing.sm, gap: 2 },
  radioHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  radioLabel: { fontFamily: font.uiStrong },
  effortRow: { flexDirection: 'row', gap: spacing.xs },
  effortCell: { flex: 1, borderWidth: 1, borderRadius: radius.md, paddingVertical: spacing.sm, alignItems: 'center' },
})
