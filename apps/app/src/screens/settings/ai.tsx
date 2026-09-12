import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import type { CredentialHealth, LlmProviderId, ProbeResultView } from '@aesa/contracts'
import { AddCredentialInput, HttpsUrl, LLM_MAX_CREDENTIALS, LLM_PROVIDERS, MANAGED_MODELS, PROVIDER_PRESETS, canManageWorkspace } from '@aesa/contracts'
import { Banner } from '@/components/banner'
import { Button } from '@/components/button'
import { Card } from '@/components/card'
import { Chip, type ChipTone } from '@/components/chip'
import { Loading } from '@/components/loading'
import { Screen } from '@/components/screen'
import { TextField } from '@/components/text-field'
import { Body, Heading, Muted } from '@/components/typography'
import { useTRPC } from '@/lib/trpc'
import { radius, spacing, typeScale, useColors } from '@/theme'

const HEALTH_LABEL: Record<CredentialHealth, string> = {
  unknown: 'Checking…', healthy: 'Healthy', degraded: 'Degraded', dead: 'Key rejected',
}
const HEALTH_TONE: Record<CredentialHealth, ChipTone> = {
  unknown: 'neutral', healthy: 'success', degraded: 'warning', dead: 'danger',
}
/** What a health status actually means for replies — the sentence under a chip that isn't `healthy`. */
const HEALTH_HINT: Record<CredentialHealth, string | null> = {
  unknown: 'Testing this key now.',
  healthy: null,
  degraded: 'Recent calls failed. Agents on this key still try it.',
  dead: 'The provider rejected this key. Agents on it fall back to Managed AI only if you asked them to.',
}

/**
 * The api's own sentences for a soft refusal (`apps/api/src/trpc/routers/llm.ts`), in the owner's
 * words. Keyed on the message rather than a code because that is how the api's soft outcomes travel
 * over tRPC (the `autopilot.tsx` idiom); anything unrecognized falls back to a plain "try again"
 * rather than rendering the server's own wording.
 */
const ADD_ERROR_COPY: Record<string, string> = {
  'that endpoint must be a public https address':
    "That endpoint can't be reached safely: it must be an https address on the public internet.",
  'connection limit reached': `You can connect ${LLM_MAX_CREDENTIALS} providers. Remove one to add another.`,
  'this workspace is still being set up; try again in a moment':
    'This workspace is still being set up — try again in a moment.',
}
function addErrorCopy(error: unknown): string {
  const message = (error as { message?: unknown } | null | undefined)?.message
  return (typeof message === 'string' ? ADD_ERROR_COPY[message] : undefined) ?? 'Could not add that connection. Try again.'
}

const LOCAL_ENDPOINT_NOTE = 'A custom endpoint must be an https address on the public internet — a local Ollama or vLLM needs a public hostname.'

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

/** "12 calls · $0.03", or "12 calls · cost unknown" when any call's model matched no price row —
 * a total that silently omits those calls would read as cheaper than the month actually was. */
function usageLine(u: { calls: number; costMicros: number; costUnknownCalls: number }): string {
  const cost = u.costUnknownCalls > 0 ? 'cost unknown' : `$${(u.costMicros / 1_000_000).toFixed(2)}`
  return `${plural(u.calls, 'call', 'calls')} · ${cost}`
}

/** What the last probe found, in one line. `models: null` means the endpoint refused (or cannot serve)
 * a model list — the chat leg is what decides health, so that is not itself a failure. */
function probeSummary(probe: ProbeResultView | null): string {
  if (!probe) return 'Not tested yet'
  if (!probe.ok) return probe.error ? `Test failed — ${probe.error.code}` : 'Test failed'
  const models = probe.models === null ? 'model list unavailable' : plural(probe.models.length, 'model', 'models')
  return `${models} · structured output: ${probe.structured ?? 'unknown'}`
}

/** How often the connection list re-reads itself while a probe is still expected. Nothing pushes a
 * probe result to this screen: the api only ENQUEUES `llm.probe`, and the worker answers a second or
 * two later by writing the row. */
const PROBE_POLL_MS = 4_000

/** The credential this session pressed "Test connection" on, and what its `lastProbedAt` was at that
 * moment — the result has landed once that value moves. */
interface TestingProbe { credentialId: string; probedAt: number | null }

/** True while a probe result is still expected: a connection the worker has never answered for
 * (`unknown`), or the one just tested, until its `lastProbedAt` moves. A connection that has since
 * been removed matches neither, so the poll always stops. */
function awaitingProbe(credentials: CredentialRow[] | undefined, testing: TestingProbe | null): boolean {
  if (!credentials) return false
  if (credentials.some((c) => c.healthStatus === 'unknown')) return true
  return testing !== null && credentials.some((c) => c.id === testing.credentialId && (c.lastProbedAt?.getTime() ?? null) === testing.probedAt)
}

