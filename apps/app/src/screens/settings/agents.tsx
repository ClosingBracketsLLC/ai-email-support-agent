import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'expo-router'
import { useState } from 'react'
import { StyleSheet, View } from 'react-native'
import type { AgentStatus, PersonaPreset } from '@aesa/contracts'
import { PERSONA_PRESETS } from '@aesa/contracts'
import { Banner } from '@/components/banner'
import { Button } from '@/components/button'
import { Card } from '@/components/card'
import { ListRow } from '@/components/list-row'
import { Loading } from '@/components/loading'
import { Screen } from '@/components/screen'
import { Heading, Muted } from '@/components/typography'
import { useTRPC } from '@/lib/trpc'
import { spacing } from '@/theme'

const AGENT_STATUS_LABEL: Record<AgentStatus, string> = { pending_verification: 'waiting for code', active: 'Active', disabled: 'Disabled' }
const PERSONA_LABEL: Record<PersonaPreset, string> = { support: 'Support', sales: 'Sales', concierge: 'Concierge', billing: 'Billing' }

/** `status`/`personaPreset` columns are plain `text` (checked by the API, not a drizzle `pgEnum`), so
 * the tRPC-inferred type is a bare `string` — this looks a value up against its label map without an
 * unchecked cast, falling back to the raw value for anything the map doesn't recognize. Same pattern
 * as `mailboxes.tsx`'s `label()`. */
function label<T extends string>(map: Record<T, string>, value: string): string {
  return (map as Record<string, string>)[value] ?? value
}
function toPersonaPreset(value: string): PersonaPreset {
  return (PERSONA_PRESETS as readonly string[]).includes(value) ? (value as PersonaPreset) : 'support'
}

export function AgentsScreen() {
  const trpc = useTRPC()
  const router = useRouter()
  const queryClient = useQueryClient()
  const list = useQuery(trpc.agents.list.queryOptions())
  const update = useMutation(trpc.agents.update.mutationOptions())
  const [swapping, setSwapping] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!list.data) return <Loading />
  const agentsList = list.data.agents
  type AgentRow = (typeof agentsList)[number]

  // The api already orders by (connectionId, priority), so a `Map` preserves that order while
  // grouping — keyed by connectionId, so the group's own key never needs an indexed lookup.
  const groupMap = new Map<string, AgentRow[]>()
  for (const a of agentsList) {
    const arr = groupMap.get(a.connectionId)
    if (arr) arr.push(a)
    else groupMap.set(a.connectionId, [a])
  }
  const groups = [...groupMap.entries()]

  async function swap(a: { id: string; priority: number }, b: { id: string; priority: number }) {
    if (swapping) return
    setSwapping(true)
    setError(null)
    try {
      // Two separate calls, not one transaction — if the first succeeds and the second fails, the
      // server is left with a duplicate priority. `invalidateQueries` runs in `finally` regardless
      // (review fix, Important 2), so the list always resyncs to whatever actually landed rather than
      // showing the stale pre-swap order; the catch path also warns that the swap may be incomplete.
      await update.mutateAsync({ agentId: a.id, priority: b.priority })
      await update.mutateAsync({ agentId: b.id, priority: a.priority })
    } catch {
      setError('Could not finish reordering — it may have partially applied. Refreshed the list below.')
    } finally {
      await queryClient.invalidateQueries({ queryKey: trpc.agents.list.queryKey() })
      setSwapping(false)
    }
  }

  return (
    <Screen testID="agents">
      <Heading>Agents</Heading>
      {agentsList.length === 0 ? <Muted>No agents yet — add an address from Mailboxes to create one.</Muted> : null}
      {groups.map(([connectionId, group]) => (
        <View key={connectionId} style={styles.group}>
          {group.map((a, i) => {
            const prev = group[i - 1]
            const next = group[i + 1]
            return (
              <Card key={a.id} testID={`agent-row-${a.id}`}>
                <ListRow
                  title={a.address}
                  subtitle={PERSONA_LABEL[toPersonaPreset(a.personaPreset)]}
                  badge={label(AGENT_STATUS_LABEL, a.status)}
                  onPress={() => router.push(`/settings/agents/${a.id}`)}
                  testID={`agent-${a.id}`}
                />
                {group.length > 1 ? (
                  <View style={styles.reorderRow}>
                    <Button variant="secondary" label="Move up" onPress={() => prev && swap(a, prev)} disabled={!prev || swapping} testID={`agent-up-${a.id}`} />
                    <Button variant="secondary" label="Move down" onPress={() => next && swap(a, next)} disabled={!next || swapping} testID={`agent-down-${a.id}`} />
                  </View>
                ) : null}
              </Card>
            )
          })}
        </View>
      ))}
      {error ? <Banner tone="error">{error}</Banner> : null}
    </Screen>
  )
}

const styles = StyleSheet.create({
  group: { gap: spacing.sm },
  reorderRow: { flexDirection: 'row', gap: spacing.sm },
})
