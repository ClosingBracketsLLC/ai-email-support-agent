import { Banner } from '@/components/banner'
import { Button } from '@/components/button'
import { Card } from '@/components/card'
import { Screen } from '@/components/screen'
import { Body, Muted, Title } from '@/components/typography'
import { useAdvance } from './mailbox'
import { Stepper } from './stepper'

export function GoLiveStep() {
  const advance = useAdvance()
  return (
    <Screen testID="onboarding-go-live">
      <Stepper current="go_live" />
      <Title>Almost there</Title>
      <Card>
        <Body>Every category starts in Review: the agent drafts, you approve. The master switch, the "send yourself a test email" box and the review queue arrive with the drafting release.</Body>
        <Muted>Finishing now takes you to your workspace; you will be nudged here again when the agent can go live.</Muted>
      </Card>
      {advance.isError ? <Banner tone="error">Could not save your progress. Try again.</Banner> : null}
      <Button label="Finish setup" onPress={() => advance.mutate()} loading={advance.isPending} testID="finish" />
    </Screen>
  )
}
