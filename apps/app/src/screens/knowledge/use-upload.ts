import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { KNOWLEDGE_MAX_UPLOAD_BYTES, KNOWLEDGE_UPLOAD_MIMES, type KnowledgeUploadMime } from '@aesa/contracts'
import { useTRPC } from '@/lib/trpc'
import { uploadToPresignedUrl, type PickedFile } from '@/lib/upload'

export type UploadProgress = 'signing' | 'uploading' | 'queued' | 'failed'
export interface PendingUpload { name: string; progress: UploadProgress }

function isKnowledgeMime(mime: string): mime is KnowledgeUploadMime {
  return (KNOWLEDGE_UPLOAD_MIMES as readonly string[]).includes(mime)
}
function isAcceptable(file: PickedFile): boolean {
  return file.size <= KNOWLEDGE_MAX_UPLOAD_BYTES && isKnowledgeMime(file.mime)
}

/**
 * The Upload card's own pipeline (spec §Product step 4): one file at a time, in order (`for`, not
 * `Promise.all`) — a predictable "signs → uploads → completes" per file, and a slow or failed file
 * never blocks the ones behind it since each is wrapped in its own try/catch. A file over
 * `KNOWLEDGE_MAX_UPLOAD_BYTES` or outside `KNOWLEDGE_UPLOAD_MIMES` never reaches `knowledge.startUpload`
 * at all — it lands in `pending` as `failed` immediately, before any network call.
 */
export function useUpload() {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const startUpload = useMutation(trpc.knowledge.startUpload.mutationOptions())
  const completeUpload = useMutation(trpc.knowledge.completeUpload.mutationOptions())
  const [pending, setPending] = useState<PendingUpload[]>([])

  function setProgress(name: string, progress: UploadProgress) {
    setPending((prev) => prev.map((p) => (p.name === name ? { ...p, progress } : p)))
  }

  async function start(files: PickedFile[]) {
    setPending(files.map((f) => ({ name: f.name, progress: isAcceptable(f) ? 'signing' : 'failed' })))

    for (const file of files) {
      if (!isAcceptable(file)) continue
      try {
        const signed = await startUpload.mutateAsync({ fileName: file.name, mime: file.mime as KnowledgeUploadMime, byteSize: file.size })
        setProgress(file.name, 'uploading')
        await uploadToPresignedUrl({ url: signed.url, headers: signed.headers, file })
        await completeUpload.mutateAsync({ sourceId: signed.sourceId })
        setProgress(file.name, 'queued')
      } catch {
        setProgress(file.name, 'failed')
      }
    }

    await queryClient.invalidateQueries({ queryKey: trpc.knowledge.list.queryKey() })
  }

  return { start, pending }
}
