import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import type { ReactNode } from 'react'
import { ConnectMailboxCard } from './connect-card'

// jest-expo's default preset runs as iOS, so `connect()` always takes the native branch
// (WebBrowser.openAuthSessionAsync, auto-mocked by jest-expo) — the state machine under test
// (provisioning retry, claim polling, its terminal outcomes) is identical on web; only the
// browser-opening mechanics at the top of `connect()` differ, and those have no dedicated test here
// (review fix Important 1 — the popup-timing fix — is a code-only fix per the coordinator's own
// instructions, which listed no test for it).
//
// Real timers, not `jest.useFakeTimers()`: verified empirically (see connect-card.tsx's
// `pollIntervalMs`/`pollTimeoutMs`/`provisionRetryMs` prop doc) that React 19's `act()` deadlocks
// against fake timers here — `await fireEvent.press(...)` blocks on the click handler's FULL async
// chain, not just its synchronous prefix, and that chain can only progress once a fake timer is
// advanced, which the test cannot do until `fireEvent.press` itself returns. `ConnectMailboxCard`
// instead accepts test-only millisecond overrides (defaults are the real 2 s / 5 min / 1 s), so this
// file drives the exact same state machine with real timers at a scale of milliseconds.

const mockMeta = { providers: { google: false, microsoft: false }, mail: { gmail: true, microsoft: true } }
const mockStartConnect = jest.fn()
const mockClaimConnection = jest.fn()
const mockAdminConsentUrl = 'https://login.microsoftonline.com/common/adminconsent?client_id=test'

jest.mock('@/lib/trpc', () => ({
  fetchMeta: () => Promise.resolve(mockMeta),
  useTRPC: () => ({
    mailboxes: {
      requestGmailAccess: { mutationOptions: (o: object) => ({ mutationFn: () => Promise.resolve({ requested: true }), ...o }) },
      adminConsentInfo: {
        queryOptions: () => ({ queryKey: ['mailboxes', 'adminConsentInfo'], queryFn: () => Promise.resolve({ adminConsentUrl: mockAdminConsentUrl }) }),
      },
    },
  }),
  useTRPCClient: () => ({
    mailboxes: {
      startConnect: { mutate: (...args: unknown[]) => mockStartConnect(...args) },
      claimConnection: { mutate: (...args: unknown[]) => mockClaimConnection(...args) },
    },
  }),
}))

const POLL_INTERVAL_MS = 5
const POLL_TIMEOUT_MS = 40
const PROVISION_RETRY_MS = 5

const teardowns: Array<() => Promise<void> | void> = []

async function setup(onConnected: (id: string, address: string) => void = jest.fn()) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, refetchOnWindowFocus: false, refetchOnReconnect: false }, mutations: { retry: false, gcTime: 0 } },
  })
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  }
  const rendered = await render(
    <ConnectMailboxCard onConnected={onConnected} pollIntervalMs={POLL_INTERVAL_MS} pollTimeoutMs={POLL_TIMEOUT_MS} provisionRetryMs={PROVISION_RETRY_MS} />,
    { wrapper: Wrapper },
  )
  teardowns.push(rendered.unmount, () => queryClient.unmount())
  // Both provider buttons render together off the same `/meta` resolution — wait for that, not just
  // the always-present card shell, before any test presses a button.
  await waitFor(() => expect(screen.getByTestId('connect-gmail')).toBeTruthy())
  await waitFor(() => expect(screen.getByTestId('connect-microsoft')).toBeTruthy())
  return rendered
}

beforeEach(() => {
  mockStartConnect.mockReset()
  mockClaimConnection.mockReset()
  mockStartConnect.mockResolvedValue({ url: 'https://accounts.example/auth', flowId: 'flow-1' })
})
afterEach(async () => { for (const teardown of teardowns.splice(0)) await teardown() })

test('a claim rejected as FORBIDDEN stops polling immediately and shows the error state', async () => {
  mockClaimConnection.mockRejectedValue({ data: { code: 'FORBIDDEN' }, message: 'this connection was started by a different user' })
  await setup()

  await act(async () => { await fireEvent.press(screen.getByTestId('connect-gmail')) })
  await waitFor(() => expect(screen.getByTestId('connect-error')).toBeTruthy())
  expect(screen.getByText('This connection was started by a different signed-in user.')).toBeTruthy()

  // Confirms polling actually stopped, not just that the FIRST rejection happened to render an error:
  // wait well past several poll intervals and check the call count never grew again.
  const callsAtError = mockClaimConnection.mock.calls.length
  await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS * 6))
  expect(mockClaimConnection.mock.calls.length).toBe(callsAtError)
})

test('a transient "connect flow not ready" keeps polling, then succeeds once the flow is claimed', async () => {
  mockClaimConnection
    .mockRejectedValueOnce({ data: { code: 'PRECONDITION_FAILED' }, message: 'connect flow not ready' })
    .mockRejectedValueOnce({ data: { code: 'PRECONDITION_FAILED' }, message: 'connect flow not ready' })
    .mockResolvedValueOnce({ connectionId: 'conn-9', emailAddress: 'support@acme.com' })
  const onConnected = jest.fn()
  await setup(onConnected)

  await act(async () => { await fireEvent.press(screen.getByTestId('connect-gmail')) })
  await waitFor(() => expect(onConnected).toHaveBeenCalledWith('conn-9', 'support@acme.com'))
  expect(mockClaimConnection).toHaveBeenCalledTimes(3)
  expect(screen.queryByTestId('connect-error')).toBeNull()
})

test('admin_consent_required lands the "Waiting for your admin" card with the copy-link action', async () => {
  mockClaimConnection.mockRejectedValue({ data: { code: 'PRECONDITION_FAILED' }, message: 'admin_consent_required' })
  await setup()

  await act(async () => { await fireEvent.press(screen.getByTestId('connect-microsoft')) })
  await waitFor(() => expect(screen.getByTestId('waiting-for-admin')).toBeTruthy())
  await waitFor(() => expect(screen.getByTestId('admin-consent-url')).toBeTruthy())
  expect(screen.getByText(mockAdminConsentUrl)).toBeTruthy()
  expect(screen.getByTestId('copy-admin-link')).toBeTruthy()
})

test('polling gives up at the timeout cap and shows the timeout error', async () => {
  mockClaimConnection.mockRejectedValue({ data: { code: 'PRECONDITION_FAILED' }, message: 'connect flow not ready' })
  await setup()

  await act(async () => { await fireEvent.press(screen.getByTestId('connect-gmail')) })
  await waitFor(() => expect(screen.getByTestId('connect-error')).toBeTruthy(), { timeout: 5_000 })
  expect(screen.getByText('Could not connect in time. Try again.')).toBeTruthy()
})
