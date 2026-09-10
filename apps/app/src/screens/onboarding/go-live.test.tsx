import { QueryClient, QueryClientProvider, notifyManager } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import type { ReactNode } from 'react'
import { GoLiveStep } from './go-live'

// See inbox.test.tsx: TanStack's default scheduler defers notifications through a real setTimeout(0),
// outside RNTL's act() window. Running it synchronously keeps every update inside the triggering act().
notifyManager.setScheduler((callback) => callback())

interface GoLiveStatus {
  agentEnabled: boolean
  agentAddresses: string[]
  firstDraft: { ticketId: string; draftId: string; subject: string | null; createdAt: Date } | null
  ticketsSeen: number
}

// Every variable a jest.mock() factory closes over must be prefixed `mock` (case-insensitive) —
// babel-plugin-jest-hoist hoists jest.mock() above these declarations, and the factories below only
// read them from inside a nested function, i.e. after this file's own top-level statements have run.
let mockStatus: GoLiveStatus = { agentEnabled: false, agentAddresses: [], firstDraft: null, ticketsSeen: 0 }
let mockStatusOpts: { refetchInterval?: unknown }[] = []
const mockSetEnabledCalls: unknown[] = []
const mockAdvanceCalls: unknown[] = []
let mockSetEnabledImpl: (input: unknown) => Promise<unknown> = () =>
  Promise.resolve({ agentEnabled: true, onboardingStep: 'done', role: 'owner' })

const mockReplace = jest.fn()
const mockPush = jest.fn()

jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: mockReplace, push: mockPush }),
}))

jest.mock('@/lib/trpc', () => ({
  // `useAdvance` (screens/onboarding/mailbox.tsx) pulls the connect card into this module graph;
  // nothing here renders it, so `fetchMeta`/`useTRPCClient` only need to exist.
  fetchMeta: () => Promise.resolve({ providers: { google: false, microsoft: false }, mail: { gmail: false, microsoft: false } }),
  useTRPCClient: () => ({}),
  useTRPC: () => ({
    workspace: {
      goLiveStatus: {
        queryOptions: (_input: undefined, opts: { refetchInterval?: unknown }) => {
          mockStatusOpts.push(opts)
          return { queryKey: ['workspace', 'goLiveStatus'], queryFn: () => Promise.resolve(mockStatus), ...opts }
        },
      },
      get: { queryKey: () => ['workspace', 'get'] },
      setAgentEnabled: {
        mutationOptions: (o: object) => ({ mutationFn: (v: unknown) => { mockSetEnabledCalls.push(v); return mockSetEnabledImpl(v) }, ...o }),
      },
      advanceOnboarding: {
        mutationOptions: (o: object) => ({ mutationFn: (v: unknown) => { mockAdvanceCalls.push(v); return Promise.resolve({ from: 'go_live', to: 'done' }) }, ...o }),
      },
    },
  }),
}))

/** Far beyond the test's lifetime: the poll option is asserted, never actually allowed to fire (no
 * fake timers — React 19's awaited act() deadlocks against them). */
const POLL_MS = 60_000

const teardowns: Array<() => Promise<void> | void> = []
async function setup() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, refetchOnWindowFocus: false, refetchOnReconnect: false }, mutations: { retry: false, gcTime: 0 } },
  })
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  }
  const rendered = await render(<GoLiveStep pollMs={POLL_MS} />, { wrapper: Wrapper })
  teardowns.push(rendered.unmount, () => queryClient.unmount())
  return rendered
}

const lastOpts = () => mockStatusOpts[mockStatusOpts.length - 1]!

beforeEach(() => {
  mockStatus = { agentEnabled: false, agentAddresses: [], firstDraft: null, ticketsSeen: 0 }
  mockStatusOpts = []
  mockSetEnabledCalls.length = 0
  mockAdvanceCalls.length = 0
  mockSetEnabledImpl = () => Promise.resolve({ agentEnabled: true, onboardingStep: 'done', role: 'owner' })
  mockReplace.mockClear()
  mockPush.mockClear()
})
afterEach(async () => { for (const teardown of teardowns.splice(0)) await teardown() })

