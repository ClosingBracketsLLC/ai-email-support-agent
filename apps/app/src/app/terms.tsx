import { Screen } from '@/components/screen'
import { Body, Heading, Muted, Title } from '@/components/typography'

export default function Terms() {
  return (
    <Screen testID="terms">
      <Title>Terms of Service</Title>
      <Muted>Draft of 8 September 2026 — pending legal review.</Muted>
      <Heading>The service</Heading>
      <Body>aesa drafts and, when you enable it, sends replies to your customers’ email from your own mailbox. You remain responsible for what is sent from your addresses; every automatic reply can be reviewed, held and turned off at any time.</Body>
      <Heading>Your account and workspace</Heading>
      <Body>One workspace per business. Teammates you invite act on your behalf within the roles you give them. Keep your sign-in email secure; we never ask for a password.</Body>
      <Heading>Acceptable use</Heading>
      <Body>No unlawful, deceptive or abusive use of the mail we help you send. We may suspend a workspace that sends spam or violates a mail provider’s terms.</Body>
      <Heading>Fees</Heading>
      <Body>Pricing is per connected domain per month with an included allowance of AI-handled conversations; overage is billed as shown in Billing. Trials need no card.</Body>
      <Heading>Liability</Heading>
      <Body>The service is provided as is. To the extent permitted by law our liability is limited to the fees you paid in the twelve months before a claim.</Body>
      <Heading>Contact</Heading>
      <Body>legal@closingbrackets.com</Body>
    </Screen>
  )
}
