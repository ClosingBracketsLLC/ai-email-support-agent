import { Chip } from '@/components/chip'
import { formatCountdown } from './format-countdown'
import { useCountdown } from './use-countdown'

export interface AutoSendChipProps {
  /** The instant the reply actually goes — the send row's `send_after`, and the Hold deadline. */
  sendAfter: Date
  /** Test seams, injected the same way the undo bar's are (this codebase never uses fake timers). */
  tickMs?: number
  now?: () => Date
  testID?: string
}

/**
 * The inbox row's live word on an auto-send: how long the owner still has to hold it, and — past
 * that instant — that it is gone. Only the row needs this; the ticket screen has the full bar.
 */
export function AutoSendChip({ sendAfter, tickMs, now, testID }: AutoSendChipProps) {
  const { secondsLeft, done } = useCountdown(sendAfter, { tickMs, now })
  return <Chip tone="primary" testID={testID}>{done ? 'Sending…' : `Auto-sending · ${formatCountdown(secondsLeft)}`}</Chip>
}
