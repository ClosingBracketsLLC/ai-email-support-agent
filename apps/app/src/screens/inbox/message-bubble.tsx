import { StyleSheet, Text, View } from 'react-native'
import { Button } from '@/components/button'
import { Muted } from '@/components/typography'
import { radius, spacing, typeScale, useColors } from '@/theme'

interface AttachmentMeta { filename?: string; mime?: string; size?: number }
/** `messages.attachments` is a jsonb column typed `unknown` at the schema level (comment: "[{filename,
 * mime, size}] metadata only") — narrowed defensively rather than trusted. */
function attachmentList(raw: unknown): AttachmentMeta[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((a): a is AttachmentMeta => typeof a === 'object' && a !== null)
}
function formatBytes(size: number | undefined): string {
  if (!size || size <= 0) return ''
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

export interface MessageBubbleMessage {
  id: string
  bodyText: string | null
  dmarcPass: boolean | null
  attachments: unknown
}

/**
 * One message in the ticket thread (extracted, unchanged, from `ticket.tsx:323-341`), plus Phase 7's
 * "Remember this reply" underneath every outbound bubble that still has text: the one-tap backfill
 * into memory for a hand-written reply, or one from before the agent existed (spec plan deviation
 * 16). `onRemember` is omitted (never called) for an inbound message — the caller only passes it for
 * an outbound one — and even then the button is withheld when there is no text to learn from.
 */
export function MessageBubble({
  message, outbound, onRemember, remembering = false,
}: {
  message: MessageBubbleMessage
  outbound: boolean
  onRemember?: () => void
  remembering?: boolean
}) {
  const c = useColors()
  const attachments = attachmentList(message.attachments)
  return (
    <View style={[styles.bubbleRow, outbound && styles.bubbleRowOut]}>
      <View style={styles.column}>
        <View style={[styles.bubble, { backgroundColor: outbound ? c.primary : c.surface, borderColor: c.border }]} testID={`message-${message.id}`}>
          {!outbound && message.dmarcPass === false ? <Muted testID={`message-unverified-${message.id}`}>unverified sender</Muted> : null}
          <Text style={{ color: outbound ? c.onPrimary : c.text }}>{message.bodyText ?? ''}</Text>
          {attachments.map((a, i) => (
            <Text key={i} style={[typeScale.caption, { color: outbound ? c.onPrimary : c.muted }]} testID={`message-attachment-${message.id}-${i}`}>
              {(a.filename ?? 'attachment') + (formatBytes(a.size) ? ` · ${formatBytes(a.size)}` : '')}
            </Text>
          ))}
        </View>
        {outbound && message.bodyText && onRemember ? (
          <Button
            variant="secondary" label="Remember this reply" onPress={onRemember}
            loading={remembering} disabled={remembering} testID={`remember-${message.id}`}
          />
        ) : null}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  bubbleRow: { flexDirection: 'row' },
  bubbleRowOut: { justifyContent: 'flex-end' },
  column: { maxWidth: '85%', gap: spacing.xs },
  bubble: { borderWidth: 1, borderRadius: radius.lg, padding: spacing.sm, gap: 2 },
})
