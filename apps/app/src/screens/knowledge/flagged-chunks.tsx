import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { StyleSheet, View } from 'react-native'
import type { KnowledgeInjectionReason } from '@aesa/contracts'
import { Banner } from '@/components/banner'
import { Button } from '@/components/button'
import { Card } from '@/components/card'
import { Body, Heading, Muted } from '@/components/typography'
import { useTRPC } from '@/lib/trpc'
import { spacing } from '@/theme'

const EXCERPT_MAX = 240

function excerpt(content: string): string {
  const trimmed = content.trim()
  return trimmed.length > EXCERPT_MAX ? `${trimmed.slice(0, EXCERPT_MAX)}…` : trimmed
}

/**
 * Why this passage was quarantined, in the owner's own words — never `screenChunk`'s internal code
 * (`packages/knowledge/src/injection.ts`), which reads as jargon to the person who has to decide
 * whether their own FAQ is safe. Keyed by `KNOWLEDGE_INJECTION_REASONS` (`@aesa/contracts`), so a new
 * rule fails the build here until it has copy.
 *
 * Every line is written to be read next to the passage itself and to leave room for an honest false
 * positive: `role_marker` in particular fires on a pasted support TRANSCRIPT ("User: how do I…"),
 * which is perfectly legitimate knowledge — hence "Allow" sitting right underneath.
 */
const INJECTION_REASON_LABEL: Record<KnowledgeInjectionReason, string> = {
  override_instructions: 'Tells the agent to ignore its instructions',
  role_reassignment: 'Tries to give the agent a different role',
  system_prompt: 'Talks about the agent\u2019s own system prompt',
  concealment: 'Asks for something to be kept from you',
  role_marker: 'Contains a chat role marker like \u201cUser:\u201d or \u201cAssistant:\u201d \u2014 common in a pasted transcript',
  forced_output: 'Dictates exactly what the agent must reply',
  exfiltration: 'Asks for information to be sent somewhere',
  invisible_text: 'Hidden characters a reader cannot see',
}

/** Anything the app has no copy for — a row written before a rule was renamed — still renders. */
function reasonLabel(reason: KnowledgeInjectionReason | null): string | null {
  if (!reason) return null
  return INJECTION_REASON_LABEL[reason] ?? 'Looked like an instruction rather than information'
}

/**
 * The flagged-chunk view (spec §Product step 4): rendered by `knowledge.tsx` only while
 * `counts.flaggedChunks > 0`, but it runs its own `knowledge.flaggedChunks` query rather than taking
 * the chunks as a prop, so it stays self-contained (own loading/error/mutation state, like every
 * other card on this screen). Deleting a chunk is a single tap — unlike a source, a flagged chunk was
 * never doing anything useful yet (it is quarantined, never retrieved), so there is nothing a second
 * tap protects against. `canManage` false (a plain member) hides Allow/Delete — read-only knowledge
 * for members — but the content itself, and why it was flagged, stays visible either way.
 */
export function FlaggedChunks({ canManage }: { canManage: boolean }) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const flagged = useQuery(trpc.knowledge.flaggedChunks.queryOptions())
  const [error, setError] = useState<string | null>(null)

  // Both mutations move a chunk out of the flagged set, which changes `knowledge.list`'s
  // `counts.flaggedChunks` (what decides whether this card renders at all) and, for Allow, its
  // `counts.readyChunks` too — so the list has to be invalidated alongside this card's own refetch.
  const refresh = () => {
    void flagged.refetch()
    void queryClient.invalidateQueries({ queryKey: trpc.knowledge.list.queryKey() })
  }
  const unflag = useMutation(trpc.knowledge.unflagChunk.mutationOptions({
    onSuccess: refresh,
    onError: () => setError('Could not allow this content. Try again.'),
  }))
  const del = useMutation(trpc.knowledge.deleteChunk.mutationOptions({
    onSuccess: refresh,
    onError: () => setError('Could not delete this content. Try again.'),
  }))

  if (!flagged.data || flagged.data.chunks.length === 0) return null

  return (
    <Card testID="flagged-chunks">
      <Heading>Flagged content</Heading>
      <Muted>The agent will never use these until you allow them — each one looked like an instruction rather than information.</Muted>
      {flagged.data.chunks.map((chunk) => (
        <View key={chunk.id} testID={`flagged-chunk-${chunk.id}`} style={styles.chunk}>
          <Body>{chunk.headingPath.length > 0 ? chunk.headingPath.join(' › ') : chunk.sourceTitle}</Body>
          <Muted>{excerpt(chunk.content)}</Muted>
          {reasonLabel(chunk.reason) ? <Muted>{reasonLabel(chunk.reason)}</Muted> : null}
          {canManage ? (
            <View style={styles.actions}>
              <Button variant="secondary" label="Allow" onPress={() => { setError(null); unflag.mutate({ chunkId: chunk.id }) }} loading={unflag.isPending} testID={`allow-${chunk.id}`} />
              <Button variant="danger" label="Delete" onPress={() => { setError(null); del.mutate({ chunkId: chunk.id }) }} loading={del.isPending} testID={`delete-chunk-${chunk.id}`} />
            </View>
          ) : null}
        </View>
      ))}
      {error ? <Banner tone="error">{error}</Banner> : null}
    </Card>
  )
}

const styles = StyleSheet.create({
  chunk: { gap: spacing.xs },
  actions: { flexDirection: 'row', gap: spacing.sm },
})
