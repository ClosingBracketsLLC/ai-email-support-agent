import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { Banner } from '@/components/banner'
import { Button } from '@/components/button'
import { Card } from '@/components/card'
import { Body, Heading, Muted } from '@/components/typography'
import { useTRPC } from '@/lib/trpc'
import { spacing } from '@/theme'

/**
 * Rules the agent noticed you applying by hand — `guidance.suggest` writes them from the edits you
 * made to its drafts, and accepting one appends it to the operating guidance every guardrail gate
 * screens against.
 *
 * Renders nothing at all when there is nothing pending: this sits above the guidance editor on the
 * Knowledge screen and must not leave an empty card there. `canManage` false (a plain member) keeps
 * the reading and drops both buttons — `acceptSuggestion`/`dismissSuggestion` are
 * `managerProcedure`s, so offering them would only produce a 403.
 */
export function GuidanceSuggestions({ canManage }: { canManage: boolean }) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const [error, setError] = useState<string | null>(null)
  const list = useQuery(trpc.workspace.guidanceSuggestions.queryOptions())

  async function refresh() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: trpc.workspace.guidanceSuggestions.queryKey() }),
      // The accepted rule IS the guidance now — the editor below has to show it.
      queryClient.invalidateQueries({ queryKey: trpc.workspace.get.queryKey() }),
    ])
  }

  const accept = useMutation(trpc.workspace.acceptSuggestion.mutationOptions({
    onSuccess: () => { setError(null); void refresh() },
    // `guidance_full` is the api's own precondition code (the 8,000-character cap): the suggestion
    // stays pending, so the owner can make room and come back to it.
    onError: (e: unknown) => setError((e as { message?: unknown } | null)?.message === 'guidance_full'
      ? 'Your guidance is full — remove something first'
      : 'Could not add that rule. Try again.'),
  }))
  const dismiss = useMutation(trpc.workspace.dismissSuggestion.mutationOptions({
    onSuccess: () => { setError(null); void refresh() },
    onError: () => setError('Could not dismiss that. Try again.'),
  }))

  const suggestions = list.data?.suggestions ?? []
  if (suggestions.length === 0) return null
  const busy = accept.isPending || dismiss.isPending

  return (
    <Card testID="guidance-suggestions">
      <Heading>Suggested rules</Heading>
      <Muted>From replies you edited</Muted>
      {error ? <Banner tone="error" testID="suggestion-error">{error}</Banner> : null}
      {suggestions.map((s) => (
        <View key={s.id} style={styles.row} testID={`suggestion-${s.id}`}>
          <Body>{s.text}</Body>
          {s.rationale ? <Muted>{s.rationale}</Muted> : null}
          <Muted>{`${s.categoryLabel ?? 'Uncategorized'} · ${s.agentAddress ?? ''}`}</Muted>
          {canManage ? (
            <>
              <Button label="Add to guidance" onPress={() => accept.mutate({ suggestionId: s.id })} disabled={busy} testID={`accept-${s.id}`} />
              <Button label="Dismiss" variant="secondary" onPress={() => dismiss.mutate({ suggestionId: s.id })} disabled={busy} testID={`dismiss-${s.id}`} />
            </>
          ) : null}
        </View>
      ))}
    </Card>
  )
}

const styles = StyleSheet.create({
  row: { gap: spacing.xs },
})
