import { Platform } from 'react-native'
import { Banner } from '@/components/banner'
import { Button } from '@/components/button'
import { Card } from '@/components/card'
import { Screen } from '@/components/screen'
import { Body, Muted, Title } from '@/components/typography'
import { useAdvance } from './mailbox'
import { Stepper } from './stepper'

export function KnowledgeStep() {
  const advance = useAdvance()
  return (
    <Screen testID="onboarding-knowledge">
      <Stepper current="knowledge" />
      <Title>Give the agent knowledge</Title>
      <Card>
        <Body>Crawl your website, paste FAQs and policies, or upload files. Knowledge arrives in a later release; the agent is only as good as its grounding, so this step will be worth the five minutes.</Body>
        {Platform.OS !== 'web' ? <Muted>Tip: finish this step on a desktop to upload documents.</Muted> : null}
      </Card>
      {advance.isError ? <Banner tone="error">Could not save your progress. Try again.</Banner> : null}
      <Button label="Skip for now" variant="secondary" onPress={() => advance.mutate()} loading={advance.isPending} testID="skip" />
    </Screen>
  )
}
