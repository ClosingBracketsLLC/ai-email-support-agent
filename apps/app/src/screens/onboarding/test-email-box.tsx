import { ActivityIndicator, StyleSheet, View } from 'react-native'
import { Button } from '@/components/button'
import { Card } from '@/components/card'
import { Body, Heading, Muted } from '@/components/typography'
import { spacing, useColors } from '@/theme'

export interface FirstDraft { ticketId: string; draftId: string; subject: string | null }

/**
 * The go-live proof: mail the agent yourself and watch its first draft land. Presentational — the
 * screen owns the poll that produces `firstDraft`.
 */
export function TestEmailBox({
  address, firstDraft, onReview, testID = 'test-email-box',
}: {
  address: string
  firstDraft: FirstDraft | null
  onReview: (ticketId: string) => void
  testID?: string
}) {
  const c = useColors()
  if (!firstDraft) {
    return (
      <Card testID={testID}>
        <Heading>Send yourself a test email</Heading>
        <Body>{`From any mailbox, email ${address} with a question a customer might ask. The agent's first draft appears here.`}</Body>
        <View style={styles.waiting} testID="waiting">
          <ActivityIndicator color={c.primary} />
          <Muted>Waiting for your first email…</Muted>
        </View>
      </Card>
    )
  }
  return (
    <Card testID={testID}>
      <Heading>Your first draft is ready</Heading>
      <Body>{firstDraft.subject || '(no subject)'}</Body>
      <Button label="Review it" onPress={() => onReview(firstDraft.ticketId)} testID="review-first-draft" />
    </Card>
  )
}

const styles = StyleSheet.create({ waiting: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm } })
