import { useMutation, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { StyleSheet, View } from 'react-native'
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
  const flagged = useQuery(trpc.knowledge.flaggedChunks.queryOptions())
  const [error, setError] = useState<string | null>(null)

  const refresh = () => { void flagged.refetch() }
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
          {chunk.reason ? <Muted>{chunk.reason}</Muted> : null}
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
