import { Platform } from 'react-native'
import { uploadAsync } from 'expo-file-system/legacy'
import type { KnowledgeUploadMime } from '@aesa/contracts'

/** One file chosen by the native picker or the web drop zone — `file` is web-only (the real `File`
 * object, which is what actually goes on the wire there); native streams `uri` instead. `size` is
 * `null` when the picker/drop couldn't report one (an `expo-document-picker` asset's `size` is
 * optional) — never defaulted to `0`, which would silently pass the upload-cap check client-side and
 * only die server-side. */
export interface PickedFile {
  name: string
  mime: string
  size: number | null
  uri: string
  file?: File
}

/** `.pdf`/`.docx`/`.md`/`.txt` → the matching `KNOWLEDGE_UPLOAD_MIMES` entry. */
const EXTENSION_MIME: Record<string, KnowledgeUploadMime> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  md: 'text/markdown',
  txt: 'text/plain',
}

/**
 * A picker or a browser drop can hand back an empty or absent MIME — Chrome reports `File.type ===
 * ''` for a `.md` drop, and `expo-document-picker`'s `DocumentPickerAsset.mimeType` is optional —
 * so a bare `declared` string is never enough to decide `wrong_type` on its own. Falls back to the
 * file's extension first; an unrecognized extension (or no extension) keeps whatever was declared,
 * even if that is still empty, so the caller's own "not a supported type" check still fires.
 */
export function inferMime(name: string, declared: string): string {
  if (declared) return declared
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  return EXTENSION_MIME[ext] ?? declared
}

/**
 * PUTs one already-signed file straight to storage — no multipart envelope either side, since
 * `knowledge.startUpload`'s presigned URL (`apps/api/src/knowledge/service.ts`) is a plain S3/minio
 * PUT. Web sends the real `File` body through `fetch`; native streams the cached file at `uri`
 * through `expo-file-system/legacy`'s `uploadAsync`, whose default `uploadType` (`BINARY_CONTENT`) is
 * exactly "the file is the request body" — the same shape the web branch sends over `fetch`.
 */
export async function uploadToPresignedUrl(input: { url: string; headers: Record<string, string>; file: PickedFile }): Promise<void> {
  const { url, headers, file } = input
  if (Platform.OS === 'web') {
    const res = await fetch(url, { method: 'PUT', headers, body: file.file })
    if (!res.ok) throw new Error(`upload failed with status ${res.status}`)
    return
  }
  const result = await uploadAsync(url, file.uri, { httpMethod: 'PUT', headers })
  if (result.status < 200 || result.status >= 300) throw new Error(`upload failed with status ${result.status}`)
}
