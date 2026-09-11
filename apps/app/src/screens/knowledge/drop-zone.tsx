import * as DocumentPicker from 'expo-document-picker'
import { KNOWLEDGE_UPLOAD_MIMES } from '@aesa/contracts'
import { Button } from '@/components/button'
import type { PickedFile } from '@/lib/upload'

export interface DropZoneProps { onFiles: (files: PickedFile[]) => void; disabled?: boolean }

/**
 * The native "Upload" card: the system document picker, `multiple: true`, files copied to the app's
 * cache directory so `lib/upload.ts`'s `uploadAsync` can stream them straight from `uri` afterward.
 * The web sibling (`drop-zone.web.tsx`) is a real DOM drop target instead — Metro/webpack resolve the
 * platform file for a build, and jest-expo's default (non-web) project resolves this one for every
 * test except `drop-zone.web.test.tsx`'s own direct smoke test (CLAUDE.md's app-bundle note).
 */
export function DropZone({ onFiles, disabled }: DropZoneProps) {
  async function pick() {
    const result = await DocumentPicker.getDocumentAsync({ type: [...KNOWLEDGE_UPLOAD_MIMES], multiple: true, copyToCacheDirectory: true })
    if (result.canceled || !result.assets) return
    onFiles(result.assets.map((a) => ({ name: a.name, mime: a.mimeType ?? 'application/octet-stream', size: a.size ?? 0, uri: a.uri, file: a.file })))
  }
  return <Button variant="secondary" label="Choose files" onPress={pick} disabled={disabled} testID="drop-zone-picker" />
}
