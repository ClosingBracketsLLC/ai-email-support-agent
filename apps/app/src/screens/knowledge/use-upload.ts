import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { KNOWLEDGE_MAX_UPLOAD_BYTES, KNOWLEDGE_UPLOAD_MIMES, type KnowledgeUploadMime } from '@aesa/contracts'
import { useTRPC } from '@/lib/trpc'
import { inferMime, uploadToPresignedUrl, type PickedFile } from '@/lib/upload'

export type UploadProgress = 'signing' | 'uploading' | 'queued' | 'failed'
/** Every `failed` `PendingUpload` carries one — always renderable in the owner's own words next to
 * the progress label (`source-cards.tsx`'s `UPLOAD_REASON_LABEL`). */
export type UploadFailureReason = 'too_large' | 'wrong_type' | 'unknown_size' | 'cap' | 'upload_failed'
export interface PendingUpload { id: string; name: string; progress: UploadProgress; reason: UploadFailureReason | null }
export interface StartUploadOutcome { stoppedBy: 'cap' | null }

function isKnowledgeMime(mime: string): mime is KnowledgeUploadMime {
  return (KNOWLEDGE_UPLOAD_MIMES as readonly string[]).includes(mime)
}

/** A stable per-pick id, decoupled from the file's own name (two picks — or two files dropped in the
 * same batch — can share one): `crypto.randomUUID` where the runtime has it, the pick's own index
 * otherwise. Never the file name, which `pending`'s list key used to be. */
function pickId(index: number): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `pick-${index}`
}

/** The refusal a file earns before it ever reaches the network — `null` means it's acceptable.
 * Mime is inferred from the extension FIRST (`inferMime`), so a browser's empty `File.type` for a
 * `.md` drop, or a native picker's absent `mimeType`, never reads as `wrong_type` on its own. */
function refusalReason(file: PickedFile): UploadFailureReason | null {
  if (file.size === null) return 'unknown_size'
  if (file.size > KNOWLEDGE_MAX_UPLOAD_BYTES) return 'too_large'
  if (!isKnowledgeMime(inferMime(file.name, file.mime))) return 'wrong_type'
  return null
}

function errorCode(err: unknown): string | undefined {
  return (err as { data?: { code?: string } } | null)?.data?.code
}

/**
 * The Upload card's own pipeline (spec §Product step 4): one file at a time, in order (`for`, not
 * `Promise.all`) — a predictable "signs → uploads → completes" per file. A refusal (too large, wrong
 * type, an unreadable size) never reaches `knowledge.startUpload` at all. A `FORBIDDEN` from
 * `startUpload` (the plan's source cap, `checkSourceCap` in `apps/api/src/knowledge/service.ts`)
 * stops the WHOLE batch immediately — every file still waiting its turn is marked `failed`/`cap`
 * without ever being signed — and `start` resolves `{ stoppedBy: 'cap' }` so `SourceCards` can raise
 * the shared cap banner instead of a generic per-file failure.
 *
 * A failure AFTER `startUpload` has minted its row deletes that row (best effort) on the way out, so
 * the only `queued` sources the owner ever sees are ones an ingest job is actually coming for.
 */
export function useUpload() {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const startUpload = useMutation(trpc.knowledge.startUpload.mutationOptions())
  const completeUpload = useMutation(trpc.knowledge.completeUpload.mutationOptions())
  const deleteSource = useMutation(trpc.knowledge.deleteSource.mutationOptions())
  const [pending, setPending] = useState<PendingUpload[]>([])

  function setProgress(id: string, progress: UploadProgress, reason: UploadFailureReason | null) {
    setPending((prev) => prev.map((p) => (p.id === id ? { ...p, progress, reason } : p)))
  }

  async function start(files: PickedFile[]): Promise<StartUploadOutcome> {
    const ids = files.map((_, i) => pickId(i))
    setPending(files.map((f, i) => {
      const reason = refusalReason(f)
      return { id: ids[i]!, name: f.name, progress: reason ? 'failed' : 'signing', reason }
    }))

    let stoppedByCap = false
    for (let i = 0; i < files.length; i++) {
      const file = files[i]!
      const id = ids[i]!
      if (refusalReason(file)) continue // already landed in `pending` as `failed` above
      if (stoppedByCap) { setProgress(id, 'failed', 'cap'); continue }
      const size = file.size
      if (size === null) continue // unreachable — `refusalReason` already filtered this — keeps TS honest

      // The row `startUpload` minted, remembered so a failure AFTER it can take the row back down
      // with it. A `queued` upload whose PUT or `completeUpload` never landed enqueues no ingest
      // job, so it would otherwise read "Queued for processing" forever, hold a `max_sources` slot
      // nothing will ever free, and keep the screen polling. Null while nothing has been minted —
      // a `FORBIDDEN` from `startUpload` itself leaves no row to delete.
      let mintedSourceId: string | null = null
      try {
        const mime = inferMime(file.name, file.mime) as KnowledgeUploadMime
        const signed = await startUpload.mutateAsync({ fileName: file.name, mime, byteSize: size })
        mintedSourceId = signed.sourceId
        setProgress(id, 'uploading', null)
        await uploadToPresignedUrl({ url: signed.url, headers: signed.headers, file })
        await completeUpload.mutateAsync({ sourceId: signed.sourceId })
        mintedSourceId = null
        setProgress(id, 'queued', null)
      } catch (err) {
        if (mintedSourceId !== null) {
          // Best effort, and never allowed to change what the owner is told: the upload already
          // failed, and a failed cleanup only leaves the same stranded row the owner can delete by
          // hand from the source list.
          try { await deleteSource.mutateAsync({ sourceId: mintedSourceId }) } catch { /* the row stays; the list's Delete is the fallback */ }
        }
        if (errorCode(err) === 'FORBIDDEN') {
          stoppedByCap = true
          setProgress(id, 'failed', 'cap')
        } else {
          setProgress(id, 'failed', 'upload_failed')
        }
      }
    }

    await queryClient.invalidateQueries({ queryKey: trpc.knowledge.list.queryKey() })
    return { stoppedBy: stoppedByCap ? 'cap' : null }
  }

  return { start, pending }
}
