import { Platform } from 'react-native'
import { uploadAsync } from 'expo-file-system/legacy'

/** One file chosen by the native picker or the web drop zone — `file` is web-only (the real `File`
 * object, which is what actually goes on the wire there); native streams `uri` instead. */
export interface PickedFile {
  name: string
  mime: string
  size: number
  uri: string
  file?: File
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
