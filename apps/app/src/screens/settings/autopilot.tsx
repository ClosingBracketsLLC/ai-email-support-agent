import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import type { CategoryMode, DemotionReason, ThresholdPreset } from '@aesa/contracts'
import { AUTONOMY_THRESHOLD_PRESETS, AUTO_SEND_DELAY_CHOICES, CATEGORY_MODES, canManageWorkspace } from '@aesa/contracts'
import { Banner } from '@/components/banner'
import { Button } from '@/components/button'
import { Card } from '@/components/card'
import { Loading } from '@/components/loading'
import { Screen } from '@/components/screen'
import { SwitchRow } from '@/components/switch-row'
import { Heading, Muted } from '@/components/typography'
import { useTRPC } from '@/lib/trpc'
import { font, radius, spacing, typeScale, useColors } from '@/theme'

const MODE_LABEL: Record<CategoryMode, string> = { off: 'Off', review: 'Review', auto: 'Auto' }
const MODE_HINT: Record<CategoryMode, string> = {
  off: 'No replies at all',
  review: 'Drafts wait for you',
  auto: 'Sends by itself',
}
const PRESET_LABEL: Record<ThresholdPreset, string> = { cautious: 'Cautious', balanced: 'Balanced', eager: 'Eager' }
const PRESETS = Object.keys(AUTONOMY_THRESHOLD_PRESETS) as ThresholdPreset[]

/** The owner's words for each automatic demotion — mirrors the reasons the worker's backstop and the
 * draft service's inline check write (`DEMOTION_REASONS`, `@aesa/contracts`). */
const DEMOTION_SENTENCE: Record<DemotionReason, string> = {
  rejections: 'two drafts were rejected in 7 days',
  flags: 'two auto-sent replies were flagged',
  hold_then_edit: 'an auto-send was held and then changed',
  edit_rate: 'more than 30% of recent drafts needed edits',
  model_changed: "the agent's model was changed",
}
const DEMOTION_FALLBACK = 'recent replies needed a closer look'

/** `mode` and `demoted_reason` are plain `text` columns (checked by the API, not a drizzle `pgEnum`),
 * so the tRPC-inferred type is a bare `string` — same defensive lookup as `agents.tsx`'s `label()`. */
function lookup<T extends string>(map: Record<T, string>, value: string | null): string | null {
  return value === null ? null : ((map as Record<string, string>)[value] ?? null)
}

