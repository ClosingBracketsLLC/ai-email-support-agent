import { Card } from '@/components/card'
import { Screen } from '@/components/screen'
import { Body, Muted, Title } from '@/components/typography'

export function PlaceholderScreen({ title, body, phase, testID }: { title: string; body: string; phase: string; testID: string }) {
  return (
    <Screen testID={testID}>
      <Title>{title}</Title>
      <Card><Body>{body}</Body><Muted>Arrives with {phase}.</Muted></Card>
    </Screen>
  )
}
