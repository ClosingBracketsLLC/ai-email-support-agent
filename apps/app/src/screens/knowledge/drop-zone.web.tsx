import { Pressable, StyleSheet } from 'react-native'
import { KNOWLEDGE_UPLOAD_MIMES } from '@aesa/contracts'
import { Muted } from '@/components/typography'
import type { PickedFile } from '@/lib/upload'
import { radius, spacing, useColors } from '@/theme'

export interface DropZoneProps { onFiles: (files: PickedFile[]) => void; disabled?: boolean }

/** `uri` is never read on web (`lib/upload.ts`'s web branch PUTs `file.file` directly) — a stand-in
 * so `PickedFile`'s required `uri` field is satisfied without touching `URL.createObjectURL`, which
 * jest's node test environment for this suite (`@react-native/jest-preset`'s `ReactNativeEnv`) does
 * not provide. */
function toPickedFiles(list: FileList | null | undefined): PickedFile[] {
  if (!list) return []
  return Array.from(list).map((file) => ({ name: file.name, mime: file.type, size: file.size, uri: file.name, file }))
}

/**
 * The web "Upload" card: a real DOM drag/drop target that ALSO opens the system file picker on
 * press — desktop users often reach for a click before a drag. React Native Web forwards unrecognized
 * DOM event props (`onDragOver`, `onDrop`) straight through to the underlying `<div>`; the picker
 * itself is opened by creating a throwaway `<input type="file">` rather than rendering one, so this
 * stays a single `Pressable` with one `testID`.
 */
export function DropZone({ onFiles, disabled }: DropZoneProps) {
  const c = useColors()

  function openPicker() {
    if (disabled) return
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.accept = KNOWLEDGE_UPLOAD_MIMES.join(',')
    input.onchange = () => { onFiles(toPickedFiles(input.files)); input.remove() }
    document.body.appendChild(input)
    input.click()
  }
  function handleDragOver(e: { preventDefault: () => void }) {
    e.preventDefault()
  }
  function handleDrop(e: { preventDefault: () => void; dataTransfer?: { files?: FileList | null } }) {
    e.preventDefault()
    if (disabled) return
    onFiles(toPickedFiles(e.dataTransfer?.files))
  }
  const domHandlers = { onDragOver: handleDragOver, onDrop: handleDrop }

  return (
    <Pressable
      testID="drop-zone" disabled={disabled} onPress={openPicker} {...domHandlers}
      style={[styles.zone, { borderColor: c.border, backgroundColor: c.surface, opacity: disabled ? 0.6 : 1 }]}
    >
      <Muted>Drag files here, or tap to choose</Muted>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  zone: { borderWidth: 1, borderStyle: 'dashed', borderRadius: radius.md, padding: spacing.lg, alignItems: 'center', justifyContent: 'center', minHeight: 96 },
})
