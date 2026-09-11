import { useEffect, useRef } from 'react'
import { Pressable, StyleSheet, type View } from 'react-native'
import { KNOWLEDGE_UPLOAD_MIMES } from '@aesa/contracts'
import { Muted } from '@/components/typography'
import type { PickedFile } from '@/lib/upload'
import { radius, spacing, useColors } from '@/theme'

export interface DropZoneProps { onFiles: (files: PickedFile[]) => void; disabled?: boolean }

/** The minimal surface `bindDropZone` needs off a DOM node — matched by a real `HTMLElement` (what a
 * `Pressable`'s ref resolves to under react-native-web) and by the fake node `drop-zone.web.test.tsx`
 * uses to test this without a browser. */
export interface DropZoneNode {
  addEventListener: (type: string, listener: EventListener) => void
  removeEventListener: (type: string, listener: EventListener) => void
}
export interface DropZoneHandlers {
  onFiles: (files: File[]) => void
  onDragState?: (active: boolean) => void
}

/**
 * Pure DOM wiring — no React, no react-native-web — so it can be unit-tested with a fake event
 * target. React Native Web's `View` (which `Pressable` wraps) forwards only a fixed prop allowlist
 * (`react-native-web/dist/modules/forwardedProps`), and drag events are not on it: handing
 * `onDragOver`/`onDrop` straight to a `Pressable` binds nothing at all, so the browser's own default
 * handling of the drop — navigating away to the dropped file — was never prevented (the bug this
 * replaces). Every one of the four events gets its own `preventDefault()`: the browser's default
 * handling of `dragenter`/`dragover`/`dragleave` is exactly what has to be suppressed for `drop` to
 * ever fire as a drop instead of a navigation.
 */
export function bindDropZone(node: DropZoneNode, handlers: DropZoneHandlers): () => void {
  const onDragEnter = (event: DragEvent) => { event.preventDefault(); handlers.onDragState?.(true) }
  const onDragOver = (event: DragEvent) => { event.preventDefault() }
  const onDragLeave = (event: DragEvent) => { event.preventDefault(); handlers.onDragState?.(false) }
  const onDrop = (event: DragEvent) => {
    event.preventDefault()
    handlers.onDragState?.(false)
    const files = event.dataTransfer?.files
    handlers.onFiles(files ? Array.from(files) : [])
  }

  node.addEventListener('dragenter', onDragEnter as EventListener)
  node.addEventListener('dragover', onDragOver as EventListener)
  node.addEventListener('dragleave', onDragLeave as EventListener)
  node.addEventListener('drop', onDrop as EventListener)

  return () => {
    node.removeEventListener('dragenter', onDragEnter as EventListener)
    node.removeEventListener('dragover', onDragOver as EventListener)
    node.removeEventListener('dragleave', onDragLeave as EventListener)
    node.removeEventListener('drop', onDrop as EventListener)
  }
}

/** `uri` is never read on web (`lib/upload.ts`'s web branch PUTs `file.file` directly) — a stand-in
 * so `PickedFile`'s required `uri` field is satisfied without touching `URL.createObjectURL`, which
 * jest's node test environment for this suite (`@react-native/jest-preset`'s `ReactNativeEnv`) does
 * not provide. `size` is always a number for a real DOM `File` — never the `null` a native picker's
 * asset can report. */
function toPickedFiles(files: File[]): PickedFile[] {
  return files.map((file) => ({ name: file.name, mime: file.type, size: file.size, uri: file.name, file }))
}

/**
 * The web "Upload" card: a real DOM drag/drop target, bound imperatively through `bindDropZone` via
 * a ref + effect (the same imperative-DOM-listener shape `ticket.tsx`'s keyboard-shortcut effect
 * uses), that ALSO opens the system file picker on press — desktop users often reach for a click
 * before a drag. The picker itself is a throwaway `<input type="file">`, created and clicked rather
 * than rendered, so this stays a single `Pressable` with one `testID`.
 */
export function DropZone({ onFiles, disabled }: DropZoneProps) {
  const c = useColors()
  const ref = useRef<View>(null)

  useEffect(() => {
    if (disabled) return
    const node = ref.current as unknown as DropZoneNode | null
    if (!node) return
    return bindDropZone(node, { onFiles: (files) => onFiles(toPickedFiles(files)) })
  }, [disabled, onFiles])

  function openPicker() {
    if (disabled) return
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.accept = KNOWLEDGE_UPLOAD_MIMES.join(',')
    input.onchange = () => { onFiles(toPickedFiles(input.files ? Array.from(input.files) : [])); input.remove() }
    document.body.appendChild(input)
    input.click()
  }

  return (
    <Pressable
      ref={ref} testID="drop-zone" disabled={disabled} onPress={openPicker}
      style={[styles.zone, { borderColor: c.border, backgroundColor: c.surface, opacity: disabled ? 0.6 : 1 }]}
    >
      <Muted>Drag files here, or tap to choose</Muted>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  zone: { borderWidth: 1, borderStyle: 'dashed', borderRadius: radius.md, padding: spacing.lg, alignItems: 'center', justifyContent: 'center', minHeight: 96 },
})
