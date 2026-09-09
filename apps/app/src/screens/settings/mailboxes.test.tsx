import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import type { ReactNode } from 'react'
import { MailboxesScreen } from './mailboxes'

type Connection = {
  id: string; provider: 'gmail' | 'microsoft'; emailAddress: string
  status: 'pending_claim' | 'connected' | 'reauth_required' | 'disabled'
  lastSyncAt: Date | null; lastSuccessAt: Date | null; consecutiveFailures: number
  pushExpiresAt: Date | null; connectedByUserId: string; connectedByMe: boolean; credentialAgeDays: number
  agents: { id: string; address: string; status: 'pending_verification' | 'active' | 'disabled'; priority: number; displayName: string; consentRequiredFromMe: boolean }[]
}

// Every variable the jest.mock() factory below closes over must be prefixed `mock` (case-insensitive)
// — babel-plugin-jest-hoist only exempts those from its "no out-of-scope reference" check, since
// jest.mock() itself is hoisted above these declarations.
let mockConnections: Connection[] = []
const mockResendCalls: unknown[] = []
const mockDisconnectCalls: unknown[] = []
const mockConsentCalls: unknown[] = []

jest.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    mailboxes: {
      list: {
        queryOptions: () => ({ queryKey: ['mailboxes', 'list'], queryFn: () => Promise.resolve({ connections: mockConnections }) }),
        queryKey: () => ['mailboxes', 'list'],
      },
      resendVerification: { mutationOptions: (o: object) => ({ mutationFn: (v: unknown) => { mockResendCalls.push(v); return Promise.resolve({ ok: true }) }, ...o }) },
      disconnect: { mutationOptions: (o: object) => ({ mutationFn: (v: unknown) => { mockDisconnectCalls.push(v); return Promise.resolve({ ok: true }) }, ...o }) },
      consentAddress: { mutationOptions: (o: object) => ({ mutationFn: (v: unknown) => { mockConsentCalls.push(v); return Promise.resolve({ agentId: 'a1', deleted: false, status: 'active' }) }, ...o }) },
    },
  }),
}))

function baseConnection(overrides: Partial<Connection> = {}): Connection {
  return {
    id: 'conn1', provider: 'gmail', emailAddress: 'support@acme.com', status: 'connected',
    lastSyncAt: new Date(Date.now() - 5 * 60_000), lastSuccessAt: null, consecutiveFailures: 0,
    pushExpiresAt: null, connectedByUserId: 'u1', connectedByMe: true, credentialAgeDays: 0,
    agents: [],
    ...overrides,
  }
}

const teardowns: Array<() => Promise<void> | void> = []
async function setup() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, refetchOnWindowFocus: false, refetchOnReconnect: false }, mutations: { retry: false, gcTime: 0 } },
  })
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  }
  const rendered = await render(<MailboxesScreen />, { wrapper: Wrapper })
  teardowns.push(rendered.unmount, () => queryClient.unmount())
  return rendered
}

beforeEach(() => {
  mockConnections = []
  mockResendCalls.length = 0
  mockDisconnectCalls.length = 0
  mockConsentCalls.length = 0
})
afterEach(async () => { for (const teardown of teardowns.splice(0)) await teardown() })

test('a pending agent shows a "waiting for code" chip and a working resend action', async () => {
  mockConnections = [baseConnection({
    agents: [{ id: 'agent1', address: 'support@acme.com', status: 'pending_verification', priority: 0, displayName: 'support', consentRequiredFromMe: false }],
  })]
  await setup()

  await waitFor(() => expect(screen.getByTestId('agent-agent1')).toBeTruthy())
  expect(screen.getByText('waiting for code')).toBeTruthy()

  await fireEvent.press(screen.getByTestId('resend-agent1'))
  await waitFor(() => expect(mockResendCalls).toEqual([{ agentId: 'agent1' }]))
  await act(async () => { await Promise.resolve() }) // flush the onSuccess refetch inside act
})

test('a consent-gated agent shows the approve/reject card instead of a resend action', async () => {
  mockConnections = [baseConnection({
    agents: [{ id: 'agent2', address: 'sales@acme.com', status: 'pending_verification', priority: 1, displayName: 'sales', consentRequiredFromMe: true }],
  })]
  await setup()

  await waitFor(() => expect(screen.getByTestId('consent-agent2')).toBeTruthy())
  expect(screen.queryByTestId('resend-agent2')).toBeNull()

  await fireEvent.press(screen.getByTestId('consent-approve-agent2'))
  await waitFor(() => expect(mockConsentCalls).toEqual([{ agentId: 'agent2', approve: true }]))
  await act(async () => { await Promise.resolve() }) // flush the onSuccess refetch inside act
})

test('the gmail day-5 reconnect banner appears at credentialAgeDays 5 (Google Testing-mode 7-day expiry), not before', async () => {
  mockConnections = [baseConnection({ id: 'conn-young', credentialAgeDays: 4 })]
  await setup()
  await waitFor(() => expect(screen.getByTestId('connection-conn-young')).toBeTruthy())
  expect(screen.queryByText('Reconnect soon — Google test-mode connections expire after 7 days')).toBeNull()
})

test('the gmail day-5 reconnect banner shows the exact spec copy once credentialAgeDays reaches 5', async () => {
  mockConnections = [baseConnection({ credentialAgeDays: 5 })]
  await setup()
  await waitFor(() => expect(screen.getByTestId('gmail-reconnect-conn1')).toBeTruthy())
  expect(screen.getByText('Reconnect soon — Google test-mode connections expire after 7 days')).toBeTruthy()
})

test('microsoft connections never show the gmail reconnect banner, regardless of age', async () => {
  mockConnections = [baseConnection({ provider: 'microsoft', credentialAgeDays: 30 })]
  await setup()
  await waitFor(() => expect(screen.getByTestId('connection-conn1')).toBeTruthy())
  expect(screen.queryByText('Reconnect soon — Google test-mode connections expire after 7 days')).toBeNull()
})

test('disconnect needs a second tap to confirm', async () => {
  mockConnections = [baseConnection()]
  await setup()
  await waitFor(() => expect(screen.getByTestId('disconnect-conn1')).toBeTruthy())

  await fireEvent.press(screen.getByTestId('disconnect-conn1'))
  expect(mockDisconnectCalls).toHaveLength(0)
  expect(screen.getByText('Confirm disconnect')).toBeTruthy()

  await fireEvent.press(screen.getByTestId('disconnect-conn1'))
  await waitFor(() => expect(mockDisconnectCalls).toEqual([{ connectionId: 'conn1' }]))
  // `onSuccess: refresh` (invalidateQueries) triggers a second, unobserved re-render of the same data —
  // flush it inside `act` so it doesn't leak into the next test's console output.
  await act(async () => { await Promise.resolve() })
})

// The empty-state ("no connections yet") path renders <ConnectMailboxCard>, which reads /meta via a
// real fetch and the vanilla tRPC client (useTRPCClient) — deliberately not exercised here to keep
// this suite free of network calls; that component has no test file of its own per the brief.