function relativeTime(date: Date): string {
  const minutes = Math.max(0, Math.round((Date.now() - date.getTime()) / 60_000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

/** The one preset a threshold IS, or null for a hand-set number (the api accepts 50–99). */
function presetFor(threshold: number | null): ThresholdPreset | null {
  return PRESETS.find((p) => AUTONOMY_THRESHOLD_PRESETS[p] === threshold) ?? null
}

/**
 * Autopilot (spec §Learning loop): Off / Review / Auto per category, per agent, plus the two
 * agent-wide knobs — whether a category may graduate itself, and how long an auto-sent reply waits
 * before it actually goes.
 *
 * Every control here is a `managerProcedure` on the api side, so a plain member gets the SAME screen
 * with every control disabled and no buttons at all, rather than a call that would just 403 (the
 * discipline `knowledge.tsx` and `guidance-editor.tsx` already keep).
 *
 * The cold-start lock is the api's (`setCategoryPolicy` refuses `cold_start` under
 * `COLD_START_DECISIONS` human decisions); this screen renders the same floor from the
 * `coldStartAt` the payload carries, so the number is never hard-coded in the app.
 */
export function AutopilotScreen() {
  const c = useColors()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const list = useQuery(trpc.agents.list.queryOptions())
  const ws = useQuery(trpc.workspace.get.queryOptions())
  const [picked, setPicked] = useState<string | null>(null)
  const [errorCode, setErrorCode] = useState<string | null>(null)

  // Only an active agent can send anything, so only an active agent has autonomy worth managing.
  const activeAgents = (list.data?.agents ?? []).filter((a) => a.status === 'active')
  const agentId = (picked !== null && activeAgents.some((a) => a.id === picked) ? picked : activeAgents[0]?.id) ?? null
  const canManage = ws.data ? canManageWorkspace(ws.data.role) : false

  const categoriesQuery = useQuery(trpc.agents.categories.queryOptions(
    { agentId: agentId ?? '' },
    { enabled: agentId !== null },
  ))

  async function refresh() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: trpc.agents.categories.queryKey({ agentId: agentId ?? '' }) }),
      queryClient.invalidateQueries({ queryKey: trpc.agents.list.queryKey() }),
    ])
  }

  const setPolicy = useMutation(trpc.agents.setCategoryPolicy.mutationOptions({
    onSuccess: () => { setErrorCode(null); void refresh() },
    // The api's own soft codes (`cold_start`, `agent_inactive`) arrive as the error's `message`.
    onError: (error: unknown) => setErrorCode(errorCodeOf(error)),
  }))
  const updateAgent = useMutation(trpc.agents.update.mutationOptions({
    onSuccess: () => { setErrorCode(null); void refresh() },
    onError: (error: unknown) => setErrorCode(errorCodeOf(error)),
  }))

  if (!list.data || !ws.data) return <Loading />

  const data = categoriesQuery.data
  const coldStartAt = data?.coldStartAt ?? 0

  function changeMode(categoryId: string, mode: CategoryMode, current: string, threshold: number | null) {
    if (!canManage || agentId === null || mode === current) return
    setErrorCode(null)
    setPolicy.mutate(mode === 'auto'
      ? { agentId, categoryId, mode, autoSendMinConfidence: threshold ?? AUTONOMY_THRESHOLD_PRESETS.balanced }
      : { agentId, categoryId, mode })
  }
  function changeThreshold(categoryId: string, autoSendMinConfidence: number) {
    if (!canManage || agentId === null) return
    setErrorCode(null)
    setPolicy.mutate({ agentId, categoryId, mode: 'auto', autoSendMinConfidence })
  }

  return (
    <Screen testID="autopilot">
      <Heading>Autopilot</Heading>
      <Muted>Per category: draft and wait for you, or send by itself once it has earned it.</Muted>
      {!canManage ? <Muted testID="autopilot-readonly">Only owners and admins can change Autopilot.</Muted> : null}

      {activeAgents.length === 0 ? (
        <Muted testID="autopilot-no-agents">No active agents yet — Autopilot appears once an agent is live.</Muted>
      ) : null}

      {activeAgents.length > 1 ? (
        <View style={styles.agentRow} accessibilityRole="radiogroup" testID="autopilot-agents">
          {activeAgents.map((a) => (
            <Pressable
              key={a.id} role="radio" accessibilityState={{ checked: a.id === agentId }} accessibilityLabel={a.address}
              onPress={() => setPicked(a.id)} testID={`agent-${a.id}`}
              style={[styles.agentChip, { borderColor: a.id === agentId ? c.primary : c.border, backgroundColor: a.id === agentId ? c.primaryTint : c.surface }]}
            >
              <Text style={[typeScale.caption, { color: c.text }]}>{a.address}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      {errorCode !== null ? <Banner tone="error" testID="autopilot-error">{errorCopy(errorCode, coldStartAt)}</Banner> : null}

      {agentId !== null && !data ? <Loading /> : null}

      {data ? (
        <>
          <Card testID="autopilot-agent-card">
            <SwitchRow
              label="Auto-graduate"
              hint="Turn Autopilot on by itself when a category earns it"
              value={data.agent.autoGraduate}
              disabled={!canManage}
              onValueChange={(autoGraduate) => { if (agentId !== null) { setErrorCode(null); updateAgent.mutate({ agentId, autoGraduate }) } }}
              testID="auto-graduate"
            />
            <View style={styles.field}>
              <Muted>Hold window</Muted>
              <View style={styles.delayRow} accessibilityRole="radiogroup">
                {AUTO_SEND_DELAY_CHOICES.map((minutes) => {
                  const checked = data.agent.autoSendDelayMin === minutes
                  return (
                    <Pressable
                      key={minutes} role="radio" accessibilityState={{ checked, disabled: !canManage }}
                      accessibilityLabel={`${minutes} minutes`} disabled={!canManage}
                      onPress={() => { if (canManage && agentId !== null) { setErrorCode(null); updateAgent.mutate({ agentId, autoSendDelayMin: minutes }) } }}
                      testID={`delay-${minutes}`}
                      style={[styles.delayChip, { borderColor: checked ? c.primary : c.border, backgroundColor: checked ? c.primaryTint : c.bg, opacity: canManage ? 1 : 0.6 }]}
                    >
                      <Text style={[typeScale.body, { color: c.text }]}>{`${minutes} min`}</Text>
                    </Pressable>
                  )
                })}
              </View>
              <Muted>Auto-sent replies wait this long — you can hold one from the inbox</Muted>
            </View>
          </Card>

          {data.categories.map((cat) => {
            const locked = cat.humanDecisionCount < data.coldStartAt
            const demotionSentence = cat.mode === 'review' && cat.demotedAt !== null
              && (cat.graduatedAt === null || cat.demotedAt.getTime() > cat.graduatedAt.getTime())
              ? (lookup(DEMOTION_SENTENCE, cat.demotedReason) ?? DEMOTION_FALLBACK)
              : null
            const preset = presetFor(cat.autoSendMinConfidence)
            return (
              <Card key={cat.categoryId} testID={`category-${cat.categoryId}`}>
                <Heading>{cat.label}</Heading>
                <Muted>
                  {`Last 30 days: ${cat.stats30d.approvedUnchanged} unchanged · ${cat.stats30d.approvedEdited} edited · ${cat.stats30d.rejected} rejected · ${cat.stats30d.autoSent} auto-sent`}
                </Muted>

                <View style={styles.modeRow} accessibilityRole="radiogroup">
                  {CATEGORY_MODES.map((mode) => {
                    const checked = cat.mode === mode
                    const disabled = !canManage || (mode === 'auto' && locked)
                    return (
                      <Pressable
                        key={mode} role="radio" accessibilityState={{ checked, disabled }} accessibilityLabel={MODE_LABEL[mode]}
                        disabled={disabled} onPress={() => changeMode(cat.categoryId, mode, cat.mode, cat.autoSendMinConfidence)}
                        testID={`mode-${mode}-${cat.categoryId}`}
                        style={[styles.modeCell, { borderColor: checked ? c.primary : c.border, backgroundColor: checked ? c.primaryTint : c.bg, opacity: disabled ? 0.6 : 1 }]}
                      >
                        <Text style={[typeScale.body, styles.modeLabel, { color: c.text }]}>{MODE_LABEL[mode]}</Text>
                        <Text style={[typeScale.caption, { color: c.muted }]}>{MODE_HINT[mode]}</Text>
                      </Pressable>
                    )
                  })}
                </View>

                {locked ? (
                  <Muted testID={`cold-start-${cat.categoryId}`}>
                    {`Auto unlocks after ${data.coldStartAt} decisions (${cat.humanDecisionCount} so far)`}
                  </Muted>
                ) : null}

                {cat.mode === 'auto' ? (
                  <View style={styles.field}>
                    <Muted>Send by itself above</Muted>
                    <View style={styles.presetRow} accessibilityRole="radiogroup">
                      {PRESETS.map((p) => {
                        const checked = preset === p
                        return (
                          <Pressable
                            key={p} role="radio" accessibilityState={{ checked, disabled: !canManage }}
                            accessibilityLabel={PRESET_LABEL[p]} disabled={!canManage}
                            onPress={() => changeThreshold(cat.categoryId, AUTONOMY_THRESHOLD_PRESETS[p])}
                            testID={`preset-${p}-${cat.categoryId}`}
                            style={[styles.presetCell, { borderColor: checked ? c.primary : c.border, backgroundColor: checked ? c.primaryTint : c.bg, opacity: canManage ? 1 : 0.6 }]}
                          >
                            <Text style={[typeScale.caption, { color: c.text }]}>{`${PRESET_LABEL[p]} · ${AUTONOMY_THRESHOLD_PRESETS[p]}%`}</Text>
                          </Pressable>
                        )
                      })}
                    </View>
                    {preset === null && cat.autoSendMinConfidence !== null ? (
                      <Muted testID={`preset-custom-${cat.categoryId}`}>{`Custom · ${cat.autoSendMinConfidence}%`}</Muted>
                    ) : null}
                  </View>
                ) : null}

                {cat.suggestion ? (
                  <>
                    <Banner tone="success" testID={`suggestion-${cat.categoryId}`}>
                      {`Ready for Autopilot — it would have auto-sent ${cat.suggestion.wouldSend} of your last ${cat.suggestion.of} unchanged approvals at ${PRESET_LABEL.balanced}.`}
                    </Banner>
                    {canManage ? (
                      <Button
                        label="Turn on Autopilot"
                        onPress={() => changeMode(cat.categoryId, 'auto', cat.mode, cat.autoSendMinConfidence)}
                        loading={setPolicy.isPending}
                        testID={`suggestion-turn-on-${cat.categoryId}`}
                      />
                    ) : null}
                  </>
                ) : null}

                {demotionSentence !== null && cat.demotedAt !== null ? (
                  <Banner tone="warning" testID={`demoted-${cat.categoryId}`}>
                    {`Autopilot was paused ${relativeTime(cat.demotedAt)}: ${demotionSentence}`}
                  </Banner>
                ) : null}
              </Card>
            )
          })}
        </>
      ) : null}
    </Screen>
  )
}

/** The api's soft precondition codes travel as the error's `message` (`setCategoryPolicy`). */
function errorCodeOf(error: unknown): string {
  const message = (error as { message?: unknown } | null | undefined)?.message
  return typeof message === 'string' && message.length > 0 ? message : 'unknown'
}
function errorCopy(code: string, coldStartAt: number): string {
  if (code === 'cold_start') return `Auto unlocks after ${coldStartAt} decisions`
  if (code === 'agent_inactive') return 'Activate the agent first'
  return 'Could not save. Try again.'
}

const styles = StyleSheet.create({
  field: { gap: spacing.xs },
  agentRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  agentChip: { borderWidth: 1, borderRadius: radius.pill, paddingHorizontal: spacing.sm, paddingVertical: spacing.xs },
  delayRow: { flexDirection: 'row', gap: spacing.xs },
  delayChip: { flex: 1, borderWidth: 1, borderRadius: radius.md, paddingVertical: spacing.sm, alignItems: 'center' },
  modeRow: { flexDirection: 'row', gap: spacing.xs },
  modeCell: { flex: 1, borderWidth: 1, borderRadius: radius.md, padding: spacing.sm, gap: 2 },
  modeLabel: { fontFamily: font.uiStrong },
  presetRow: { flexDirection: 'row', gap: spacing.xs },
  presetCell: { flex: 1, borderWidth: 1, borderRadius: radius.md, paddingVertical: spacing.sm, alignItems: 'center' },
})
