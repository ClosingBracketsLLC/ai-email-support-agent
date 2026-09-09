import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { StyleSheet, View } from 'react-native'
import type { AgentStatus, ConnectionStatus, MailProvider } from '@aesa/contracts'
import { Banner } from '@/components/banner'
import { Button } from '@/components/button'
import { Card } from '@/components/card'
import { ListRow } from '@/components/list-row'
import { Loading } from '@/components/loading'
import { Screen } from '@/components/screen'
import { Body, Heading, Muted } from '@/components/typography'
import { useTRPC } from '@/lib/trpc'
import { spacing } from '@/theme'
import { AddressSheet } from './address-sheet'
import { ConnectMailboxCard } from './connect-card'

const CONNECTION_STATUS_LABEL: Record<ConnectionStatus, string> = {
  pending_claim: 'Connecting…', connected: 'Connected', reauth_required: 'Reauth needed', disabled: 'Disabled',
}
const AGENT_STATUS_LABEL: Record<AgentStatus, string> = {
  pending_verification: 'waiting for code', active: 'Active', disabled: 'Disabled',
}
const PROVIDER_LABEL: Record<MailProvider, string> = { gmail: 'Gmail', microsoft: 'Microsoft 365' }
/** Gmail's Testing-mode consent screen expires external refresh tokens after 7 days (spec) — this is
 * the "day 5" scheduled-reconnect banner, `credentialAgeDays` being the connection's own `createdAt`. */
const GMAIL_RECONNECT_WARNING_DAYS = 5

/** `provider`/`status` columns are plain `text` (checked at the DB by a SQL CHECK constraint, not a
 * drizzle `pgEnum`), so the tRPC-inferred client type is a bare `string` — this looks a value up
 * against its label map without an unchecked cast, falling back to the raw value for anything the
 * map doesn't recognize rather than showing `undefined`. */
function label<T extends string>(map: Record<T, string>, value: string): string {
  return (map as Record<string, string>)[value] ?? value
}

function relativeTime(date: Date | null): string {
  if (!date) return 'never'
  const minutes = Math.max(0, Math.round((Date.now() - date.getTime()) / 60_000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

export function MailboxesScreen() {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const list = useQuery(trpc.mailboxes.list.queryOptions())
  const [addingTo, setAddingTo] = useState<{ id: string; address: string } | null>(null)
  const [confirmingDisconnect, setConfirmingDisconnect] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = () => queryClient.invalidateQueries({ queryKey: trpc.mailboxes.list.queryKey() })
  const disconnect = useMutation(trpc.mailboxes.disconnect.mutationOptions({ onSuccess: refresh, onError: () => setError('Could not disconnect. Try again.') }))
  const resend = useMutation(trpc.mailboxes.resendVerification.mutationOptions({ onSuccess: refresh, onError: () => setError('Could not resend the code. Try again.') }))
  const consent = useMutation(trpc.mailboxes.consentAddress.mutationOptions({ onSuccess: refresh, onError: () => setError('Could not record your decision. Try again.') }))

  if (!list.data) return <Loading />
  const connections = list.data.connections

  function handleDisconnect(connectionId: string) {
    if (disconnect.isPending) return
    if (confirmingDisconnect === connectionId) {
      disconnect.mutate({ connectionId })
      setConfirmingDisconnect(null)
    } else {
      setConfirmingDisconnect(connectionId)
    }
  }
  function handleResend(agentId: string) {
    if (resend.isPending) return
    resend.mutate({ agentId })
  }
  function handleConsent(agentId: string, approve: boolean) {
    if (consent.isPending) return
    consent.mutate({ agentId, approve })
  }

  return (
    <Screen testID="mailboxes">
      {connections.length === 0 ? (
        <ConnectMailboxCard onConnected={(id, address) => setAddingTo({ id, address })} />
      ) : (
        <>
          <Heading>Mailboxes</Heading>
          {connections.map((conn) => (
          <Card key={conn.id} testID={`connection-${conn.id}`}>
            <ListRow title={conn.emailAddress} subtitle={label(PROVIDER_LABEL, conn.provider)} badge={label(CONNECTION_STATUS_LABEL, conn.status)} />
            <Muted>Last synced {relativeTime(conn.lastSyncAt)}</Muted>
            {conn.consecutiveFailures > 0 ? <Muted testID={`sync-failures-${conn.id}`}>{conn.consecutiveFailures} sync failures in a row</Muted> : null}
            {conn.provider === 'gmail' && conn.credentialAgeDays >= GMAIL_RECONNECT_WARNING_DAYS ? (
              <Banner tone="error" testID={`gmail-reconnect-${conn.id}`}>Reconnect soon — Google test-mode connections expire after 7 days</Banner>
            ) : null}

            {conn.agents.map((agent) => (
              <View key={agent.id} style={styles.agentRow} testID={`agent-${agent.id}`}>
                <ListRow title={agent.address} subtitle={agent.displayName} badge={label(AGENT_STATUS_LABEL, agent.status)} />
                {agent.status === 'pending_verification' && !agent.consentRequiredFromMe ? (
                  <Button variant="secondary" label="Resend code" onPress={() => handleResend(agent.id)} loading={resend.isPending} testID={`resend-${agent.id}`} />
                ) : null}
                {agent.consentRequiredFromMe ? (
                  <Card testID={`consent-${agent.id}`}>
                    <Body>{agent.address} was added by a teammate. Allow the agent to read this mailbox?</Body>
                    <Button label="Approve" onPress={() => handleConsent(agent.id, true)} loading={consent.isPending} testID={`consent-approve-${agent.id}`} />
                    <Button variant="danger" label="Reject" onPress={() => handleConsent(agent.id, false)} loading={consent.isPending} testID={`consent-reject-${agent.id}`} />
                  </Card>
                ) : null}
              </View>
            ))}

            <Button variant="secondary" label="+ Add an address" onPress={() => setAddingTo({ id: conn.id, address: conn.emailAddress })} testID={`add-address-${conn.id}`} />
            <Button
              variant={confirmingDisconnect === conn.id ? 'danger' : 'secondary'}
              label={confirmingDisconnect === conn.id ? 'Confirm disconnect' : 'Disconnect'}
              onPress={() => handleDisconnect(conn.id)} loading={disconnect.isPending} testID={`disconnect-${conn.id}`}
            />
          </Card>
          ))}
        </>
      )}

      {addingTo ? (
        <AddressSheet connectionId={addingTo.id} connectionAddress={addingTo.address} onDone={() => { setAddingTo(null); refresh() }} />
      ) : null}

      {error ? <Banner tone="error">{error}</Banner> : null}
    </Screen>
  )
}

const styles = StyleSheet.create({ agentRow: { gap: spacing.xs } })
