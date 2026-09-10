import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useLocalSearchParams } from 'expo-router'
import { useEffect, useRef, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import type { AgentStatus, PersonaPreset } from '@aesa/contracts'
import { PERSONA_PRESETS, UpdateAgentInput } from '@aesa/contracts'
import { Banner } from '@/components/banner'
import { Button } from '@/components/button'
import { Card } from '@/components/card'
import { Loading } from '@/components/loading'
import { Screen } from '@/components/screen'
import { TextField } from '@/components/text-field'
import { Heading, Muted } from '@/components/typography'
import { useTRPC } from '@/lib/trpc'
import { font, radius, spacing, typeScale, useColors } from '@/theme'
import { SandboxCard } from './sandbox-card'

const PERSONA_LABEL: Record<PersonaPreset, string> = { support: 'Support', sales: 'Sales', concierge: 'Concierge', billing: 'Billing' }
/** Shortened to one line for the radio cards — spec wording (design doc §"Persona presets"). */
const PERSONA_DESCRIPTION: Record<PersonaPreset, string> = {
  support: 'helpful, concise, resolves',
  sales: 'warm, consultative, never invents pricing',
  concierge: 'neutral, thorough, cites sources',
  billing: 'precise, cautious, escalates disputes',
}
const AGENT_STATUS_LABEL: Record<AgentStatus, string> = { pending_verification: 'Pending verification', active: 'Active', disabled: 'Disabled' }
const CATEGORY_MODE_LABEL: Record<string, string> = { off: 'Off', review: 'Review', auto: 'Auto' }
const MAX_FREEFORM = 4000

/** `status`/`personaPreset`/category `mode` columns are plain `text`, so the tRPC-inferred type is a
 * bare `string` — same defensive lookup as `agents.tsx` (list screen) and `mailboxes.tsx`. */
function label<T extends string>(map: Record<T, string>, value: string): string {
  return (map as Record<string, string>)[value] ?? value
}
function toPersonaPreset(value: string): PersonaPreset {
  return (PERSONA_PRESETS as readonly string[]).includes(value) ? (value as PersonaPreset) : 'support'
}

type DirtyKey = 'displayName' | 'signature' | 'personaPreset' | 'personaText' | 'guidanceExtra' | 'replyFromAddress'

/** Persona presets, signature, reply-from display (priority reorder lives on the list screen), and
 * disable/enable. Save sends only the dirty keys (Task 21 brief); status changes are their own
 * immediate action, not part of the dirty-keys save. */
export function AgentEditScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const c = useColors()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const list = useQuery(trpc.agents.list.queryOptions())
  const categoriesQuery = useQuery(trpc.agents.categories.queryOptions({ agentId: id }))
  const agent = list.data?.agents.find((a) => a.id === id)

  const [displayName, setDisplayName] = useState('')
  const [signature, setSignature] = useState('')
  const [personaPreset, setPersonaPreset] = useState<PersonaPreset>('support')
  const [personaText, setPersonaText] = useState('')
  const [guidanceExtra, setGuidanceExtra] = useState('')
  // true = "reply from the connection's own address" (agent.replyFromAddress is that address);
  // false = "reply as the agent's own address" (agent.replyFromAddress is null).
  const [replyFromConnection, setReplyFromConnection] = useState(false)
  const [dirtyKeys, setDirtyKeys] = useState<Set<DirtyKey>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const editVersion = useRef(0)
  const pendingVersion = useRef<number | null>(null)

  const [confirmingDisable, setConfirmingDisable] = useState(false)
  const [statusError, setStatusError] = useState<string | null>(null)

  const dirty = dirtyKeys.size > 0

  // Pristine-reset discipline (Phase 1 ruling, ProfileForm): re-seed local state from a refetch only
  // while nothing has been edited since mount, so a background refetch never clobbers an in-progress edit.
  useEffect(() => {
    if (!agent || dirty) return
    setDisplayName(agent.displayName)
    setSignature(agent.signature)
    setPersonaPreset(toPersonaPreset(agent.personaPreset))
    setPersonaText(agent.personaText)
    setGuidanceExtra(agent.guidanceExtra)
    setReplyFromConnection(agent.replyFromAddress !== null)
  }, [dirty, agent?.displayName, agent?.signature, agent?.personaPreset, agent?.personaText, agent?.guidanceExtra, agent?.replyFromAddress])

  function markDirty(key: DirtyKey) {
    editVersion.current += 1
    setSaved(false)
    setDirtyKeys((prev) => (prev.has(key) ? prev : new Set(prev).add(key)))
  }
  function onDisplayNameChange(v: string) { markDirty('displayName'); setDisplayName(v) }
  function onSignatureChange(v: string) { markDirty('signature'); setSignature(v) }
  function onPersonaPresetChange(p: PersonaPreset) { markDirty('personaPreset'); setPersonaPreset(p) }
  function onPersonaTextChange(v: string) { markDirty('personaText'); setPersonaText(v) }
  function onGuidanceChange(v: string) { markDirty('guidanceExtra'); setGuidanceExtra(v) }
  function onReplyFromChange(useConnection: boolean) { markDirty('replyFromAddress'); setReplyFromConnection(useConnection) }

  const patch: Partial<UpdateAgentInput> = {}
  if (dirtyKeys.has('displayName')) patch.displayName = displayName.trim()
  if (dirtyKeys.has('signature')) patch.signature = signature
  if (dirtyKeys.has('personaPreset')) patch.personaPreset = personaPreset
  if (dirtyKeys.has('personaText')) patch.personaText = personaText
  if (dirtyKeys.has('guidanceExtra')) patch.guidanceExtra = guidanceExtra
  // NULL = sends as its own address; non-null = replies come from the connection's address (schema
  // comment on `agents.reply_from_address`) — the only two valid values for an alias agent.
  if (dirtyKeys.has('replyFromAddress') && agent) patch.replyFromAddress = replyFromConnection ? agent.connectionEmailAddress : null
  const parsed = agent ? UpdateAgentInput.safeParse({ agentId: agent.id, ...patch }) : null

  const save = useMutation(trpc.agents.update.mutationOptions({
    onSuccess: async () => {
      // Same ordering as ProfileForm: let the invalidation's refetch land before deciding whether to
      // clear `dirty`, and only clear it if nothing was edited since this save started.
      await queryClient.invalidateQueries({ queryKey: trpc.agents.list.queryKey() })
      if (editVersion.current === pendingVersion.current) setDirtyKeys(new Set())
      setSaved(true)
    },
    onError: () => setError('Could not save. Try again.'),
  }))

  function submit() {
    if (!agent || !dirty || !parsed?.success || save.isPending) return
    setError(null)
    pendingVersion.current = editVersion.current
    save.mutate(parsed.data)
  }

  const statusMutation = useMutation(trpc.agents.update.mutationOptions({
    onSuccess: () => queryClient.invalidateQueries({ queryKey: trpc.agents.list.queryKey() }),
    onError: () => setStatusError('Could not change status. Try again.'),
  }))
  function handleToggleStatus() {
    if (!agent || statusMutation.isPending) return
    setStatusError(null)
    if (agent.status === 'active') {
      if (!confirmingDisable) { setConfirmingDisable(true); return }
      setConfirmingDisable(false)
      statusMutation.mutate({ agentId: agent.id, status: 'disabled' })
    } else if (agent.status === 'disabled') {
      statusMutation.mutate({ agentId: agent.id, status: 'active' })
    }
  }

  if (!list.data) return <Loading />
  if (!agent) return <Screen testID="agent-edit"><Banner tone="error">Agent not found.</Banner></Screen>

  const displayNameError = dirtyKeys.has('displayName') && !parsed?.success && parsed?.error.issues.some((i) => i.path[0] === 'displayName') ? 'Required' : null

  return (
    <Screen testID="agent-edit">
      <Heading>{agent.address}</Heading>

      <TextField label="Display name" value={displayName} onChangeText={onDisplayNameChange} testID="display-name" error={displayNameError} />
      <TextField label="Signature (optional)" value={signature} onChangeText={onSignatureChange} multiline numberOfLines={3} maxLength={500} testID="signature" />

      <View style={styles.field}>
        <Muted>Persona</Muted>
        {PERSONA_PRESETS.map((p) => (
          <Pressable
            key={p} role="radio" accessibilityState={{ checked: personaPreset === p }}
            onPress={() => onPersonaPresetChange(p)} testID={`persona-preset-${p}`}
            style={[styles.presetCard, { borderColor: personaPreset === p ? c.primary : c.border, backgroundColor: personaPreset === p ? c.primaryTint : c.bg }]}
          >
            <Text style={[typeScale.body, styles.presetLabel, { color: c.text }]}>{PERSONA_LABEL[p]}</Text>
            <Text style={[typeScale.caption, { color: c.muted }]}>{PERSONA_DESCRIPTION[p]}</Text>
          </Pressable>
        ))}
      </View>

      {/* Task 22's "Try it" — under the persona card, active agents only (task brief); a pending
          agent has nothing to try until its address is verified, and a DISABLED one has nothing to try
          until it is switched back on (its address is long since verified). */}
      {agent.status === 'active' ? (
        <SandboxCard agentId={agent.id} />
      ) : (
        <Muted testID="sandbox-pending">
          {agent.status === 'pending_verification' ? 'Available once the address is verified.' : 'Available once the agent is active.'}
        </Muted>
      )}

      <View style={styles.field}>
        <TextField label="Custom persona (optional)" value={personaText} onChangeText={onPersonaTextChange} multiline numberOfLines={4} maxLength={MAX_FREEFORM} testID="persona-text" />
        <Muted>Shapes tone and priorities; cannot override safety rules.</Muted>
        <Muted testID="persona-text-counter">{`${personaText.length}/${MAX_FREEFORM}`}</Muted>
      </View>

      <View style={styles.field}>
        <TextField label="Extra guidance for this agent (optional)" value={guidanceExtra} onChangeText={onGuidanceChange} multiline numberOfLines={4} maxLength={MAX_FREEFORM} testID="guidance-extra" />
        <Muted>Adds to your workspace-wide operating guidance for this agent only.</Muted>
        <Muted testID="guidance-extra-counter">{`${guidanceExtra.length}/${MAX_FREEFORM}`}</Muted>
      </View>

      {agent.address !== agent.connectionEmailAddress ? (
        <Card testID="reply-from">
          <Muted>Reply-from address</Muted>
          <View style={styles.radios}>
            {/* Trusts the owner's own report about provider-side Send-as (same trust model as
                address-sheet.tsx's identical pair) — review fix, Important 1: these used to be
                hard-disabled with a no-op onPress, so once set the choice was locked forever.
                Visibility is keyed on "is this an alias" (address !== the connection's own address),
                not on the current replyFromAddress value — supplementary ruling: gating on
                `replyFromAddress !== null` re-created the same lock in the opposite direction, since
                choosing "reply as own" (null) would make the block vanish with no way back. A
                primary-address agent (address === connectionEmailAddress) never shows this at all —
                its reply-from is inherently itself. */}
            <Pressable
              role="radio" accessibilityState={{ checked: !replyFromConnection }} onPress={() => onReplyFromChange(false)} testID="reply-as-own"
              style={[styles.radioBox, { borderColor: !replyFromConnection ? c.primary : c.border, backgroundColor: !replyFromConnection ? c.primaryTint : c.bg }]}
            >
              <Text style={[typeScale.body, { color: c.text }]}>Reply as {agent.address}</Text>
              <Text style={[typeScale.caption, { color: c.muted }]}>Set up Send-as with your provider first</Text>
            </Pressable>
            <Pressable
              role="radio" accessibilityState={{ checked: replyFromConnection }} onPress={() => onReplyFromChange(true)} testID="reply-from-connection"
              style={[styles.radioBox, { borderColor: replyFromConnection ? c.primary : c.border, backgroundColor: replyFromConnection ? c.primaryTint : c.bg }]}
            >
              <Text style={[typeScale.body, { color: c.text }]}>Reply from {agent.connectionEmailAddress}</Text>
            </Pressable>
          </View>
        </Card>
      ) : null}

      {error ? <Banner tone="error">{error}</Banner> : null}
      {saved ? <Banner tone="success">Saved.</Banner> : null}
      <Button label="Save" onPress={submit} loading={save.isPending} disabled={!dirty || !parsed?.success || save.isPending} testID="agent-save" />

      {agent.status === 'active' || agent.status === 'disabled' ? (
        <Card testID="agent-status-card">
          <Muted>Status: {label(AGENT_STATUS_LABEL, agent.status)}</Muted>
          <Button
            variant={agent.status === 'active' ? (confirmingDisable ? 'danger' : 'secondary') : 'primary'}
            label={agent.status === 'active' ? (confirmingDisable ? 'Confirm disable' : 'Disable agent') : 'Enable agent'}
            onPress={handleToggleStatus} loading={statusMutation.isPending} testID="agent-toggle-status"
          />
          {statusError ? <Banner tone="error">{statusError}</Banner> : null}
        </Card>
      ) : (
        <Muted testID="agent-status-pending">This address is still being verified — status changes are unavailable until then.</Muted>
      )}

      {categoriesQuery.data ? (
        <Card testID="categories-card">
          <Heading>Categories</Heading>
          <Muted>Autopilot per category arrives with the learning loop</Muted>
          <View style={styles.chipsRow}>
            {categoriesQuery.data.categories.map((cat) => (
              <View key={cat.categoryId} style={[styles.chip, { borderColor: c.border, backgroundColor: c.surface }]} testID={`category-${cat.categoryId}`}>
                <Text style={[typeScale.caption, { color: c.text }]}>{cat.label} · {label(CATEGORY_MODE_LABEL, cat.mode)}</Text>
              </View>
            ))}
          </View>
        </Card>
      ) : null}
    </Screen>
  )
}

const styles = StyleSheet.create({
  field: { gap: spacing.xs },
  presetCard: { borderWidth: 1, borderRadius: radius.md, padding: spacing.sm, gap: 2 },
  presetLabel: { fontFamily: font.uiStrong },
  radios: { gap: spacing.xs },
  radioBox: { borderWidth: 1, borderRadius: radius.md, padding: spacing.sm, gap: 2 },
  chipsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  chip: { borderWidth: 1, borderRadius: radius.sm, paddingHorizontal: spacing.sm, paddingVertical: spacing.xs },
})