function relativeTime(date: Date): string {
  const minutes = Math.max(0, Math.round((Date.now() - date.getTime()) / 60_000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

/**
 * Settings › AI (spec §Provider choice): Managed AI, and the workspace's own provider connections.
 *
 * Reading which provider a workspace is on — and what it has cost — is every teammate's business
 * (`llm.list` is an `orgProcedure`); pasting a key, testing it or removing it is workspace management,
 * so a plain member gets this same screen with no buttons at all rather than a call that would just
 * 403 (the discipline `autopilot.tsx` and `memory.tsx` already keep).
 *
 * The pasted key lives in this component's state and nowhere else: it goes straight into `llm.add`
 * (which seals it to the org's box and hands it to the worker on a job payload) and the form is
 * dropped on success. Nothing here ever reads a key back — the api cannot return one.
 */
export function AiSettingsScreen() {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const ws = useQuery(trpc.workspace.get.queryOptions())
  const [adding, setAdding] = useState(false)
  const [confirmingRemove, setConfirmingRemove] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [testing, setTesting] = useState<TestingProbe | null>(null)

  // The interval is read off the query's OWN data rather than `list.data`, which does not exist yet
  // at the point these options are built; `awaitingProbe` returning false is what ends the poll.
  const list = useQuery({
    ...trpc.llm.list.queryOptions(),
    refetchInterval: (query) => (awaitingProbe(query.state.data?.credentials, testing) ? PROBE_POLL_MS : false),
  })

  /** Every mutation here changes which model an agent runs on, so all three readers resync. */
  async function refresh() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: trpc.llm.list.queryKey() }),
      queryClient.invalidateQueries({ queryKey: trpc.agents.list.queryKey() }),
      queryClient.invalidateQueries({ queryKey: trpc.llm.agentModel.queryKey() }),
    ])
  }

  const probe = useMutation(trpc.llm.probe.mutationOptions({
    onSuccess: () => { setError(null); void refresh() },
    onError: () => { setTesting(null); setError('Could not start that test. Try again.') },
  }))
  const remove = useMutation(trpc.llm.remove.mutationOptions({
    onSuccess: () => { setError(null); setTesting(null); setConfirmingRemove(null); void refresh() },
    onError: () => setError('Could not remove that connection. Try again.'),
  }))

  if (!ws.data || !list.data) return <Loading />
  const canManage = canManageWorkspace(ws.data.role)
  const credentials = list.data.credentials
  const busy = probe.isPending || remove.isPending
  const waiting = awaitingProbe(credentials, testing)

  function pressRemove(credentialId: string) {
    if (!canManage || busy) return
    setError(null)
    if (confirmingRemove !== credentialId) { setConfirmingRemove(credentialId); return }
    remove.mutate({ credentialId })
  }

  return (
    <Screen testID="ai">
      <Heading>AI</Heading>
      <Muted>Which model writes your replies: ours, or a provider you bring your own key for.</Muted>
      {!canManage ? <Muted testID="ai-readonly">Only owners and admins can connect or remove a provider.</Muted> : null}

      <Card testID="managed-card">
        <Heading>Managed AI</Heading>
        <Muted>Included in your plan, and the only models we have calibrated end to end. Nothing to set up.</Muted>
        <View style={styles.modelLines}>
          <Muted>{`Drafting ${MANAGED_MODELS.draft}`}</Muted>
          <Muted>{`Triage ${MANAGED_MODELS.triage}`}</Muted>
        </View>
      </Card>

      <Heading>Your providers</Heading>
      <Muted>A connection is a key you paste once. Point an agent at one from its Model card.</Muted>

      {error ? <Banner tone="error" testID="ai-error">{error}</Banner> : null}
      {waiting ? <Banner tone="info" testID="ai-testing">Testing a key now — this page updates itself when the provider answers.</Banner> : null}

      {credentials.length === 0 && !adding ? (
        <Muted testID="ai-empty">No provider connected — every agent is on Managed AI.</Muted>
      ) : null}

      {credentials.map((cred) => (
        <CredentialCard
          key={cred.id}
          credential={cred}
          canManage={canManage}
          busy={busy}
          confirming={confirmingRemove === cred.id}
          onTest={() => {
            if (!canManage || busy) return
            setError(null)
            setTesting({ credentialId: cred.id, probedAt: cred.lastProbedAt?.getTime() ?? null })
            probe.mutate({ credentialId: cred.id })
          }}
          onRemove={() => pressRemove(cred.id)}
        />
      ))}

      {canManage && !adding ? (
        <Button
          variant={credentials.length === 0 ? 'primary' : 'secondary'}
          label="Add a provider"
          onPress={() => { setError(null); setAdding(true) }}
          disabled={credentials.length >= LLM_MAX_CREDENTIALS}
          testID="ai-add-open"
        />
      ) : null}
      {canManage && credentials.length >= LLM_MAX_CREDENTIALS && !adding ? (
        <Muted testID="ai-cap">{`${LLM_MAX_CREDENTIALS} connections is the limit. Remove one to add another.`}</Muted>
      ) : null}

      {canManage && adding ? (
        <AddProviderForm onCancel={() => setAdding(false)} onAdded={() => { setAdding(false); void refresh() }} />
      ) : null}
    </Screen>
  )
}

