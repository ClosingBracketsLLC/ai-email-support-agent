import { useQuery } from '@tanstack/react-query'
import { StyleSheet, View } from 'react-native'
import { Card } from '@/components/card'
import { Body, Heading, Muted } from '@/components/typography'
import { useTRPC } from '@/lib/trpc'
import { spacing } from '@/theme'

/**
 * The gaps report (spec §Product step 4 / Phase 4's "Improve" loop): how many drafts in the rolling
 * window cited no knowledge at all, and the top questions the agent couldn't ground an answer in —
 * "the gaps report says what to upload next." Read-only; questions have no id server-side (grouped by
 * normalized text), so the array index is the row key.
 */
export function GapsCard() {
  const trpc = useTRPC()
  const gaps = useQuery(trpc.knowledge.gaps.queryOptions())
  if (!gaps.data) return null

  const { windowDays, drafts, uncited, questions } = gaps.data

  return (
    <Card testID="gaps-card">
      <Heading>Gaps</Heading>
      <Body testID="gaps-summary">{`${uncited} of ${drafts} drafts in the last ${windowDays} days cited no knowledge`}</Body>
      {questions.length > 0 ? (
        <View style={styles.questions}>
          <Muted>Top unanswered questions</Muted>
          {questions.map((q, i) => (
            <View key={`${q.text}-${i}`} testID={`gap-question-${i}`} style={styles.question}>
              <Body>{q.text}</Body>
              <Muted>{`${q.count}×`}</Muted>
            </View>
          ))}
        </View>
      ) : null}
    </Card>
  )
}

const styles = StyleSheet.create({
  questions: { gap: spacing.xs },
  question: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.sm },
})