test('asks the owner to email the first agent address, and keeps polling while no draft has arrived', async () => {
  mockStatus = { ...mockStatus, agentAddresses: ['support@acme.com', 'sales@acme.com'] }
  await setup()
  await waitFor(() =>
    expect(screen.getByText("From any mailbox, email support@acme.com with a question a customer might ask. The agent's first draft appears here.")).toBeTruthy(),
  )
  expect(lastOpts().refetchInterval).toBe(POLL_MS)
})

test('with no agent yet it still renders, saying so', async () => {
  await setup()
  await waitFor(() => expect(screen.getByText(/email \(no agent yet\) with a question/)).toBeTruthy())
})

test('the poll stops for good once the first draft exists', async () => {
  mockStatus = {
    agentEnabled: false, agentAddresses: ['support@acme.com'], ticketsSeen: 1,
    firstDraft: { ticketId: 't1', draftId: 'd1', subject: 'Where is my order?', createdAt: new Date() },
  }
  await setup()
  await waitFor(() => expect(screen.getByText('Your first draft is ready')).toBeTruthy())
  await waitFor(() => expect(lastOpts().refetchInterval).toBe(false))
})

test('Review it opens the ticket', async () => {
  mockStatus = {
    agentEnabled: false, agentAddresses: ['support@acme.com'], ticketsSeen: 1,
    firstDraft: { ticketId: 't1', draftId: 'd1', subject: 'Where is my order?', createdAt: new Date() },
  }
  await setup()
  await waitFor(() => expect(screen.getByTestId('review-first-draft')).toBeTruthy())
  await fireEvent.press(screen.getByTestId('review-first-draft'))
  expect(mockPush).toHaveBeenCalledWith('/ticket/t1')
})

test('flipping the master switch turns the agent on and lands in the inbox', async () => {
  mockStatus = { ...mockStatus, agentAddresses: ['support@acme.com'] }
  await setup()
  await waitFor(() => expect(screen.getByTestId('agent-switch')).toBeTruthy())
  await fireEvent(screen.getByTestId('agent-switch'), 'valueChange', true)
  expect(mockSetEnabledCalls).toEqual([{ enabled: true }])
  await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/inbox'))
})

test('a second flip while the first is still in flight is ignored', async () => {
  // Held open across both flips, then settled before teardown: a mutation still in flight when the
  // suite ends leaves jest with a handle it cannot close.
  let release = () => { /* replaced below */ }
  mockSetEnabledImpl = () => new Promise((resolve) => { release = () => resolve({ agentEnabled: true, onboardingStep: 'done', role: 'owner' }) })
  await setup()
  await waitFor(() => expect(screen.getByTestId('agent-switch')).toBeTruthy())
  await fireEvent(screen.getByTestId('agent-switch'), 'valueChange', true)
  await fireEvent(screen.getByTestId('agent-switch'), 'valueChange', true)
  expect(mockSetEnabledCalls).toHaveLength(1)
  expect(mockReplace).not.toHaveBeenCalled()

  await act(async () => { release() })
  await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/inbox'))
})

test('the switch reflects an agent that is already on', async () => {
  mockStatus = { ...mockStatus, agentEnabled: true, agentAddresses: ['support@acme.com'] }
  await setup()
  await waitFor(() => expect(screen.getByTestId('agent-switch').props.accessibilityState.checked).toBe(true))
})

test('Finish later advances the onboarding step instead', async () => {
  await setup()
  await waitFor(() => expect(screen.getByTestId('finish-later')).toBeTruthy())
  await fireEvent.press(screen.getByTestId('finish-later'))
  await waitFor(() => expect(mockAdvanceCalls).toHaveLength(1))
  expect(mockSetEnabledCalls).toHaveLength(0)
  await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/inbox'))
})

test('a switch that fails says so and leaves the owner on the step', async () => {
  mockSetEnabledImpl = () => Promise.reject(new Error('nope'))
  await setup()
  await waitFor(() => expect(screen.getByTestId('agent-switch')).toBeTruthy())
  await fireEvent(screen.getByTestId('agent-switch'), 'valueChange', true)
  await waitFor(() => expect(screen.getByTestId('agent-enable-error')).toBeTruthy())
  expect(mockReplace).not.toHaveBeenCalled()
})