interface CredentialRow {
  id: string
  provider: LlmProviderId
  label: string
  baseUrl: string | null
  keyFingerprint: string
  healthStatus: CredentialHealth
  lastProbe: ProbeResultView | null
  lastProbedAt: Date | null
  usage30d: { calls: number; errors: number; costMicros: number; costUnknownCalls: number; lastErrorCode: string | null }
  agentsUsing: number
}

/** One connection: what it is, whether it works, what it has cost, and the two things an owner can
 * do to it. Remove is a two-press confirmation that always names the blast radius first — every agent
 * on this key goes back to Managed AI the moment it is gone. */
function CredentialCard({
  credential, canManage, busy, confirming, onTest, onRemove,
}: {
  credential: CredentialRow
  canManage: boolean
  busy: boolean
  confirming: boolean
  onTest: () => void
  onRemove: () => void
}) {
  const c = useColors()
  const hint = HEALTH_HINT[credential.healthStatus]
  return (
    <Card testID={`credential-${credential.id}`}>
      <View style={styles.cardHead}>
        <Text style={[typeScale.bodyStrong, styles.grow, { color: c.text }]}>{credential.label}</Text>
        <Chip tone={HEALTH_TONE[credential.healthStatus]} testID={`credential-health-${credential.id}`}>
          {HEALTH_LABEL[credential.healthStatus]}
        </Chip>
      </View>
      <Muted>{`${PROVIDER_PRESETS[credential.provider].label} · ${credential.keyFingerprint}`}</Muted>
      {credential.baseUrl ? <Muted testID={`credential-endpoint-${credential.id}`}>{credential.baseUrl}</Muted> : null}

      <View style={styles.block}>
        <Muted testID={`credential-probe-${credential.id}`}>{probeSummary(credential.lastProbe)}</Muted>
        {credential.lastProbedAt ? <Muted>{`Tested ${relativeTime(credential.lastProbedAt)}`}</Muted> : null}
        {hint ? <Muted testID={`credential-health-hint-${credential.id}`}>{hint}</Muted> : null}
      </View>

      <View style={styles.block}>
        <Text style={[typeScale.label, { color: c.muted }]}>Last 30 days</Text>
        <Muted testID={`credential-usage-${credential.id}`}>{usageLine(credential.usage30d)}</Muted>
        {credential.usage30d.errors > 0 ? (
          <Muted testID={`credential-errors-${credential.id}`}>
            {`${plural(credential.usage30d.errors, 'call failed', 'calls failed')}${credential.usage30d.lastErrorCode ? ` · last: ${credential.usage30d.lastErrorCode}` : ''}`}
          </Muted>
        ) : null}
        {credential.agentsUsing > 0 ? (
          <Muted testID={`credential-agents-${credential.id}`}>{`Used by ${plural(credential.agentsUsing, 'agent', 'agents')}`}</Muted>
        ) : null}
      </View>

      {canManage ? (
        <>
          {confirming ? (
            <Banner tone="warning" testID={`credential-remove-warning-${credential.id}`}>
              {credential.agentsUsing === 0
                ? 'Remove this connection? No agent is using it.'
                : `Remove this connection? ${plural(credential.agentsUsing, 'agent falls', 'agents fall')} back to Managed AI.`}
            </Banner>
          ) : null}
          <View style={styles.actions}>
            <View style={styles.grow}>
              <Button variant="secondary" label="Test connection" onPress={onTest} disabled={busy} testID={`credential-test-${credential.id}`} />
            </View>
            <View style={styles.grow}>
              <Button
                variant={confirming ? 'danger' : 'secondary'}
                label={confirming ? 'Confirm remove' : 'Remove'}
                onPress={onRemove}
                disabled={busy}
                testID={`credential-remove-${credential.id}`}
              />
            </View>
          </View>
        </>
      ) : null}
    </Card>
  )
}

/**
 * "Add a provider": the provider, a name for the key, the key itself, and — for a custom
 * OpenAI-compatible endpoint only — its base URL and the model the probe should exercise.
 *
 * The contract is the validator (`AddCredentialInput`, the `source-cards.tsx` idiom): the Add button
 * is enabled exactly when the input the api would accept parses, so a typo never makes a round trip
 * and zod's own issue JSON is never rendered. A preset submits `parsed.data` with NO `baseUrl` key at
 * all — the api substitutes the preset's own, and a client-supplied one would be ignored anyway.
 */
function AddProviderForm({ onCancel, onAdded }: { onCancel: () => void; onAdded: () => void }) {
  const c = useColors()
  const trpc = useTRPC()
  const [provider, setProvider] = useState<LlmProviderId>('anthropic')
  const [label, setLabel] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [probeModel, setProbeModel] = useState('')
  const [error, setError] = useState<string | null>(null)

  const preset = PROVIDER_PRESETS[provider]
  const custom = provider === 'custom'

  const parsed = AddCredentialInput.safeParse(custom
    ? { provider, label, apiKey, baseUrl, probeModel }
    : { provider, label, apiKey })

  // The one field whose rejection isn't self-evident from an empty box: a disabled Add with a filled
  // URL has to say WHY. Only once something has been typed — an empty field is not yet wrong.
  const baseUrlError = custom && baseUrl.trim().length > 0 && !HttpsUrl.safeParse(baseUrl).success
    ? 'Enter a full https:// address'
    : null

  const add = useMutation(trpc.llm.add.mutationOptions({
    onSuccess: () => {
      // The key is dropped the moment the api has it — it was only ever in this component's state.
      setApiKey('')
      setLabel('')
      setBaseUrl('')
      setProbeModel('')
      setError(null)
      onAdded()
    },
    onError: (err: unknown) => setError(addErrorCopy(err)),
  }))

  function submit() {
    if (!parsed.success || add.isPending) return
    setError(null)
    add.mutate(parsed.data)
  }

  return (
    <Card testID="add-provider-form">
      <Heading>Add a provider</Heading>

      <View style={styles.block}>
        <Muted>Provider</Muted>
        <View style={styles.providerRow} accessibilityRole="radiogroup">
          {LLM_PROVIDERS.map((id) => {
            const checked = provider === id
            return (
              <Pressable
                key={id} role="radio" accessibilityState={{ checked }} accessibilityLabel={PROVIDER_PRESETS[id].label}
                onPress={() => { setError(null); setProvider(id) }} testID={`provider-${id}`}
                style={[styles.providerChip, { borderColor: checked ? c.primary : c.border, backgroundColor: checked ? c.primaryTint : c.bg }]}
              >
                <Text style={[typeScale.caption, { color: c.text }]}>{PROVIDER_PRESETS[id].label}</Text>
              </Pressable>
            )
          })}
        </View>
      </View>

      <TextField
        label="Name this key" value={label} onChangeText={setLabel} maxLength={60}
        hint="Only you see this — “Production key”, say." testID="credential-label"
      />
      <TextField
        label="API key" value={apiKey} onChangeText={setApiKey}
        secureTextEntry autoCapitalize="none" autoCorrect={false} autoComplete="off" maxLength={512}
        placeholder={preset.keyHint} testID="credential-key"
      />

      {custom ? (
        <>
          <TextField
            label="Base URL" value={baseUrl} onChangeText={setBaseUrl}
            autoCapitalize="none" autoCorrect={false} placeholder="https://llm.example.com/v1" maxLength={2048}
            error={baseUrlError} hint={LOCAL_ENDPOINT_NOTE} testID="credential-base-url"
          />
          <TextField
            label="Model to test" value={probeModel} onChangeText={setProbeModel}
            autoCapitalize="none" autoCorrect={false} maxLength={120}
            hint="The model id this endpoint serves." testID="credential-probe-model"
          />
        </>
      ) : null}

      <Body testID="consent-sentence">{`Email content will be sent to ${preset.consentName} under its terms.`}</Body>

      {error ? <Banner tone="error" testID="add-error">{error}</Banner> : null}

      <Button label="Add provider" onPress={submit} loading={add.isPending} disabled={!parsed.success || add.isPending} testID="add-submit" />
      <Button variant="secondary" label="Cancel" onPress={onCancel} disabled={add.isPending} testID="add-cancel" />
    </Card>
  )
}

const styles = StyleSheet.create({
  block: { gap: spacing.xs },
  modelLines: { gap: 2 },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  grow: { flex: 1 },
  actions: { flexDirection: 'row', gap: spacing.sm },
  providerRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  providerChip: { borderWidth: 1, borderRadius: radius.pill, paddingHorizontal: spacing.sm, paddingVertical: spacing.xs },
})
