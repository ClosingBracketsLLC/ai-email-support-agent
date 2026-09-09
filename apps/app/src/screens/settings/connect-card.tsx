import { useMutation, useQuery } from '@tanstack/react-query'
import * as Clipboard from 'expo-clipboard'
import * as WebBrowser from 'expo-web-browser'
import { useEffect, useRef, useState } from 'react'
import { Platform, StyleSheet, View } from 'react-native'
import type { MailProvider } from '@aesa/contracts'
import { Banner } from '@/components/banner'
import { Button } from '@/components/button'
import { Card } from '@/components/card'
import { TextField } from '@/components/text-field'
import { Body, Heading, Muted } from '@/components/typography'
import { fetchMeta, useTRPC, useTRPCClient } from '@/lib/trpc'
import { spacing } from '@/theme'

const PROVIDER_LABEL: Record<MailProvider, string> = { gmail: 'Gmail', microsoft: 'Microsoft 365' }
/** Plain-words scope copy, one line above each connect button (spec §"Connect a mailbox"). */
const SCOPE_COPY: Record<MailProvider, string> = {
  gmail: 'Read and send — the agent never deletes or organizes your mail.',
  microsoft: 'Microsoft requires write access to send threaded replies; every write is recorded.',
}
const CLAIM_POLL_INTERVAL_MS = 2_000
const CLAIM_POLL_TIMEOUT_MS = 5 * 60 * 1000
const PROVISION_RETRY_MS = 1_000
const PROVISION_MAX_ATTEMPTS = 5

type Phase =
  | { kind: 'idle' }
  | { kind: 'connecting'; provider: MailProvider }
  | { kind: 'waiting_for_admin' }
  | { kind: 'error'; message: string }

/** Resolves early if `signal` aborts, so a cancelled poll doesn't sit out its own 2 s tick before
 * actually stopping. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    if (!signal) return
    if (signal.aborted) { clearTimeout(timer); resolve(); return }
    signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
  })
}
function errorCode(err: unknown): string | undefined {
  return (err as { data?: { code?: string } } | null)?.data?.code
}
function errorMessage(err: unknown): string | undefined {
  return (err as { message?: string } | null)?.message
}

/**
 * Shared by the onboarding mailbox step and the empty-state settings Mailboxes screen (spec: consent
 * happens in the system browser; the app never sees a token — only the connection id once
 * `claimConnection` resolves it as claimed by this same signed-in user).
 */
