import { Screen } from '@/components/screen'
import { Body, Heading, Muted, Title } from '@/components/typography'

export default function Privacy() {
  return (
    <Screen testID="privacy">
      <Title>Privacy Policy</Title>
      <Muted>Draft of 8 September 2026 — pending legal review. Closing Brackets (“we”) operates aesa.</Muted>
      <Heading>What we collect</Heading>
      <Body>Your account (name, email, sign-in method), your workspace profile, and — once you connect a mailbox — the customer email addressed to the addresses you choose, so the agent can draft replies. We never read mail sent to addresses you did not select.</Body>
      <Heading>Where it goes</Heading>
      <Body>Data is stored in our Postgres database (hosted in the region shown in your workspace settings). To draft a reply, the relevant customer message and your knowledge are sent to the AI provider your workspace uses: our managed provider (Anthropic, and Voyage AI for search embeddings) by default, or a provider you connect yourself under that provider’s terms. Platform email (sign-in codes, invitations, digests) is sent through Resend. Push notifications go through Expo’s push service. We do not sell personal data.</Body>
      <Heading>Retention and deletion</Heading>
      <Body>Message bodies are kept for the retention period set on your workspace (180 days by default) and audit records for two years. You can delete a workspace; the data is removed after a 30-day grace period. You can ask us to delete everything the agent learned from a single customer.</Body>
      <Heading>Your rights and contact</Heading>
      <Body>Access, correction, export and deletion requests: privacy@closingbrackets.com.</Body>
    </Screen>
  )
}
