import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import type { AgentStatus } from '@aesa/contracts'
import { Banner } from '@/components/banner'
import { Button } from '@/components/button'
import { Card } from '@/components/card'
import { TextField } from '@/components/text-field'
import { Heading } from '@/components/typography'
import { useTRPC } from '@/lib/trpc'
import { radius, spacing, typeScale, useColors } from '@/theme'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const PENDING_COPY = 'Verification code sent — the agent will confirm it automatically when the code arrives.'

interface AliasRow {
  key: string
  address: string
  checked: boolean
  /** true = replies come from the connection's own address; false = the alias sends as itself. */
  replyFromConnection: boolean
}
type RowResult = { status: AgentStatus; error?: string }

/** The security-relevant step of the connect flow (spec §2 — wording here is normative): the primary
 * address is NEVER pre-checked and NEVER pre-created as an agent. Shared by the onboarding mailbox
 * step and the settings Mailboxes screen — both open this once a connection is claimed. */
export function AddressSheet({ connectionId, connectionAddress, onDone }: {
  connectionId: string
  connectionAddress: string
  onDone: () => void
}) {
  const c = useColors()
  const trpc = useTRPC()
  const addAddress = useMutation(trpc.mailboxes.addAddress.mutationOptions())

  const [primaryChecked, setPrimaryChecked] = useState(false)
  const [aliases, setAliases] = useState<AliasRow[]>([])
  const [addingAlias, setAddingAlias] = useState(false)
  const [newAlias, setNewAlias] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [results, setResults] = useState<Record<string, RowResult> | null>(null)

  const newAliasOk = EMAIL_RE.test(newAlias.trim()) && newAlias.trim().toLowerCase() !== connectionAddress.toLowerCase()

  function addAliasRow() {
    const address = newAlias.trim().toLowerCase()
    if (!newAliasOk || aliases.some((a) => a.address === address)) return
    setAliases((prev) => [...prev, { key: address, address, checked: true, replyFromConnection: false }])
    setNewAlias('')
    setAddingAlias(false)
  }
  function toggleAlias(key: string) {
    setAliases((prev) => prev.map((a) => (a.key === key ? { ...a, checked: !a.checked } : a)))
  }
  function setReplyFrom(key: string, replyFromConnection: boolean) {
    setAliases((prev) => prev.map((a) => (a.key === key ? { ...a, replyFromConnection } : a)))
  }

  async function submit() {
    if (busy) return
    const rows = [
      ...(primaryChecked ? [{ connectionId, address: connectionAddress, replyFromConnection: false }] : []),
      ...aliases.filter((a) => a.checked).map((a) => ({ connectionId, address: a.address, replyFromConnection: a.replyFromConnection })),
    ]
    if (rows.length === 0) { onDone(); return }

    setBusy(true)
    setError(null)
    const next: Record<string, RowResult> = {}
    let anyError = false
    await Promise.all(rows.map(async (row) => {
      try {
        const res = await addAddress.mutateAsync(row)
        next[row.address] = { status: res.status }
      } catch {
        anyError = true
        next[row.address] = { status: 'pending_verification', error: 'Could not add this address.' }
      }
    }))
    setBusy(false)
    setResults(next)
    if (anyError) setError('Some addresses could not be added. You can retry from Mailboxes in Settings.')
  }

  function rowStatusCopy(address: string): string | null {
    const result = results?.[address]
    if (!result) return null
    if (result.error) return result.error
    return result.status === 'pending_verification' ? PENDING_COPY : 'Active.'
  }

  const done = results !== null

  return (
    <Card testID="address-sheet">
      <Heading>Which addresses should the agent answer?</Heading>

      <Pressable
        role="checkbox" accessibilityState={{ checked: primaryChecked, disabled: done }} disabled={done}
        onPress={() => setPrimaryChecked((v) => !v)} style={styles.row} testID="address-primary"
      >
        <View style={[styles.box, { borderColor: c.border, backgroundColor: primaryChecked ? c.primary : c.bg }]} />
        <View style={styles.rowText}>
          <Text style={[typeScale.body, { color: c.text }]}>{connectionAddress}</Text>
          <Text style={[typeScale.caption, { color: c.muted }]}>All mail to this address will be read by the agent and visible to your team.</Text>
          {rowStatusCopy(connectionAddress) ? <Text style={[typeScale.caption, { color: c.muted }]}>{rowStatusCopy(connectionAddress)}</Text> : null}
        </View>
      </Pressable>

      {aliases.map((a) => (
        <View key={a.key} testID={`address-alias-${a.address}`}>
          <Pressable
            role="checkbox" accessibilityState={{ checked: a.checked, disabled: done }} disabled={done}
            onPress={() => toggleAlias(a.key)} style={styles.row} testID={`alias-checkbox-${a.address}`}
          >
            <View style={[styles.box, { borderColor: c.border, backgroundColor: a.checked ? c.primary : c.bg }]} />
            <Text style={[typeScale.body, { color: c.text }]}>{a.address}</Text>
          </Pressable>
          <View style={styles.radios}>
            <Pressable
              role="radio" accessibilityState={{ checked: !a.replyFromConnection, disabled: done }} disabled={done}
              onPress={() => setReplyFrom(a.key, false)} testID={`reply-from-alias-${a.address}`}
              style={[styles.radioBox, { borderColor: !a.replyFromConnection ? c.primary : c.border, backgroundColor: !a.replyFromConnection ? c.primaryTint : c.bg }]}
            >
              <Text style={[typeScale.caption, { color: c.text }]}>Replies come from {a.address}</Text>
            </Pressable>
            <Pressable
              role="radio" accessibilityState={{ checked: a.replyFromConnection, disabled: done }} disabled={done}
              onPress={() => setReplyFrom(a.key, true)} testID={`reply-from-connection-${a.address}`}
              style={[styles.radioBox, { borderColor: a.replyFromConnection ? c.primary : c.border, backgroundColor: a.replyFromConnection ? c.primaryTint : c.bg }]}
            >
              <Text style={[typeScale.caption, { color: c.text }]}>Replies come from {connectionAddress}</Text>
            </Pressable>
          </View>
          {rowStatusCopy(a.address) ? <Text style={[typeScale.caption, { color: c.muted }]}>{rowStatusCopy(a.address)}</Text> : null}
        </View>
      ))}

      {!done ? (
        addingAlias ? (
          <Card testID="add-alias-form">
            <TextField label="Alias email (e.g. support@yourbusiness.com)" value={newAlias} onChangeText={setNewAlias} autoCapitalize="none" keyboardType="email-address" testID="alias-email" />
            <Button label="Add" onPress={addAliasRow} disabled={!newAliasOk} testID="alias-add" />
          </Card>
        ) : (
          <Button variant="secondary" label="+ Add an alias" onPress={() => setAddingAlias(true)} testID="add-alias" />
        )
      ) : null}

      {error ? <Banner tone="error">{error}</Banner> : null}
      <Button label={done ? 'Continue' : 'Done'} onPress={done ? onDone : submit} loading={busy} testID="address-done" />
    </Card>
  )
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm, paddingVertical: spacing.sm },
  box: { width: 22, height: 22, borderWidth: 1, borderRadius: radius.sm, marginTop: 2 },
  rowText: { flex: 1, gap: 2 },
  radios: { gap: spacing.xs, marginLeft: spacing.lg + spacing.sm },
  radioBox: { borderWidth: 1, borderRadius: radius.md, padding: spacing.sm },
})