export function ConnectMailboxCard({
  onConnected,
  heading = 'Connect a mailbox',
  pollIntervalMs = CLAIM_POLL_INTERVAL_MS,
  pollTimeoutMs = CLAIM_POLL_TIMEOUT_MS,
  provisionRetryMs = PROVISION_RETRY_MS,
}: {
  onConnected: (connectionId: string, emailAddress: string) => void
  /** Overridable so the settings Mailboxes screen can say "Connect another mailbox" once at least
   * one connection already exists (review fix, Important 2) — the onboarding step keeps the default. */
  heading?: string
  /** Test-only timing overrides — defaults are the real production values (2 s / 5 min / 1 s). A
   * unit test drives the claim-poll and provisioning-retry state machine with real timers at tiny
   * values instead of `jest.useFakeTimers()`: verified empirically that React 19's `act()` deadlocks
   * against fake timers here — `fireEvent.press`'s awaited `act()` call blocks on the click handler's
   * full async chain (not just its synchronous prefix), and that chain can only progress once a fake
   * timer is advanced, which the test cannot do until `fireEvent.press` itself returns. */
  pollIntervalMs?: number
  pollTimeoutMs?: number
  provisionRetryMs?: number
}) {
  const trpc = useTRPC()
  const trpcClient = useTRPCClient()
  const meta = useQuery({ queryKey: ['meta'], queryFn: fetchMeta, staleTime: Infinity })
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const [gmailFormOpen, setGmailFormOpen] = useState(false)
  const [gmailEmail, setGmailEmail] = useState('')
  const requestAccess = useMutation(trpc.mailboxes.requestGmailAccess.mutationOptions())
  const adminConsent = useQuery({ ...trpc.mailboxes.adminConsentInfo.queryOptions({}), enabled: phase.kind === 'waiting_for_admin' })

  const busy = phase.kind === 'connecting'

  // Review fix, Important 2: the claim-poll loop has no natural end while a flow stays "not ready" —
  // an unmount (navigating away) or a second `connect()` call must stop the PREVIOUS run's timers and
  // stop it from ever calling `setPhase` again on a stale closure. One controller per in-flight
  // connect attempt; every `setPhase` inside `connect`/`pollClaim` goes through `setPhaseSafe`, which
  // is a no-op once its own controller has been aborted.
  const controllerRef = useRef<AbortController | null>(null)
  useEffect(() => () => controllerRef.current?.abort(), [])

  async function connect(provider: MailProvider) {
    if (busy) return
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    const { signal } = controller
    const setPhaseSafe = (next: Phase) => { if (!signal.aborted) setPhase(next) }

    setPhaseSafe({ kind: 'connecting', provider })
    const platform: 'native' | 'web' = Platform.OS === 'web' ? 'web' : 'native'

    // Review fix, Important 1: browsers tie popup permission to the synchronous input-handler call
    // stack. Opening the tab/window AFTER an `await` (the `startConnect` round trip below) lets it be
    // silently blocked — the poll would then run for 5 minutes against a window that never opened. So
    // on web this opens a blank window HERE, before any await, and only points it at the real URL once
    // `startConnect` resolves.
    let webWindow: Window | null = null
    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      webWindow = window.open('', '_blank')
      if (!webWindow) {
        setPhaseSafe({ kind: 'error', message: 'Your browser blocked the popup. Allow popups for this site and try again.' })
        return
      }
    }

    let flow: { url: string; flowId: string } | undefined
    for (let attempt = 0; attempt < PROVISION_MAX_ATTEMPTS; attempt++) {
      if (signal.aborted) { webWindow?.close(); return }
      try {
        flow = await trpcClient.mailboxes.startConnect.mutate({ provider, platform })
        break
      } catch (err) {
        const stillProvisioning = errorCode(err) === 'PRECONDITION_FAILED' && errorMessage(err) === 'provisioning'
        if (stillProvisioning && attempt < PROVISION_MAX_ATTEMPTS - 1) {
          await sleep(provisionRetryMs, signal)
          continue
        }
        webWindow?.close()
        setPhaseSafe({ kind: 'error', message: 'Try again in a moment' })
        return
      }
    }
    if (signal.aborted) { webWindow?.close(); return }
    if (!flow) {
      webWindow?.close()
      setPhaseSafe({ kind: 'error', message: 'Try again in a moment' })
      return
    }

    let closeBrowser = () => { /* no-op until the branch below assigns a real closer */ }
    if (Platform.OS === 'web') {
      if (webWindow) webWindow.location.href = flow.url
      closeBrowser = () => webWindow?.close()
    } else {
      WebBrowser.openAuthSessionAsync(flow.url).catch(() => { /* driven by claim polling below, not this promise */ })
      closeBrowser = () => {
        try { WebBrowser.dismissAuthSession() } catch { /* not supported on this platform (e.g. Android) */ }
      }
    }

    await pollClaim(flow.flowId, closeBrowser, signal, setPhaseSafe)
  }

  async function pollClaim(flowId: string, closeBrowser: () => void, signal: AbortSignal, setPhaseSafe: (next: Phase) => void): Promise<void> {
    const deadline = Date.now() + pollTimeoutMs
    while (Date.now() < deadline) {
      if (signal.aborted) return
      try {
        const result = await trpcClient.mailboxes.claimConnection.mutate({ flowId })
        if (signal.aborted) return
        closeBrowser()
        setPhaseSafe({ kind: 'idle' })
        onConnected(result.connectionId, result.emailAddress)
        return
      } catch (err) {
        if (signal.aborted) return
        const code = errorCode(err)
        const message = errorMessage(err)
        if (code === 'FORBIDDEN') {
          closeBrowser()
          setPhaseSafe({ kind: 'error', message: 'This connection was started by a different signed-in user.' })
          return
        }
        if (code === 'PRECONDITION_FAILED' && message === 'admin_consent_required') {
          closeBrowser()
          setPhaseSafe({ kind: 'waiting_for_admin' })
          return
        }
        // 'connect flow not ready' means the system browser hop hasn't finished yet — keep polling.
        // Anything else (access_denied, oauth_error, keys_missing, already_connected_elsewhere,
        // invalid_email, not_found, not_connectable) is terminal.
        if (!(code === 'PRECONDITION_FAILED' && message === 'connect flow not ready')) {
          closeBrowser()
          setPhaseSafe({ kind: 'error', message: 'Could not connect. Try again.' })
          return
        }
      }
      await sleep(pollIntervalMs, signal)
      if (signal.aborted) return
    }
    closeBrowser()
    setPhaseSafe({ kind: 'error', message: 'Could not connect in time. Try again.' })
  }

  function submitGmailAccess() {
    if (requestAccess.isPending) return
    requestAccess.mutate({ email: gmailEmail.trim() })
  }

  async function copyAdminLink() {
    if (!adminConsent.data) return
    await Clipboard.setStringAsync(adminConsent.data.adminConsentUrl)
  }

  if (phase.kind === 'waiting_for_admin') {
    return (
      <Card testID="waiting-for-admin">
        <Heading>Waiting for your admin</Heading>
        <Body>Your Microsoft admin needs to approve this connection before it can continue. Send them the link below, then try again.</Body>
        {adminConsent.data ? (
          <>
            <Muted selectable testID="admin-consent-url">{adminConsent.data.adminConsentUrl}</Muted>
            <Button variant="secondary" label="Copy link" onPress={copyAdminLink} testID="copy-admin-link" />
          </>
        ) : null}
        <Button variant="secondary" label="Try again" onPress={() => setPhase({ kind: 'idle' })} testID="admin-consent-retry" />
      </Card>
    )
  }

  const noProvidersConfigured = meta.data ? !meta.data.mail.gmail && !meta.data.mail.microsoft : false

  return (
    <Card testID="connect-card">
      <Heading>{heading}</Heading>
      {/* Controller ruling (e2e, providerless deployments): a workspace with no mail provider
          configured at all shows this instead of silently rendering an empty card. */}
      {noProvidersConfigured ? (
        <Muted testID="no-mail-providers">No mailbox providers are configured for this workspace yet. Ask your workspace admin to set one up.</Muted>
      ) : null}
      {meta.data?.mail.gmail ? (
        <View style={styles.provider} testID="provider-gmail">
          <Muted>{SCOPE_COPY.gmail}</Muted>
          <Button
            label={`Connect ${PROVIDER_LABEL.gmail}`} onPress={() => connect('gmail')}
            loading={phase.kind === 'connecting' && phase.provider === 'gmail'} disabled={busy} testID="connect-gmail"
          />
          {gmailFormOpen ? (
            <Card testID="gmail-access-form">
              {requestAccess.isSuccess ? (
                <Muted>Requested. We add test users by hand — expect access within a day.</Muted>
              ) : (
                <>
                  <TextField label="Your Gmail address" value={gmailEmail} onChangeText={setGmailEmail} autoCapitalize="none" keyboardType="email-address" testID="gmail-access-email" />
                  <Button label="Request access" onPress={submitGmailAccess} loading={requestAccess.isPending} disabled={!gmailEmail.trim()} testID="gmail-access-submit" />
                </>
              )}
            </Card>
          ) : (
            <Button variant="secondary" label="Using Gmail? Request early access" onPress={() => setGmailFormOpen(true)} testID="gmail-access-toggle" />
          )}
        </View>
      ) : null}
      {meta.data?.mail.microsoft ? (
        <View style={styles.provider} testID="provider-microsoft">
          <Muted>{SCOPE_COPY.microsoft}</Muted>
          <Button
            label={`Connect ${PROVIDER_LABEL.microsoft}`} onPress={() => connect('microsoft')}
            loading={phase.kind === 'connecting' && phase.provider === 'microsoft'} disabled={busy} testID="connect-microsoft"
          />
        </View>
      ) : null}
      {phase.kind === 'error' ? <Banner tone="error" testID="connect-error">{phase.message}</Banner> : null}
    </Card>
  )
}

const styles = StyleSheet.create({ provider: { gap: spacing.sm } })
