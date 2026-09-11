import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import { StyleSheet, View } from 'react-native'
import type { KnowledgeFailureReason, KnowledgeSourceKind, KnowledgeSourceStatus } from '@aesa/contracts'
import { Banner } from '@/components/banner'
import { Button } from '@/components/button'
import { Card } from '@/components/card'
import { Chip, type ChipTone } from '@/components/chip'
import { ListRow } from '@/components/list-row'
import { Muted } from '@/components/typography'
import { useTRPC } from '@/lib/trpc'
import { spacing } from '@/theme'

/** The slice of the api's `KnowledgeSourceView` (apps/api/src/knowledge/service.ts) this row draws —
 * declared here rather than imported off `AppRouter`, the same reasoning `draft-panel.tsx`'s
 * `DraftView` gives: the app describes what it draws. */
export interface SourceRow {
  id: string
  kind: KnowledgeSourceKind
  status: KnowledgeSourceStatus
  title: string
  url: string | null
  documentCount: number
  chunkCount: number
  failureReason: KnowledgeFailureReason | null
  failureDetail: string | null
  crawlProgress: { fetched: number; ingested: number; skipped: number } | null
}

const STATUS_LABEL: Record<KnowledgeSourceStatus, string> = { queued: 'Queued', processing: 'Processing', ready: 'Ready', failed: 'Failed' }
const STATUS_TONE: Record<KnowledgeSourceStatus, ChipTone> = { queued: 'primary', processing: 'primary', ready: 'success', failed: 'danger' }

/** In the owner's own words (task brief) — never the bare error code. */
const FAILURE_LABEL: Record<KnowledgeFailureReason, string> = {
  too_large: 'File is too large',
  wrong_type: 'File type is not supported',
  parse_failed: 'Could not read this file',
  parse_timeout: 'Took too long to read this file',
  no_text: 'No readable text was found',
  embed_failed: 'Could not process this text',
  crawl_failed: 'The crawl failed',
  crawl_no_pages: 'No pages were found to crawl',
  cap_reached: 'The source limit was reached mid-crawl',
}

function chipLabel(s: SourceRow): string {
  if (s.status === 'failed') return s.failureReason ? FAILURE_LABEL[s.failureReason] : 'Failed'
  return STATUS_LABEL[s.status]
}
function subtitleFor(s: SourceRow): string {
  if (s.kind === 'crawl') return s.url ?? s.title
  return `${s.documentCount} document${s.documentCount === 1 ? '' : 's'} · ${s.chunkCount} chunk${s.chunkCount === 1 ? '' : 's'}`
}

/**
 * The source list (spec §Product step 4): one `Card` per source, its status `Chip`, a crawl's
 * progress line, "Refresh" for a crawl sitting `ready`/`failed` (the only statuses `refreshCrawl`
 * actually accepts server-side — `apps/api/src/knowledge/service.ts`), and a two-tap "Delete" (the
 * same idiom `agent-edit.tsx`'s disable button and `mailboxes.tsx`'s disconnect use). `canManage`
 * false (a plain member) hides both actions entirely — read-only knowledge for members.
 */
export function SourceList({ sources, onChanged, canManage }: { sources: SourceRow[]; onChanged: () => void; canManage: boolean }) {
  const trpc = useTRPC()
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refreshCrawl = useMutation(trpc.knowledge.refreshCrawl.mutationOptions({
    onSuccess: onChanged,
    onError: () => setError('Could not refresh the crawl. Try again.'),
  }))
  const deleteSource = useMutation(trpc.knowledge.deleteSource.mutationOptions({
    onSuccess: () => { setConfirmingDeleteId(null); onChanged() },
    onError: () => setError('Could not delete this source. Try again.'),
  }))

  function handleRefresh(sourceId: string) {
    if (refreshCrawl.isPending) return
    setError(null)
    refreshCrawl.mutate({ sourceId })
  }
  function handleDelete(sourceId: string) {
    if (deleteSource.isPending) return
    setError(null)
    if (confirmingDeleteId === sourceId) {
      deleteSource.mutate({ sourceId })
    } else {
      setConfirmingDeleteId(sourceId)
    }
  }

  if (sources.length === 0) return <Muted testID="source-list-empty">No sources yet — crawl, paste, or upload something below.</Muted>

  return (
    <View style={styles.stack}>
      {sources.map((s) => {
        // Both mutations are ONE shared instance across every row — `.isPending` alone would show
        // every row's button spinning while only one source is actually being refreshed/deleted.
        // `.variables` is whichever row's own call is in flight, so an armed "Confirm delete" on a
        // DIFFERENT row keeps showing its label instead of flickering to a spinner that isn't its own.
        const refreshingThis = refreshCrawl.isPending && refreshCrawl.variables?.sourceId === s.id
        const deletingThis = deleteSource.isPending && deleteSource.variables?.sourceId === s.id
        return (
          <Card key={s.id} testID={`source-${s.id}`}>
            <ListRow title={s.title} subtitle={subtitleFor(s)} />
            <Chip tone={STATUS_TONE[s.status]} testID={`source-status-${s.id}`}>{chipLabel(s)}</Chip>
            {s.kind === 'crawl' && s.crawlProgress ? (
              <Muted testID={`crawl-progress-${s.id}`}>
                {`${s.crawlProgress.ingested}/${s.crawlProgress.fetched} pages ingested${s.crawlProgress.skipped > 0 ? ` · ${s.crawlProgress.skipped} skipped` : ''}`}
              </Muted>
            ) : null}
            {canManage ? (
              <View style={styles.actions}>
                {s.kind === 'crawl' && (s.status === 'ready' || s.status === 'failed') ? (
                  <Button variant="secondary" label="Refresh" onPress={() => handleRefresh(s.id)} loading={refreshingThis} testID={`refresh-${s.id}`} />
                ) : null}
                <Button
                  variant={confirmingDeleteId === s.id ? 'danger' : 'secondary'}
                  label={confirmingDeleteId === s.id ? 'Confirm delete' : 'Delete'}
                  onPress={() => handleDelete(s.id)} loading={deletingThis} testID={`delete-${s.id}`}
                />
              </View>
            ) : null}
          </Card>
        )
      })}
      {error ? <Banner tone="error" testID="source-list-error">{error}</Banner> : null}
    </View>
  )
}

const styles = StyleSheet.create({
  stack: { gap: spacing.sm },
  actions: { flexDirection: 'row', gap: spacing.sm },
})
